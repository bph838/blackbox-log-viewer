// AI Filters conversation model. A conversation is a JSON record kept in IndexedDB:
//
//   { formatVersion, id, title, craftName, createdAt, updatedAt, model,
//     messages,            the Messages API history, append-only (thinking and tool_use blocks are
//                          kept exactly as returned - the model needs them back unchanged)
//     pendingToolResults,  tool_result blocks owed for the last suggestion(s), sent at the start
//                          of the next user message
//     sentSettings,        the Filters panel settings Claude last saw (suggestions are relative to it)
//     logRef,              which log/range the last <log_summary> described
//     configs,             saved filter configs (Claude's suggestions and the user's own)
//     costUsd, usage }
//
// App-provided context goes into user messages as text blocks wrapped in tags (<log_summary>,
// <imagine_result>, <current_settings>), so the history stays plain Messages API content and the
// UI can still show them as compact chips.

import { FILTER_TOOL_NAME, toolResultText, validateProposal, diffSettings } from "./filter_tool.js";

export const MAX_TOOL_ROUNDS = 3;

function newId(prefix) {
  return `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

export function createConversation({ craftName, model, title }) {
  const now = new Date().toISOString();
  return {
    formatVersion: 1,
    id: newId("c"),
    title: title || "New conversation",
    craftName: craftName || "",
    createdAt: now,
    updatedAt: now,
    model: model || null,
    messages: [],
    pendingToolResults: [],
    sentSettings: null,
    logRef: null,
    configs: [],
    costUsd: 0,
    usage: null,
  };
}

const TAGS = {
  summary: "log_summary",
  result: "imagine_result",
  settings: "current_settings",
};

function tagged(tag, attrs, body) {
  const a = Object.entries(attrs || {})
    .map(([k, v]) => ` ${k}="${String(v).replace(/"/g, "'")}"`)
    .join("");
  return { type: "text", text: `<${tag}${a}>\n${body}\n</${tag}>` };
}

export const summaryBlock = (text, attrs) => tagged(TAGS.summary, attrs, text);
export const resultBlock = (configName, text) => tagged(TAGS.result, { config: configName }, text);
export const settingsBlock = (text) => tagged(TAGS.settings, null, text);

/** What a user-message text block is, for display. */
export function classifyBlock(block) {
  if (block.type === "tool_result") return { kind: "tool_result" };
  if (block.type !== "text") return { kind: "other" };
  const m = /^<(log_summary|imagine_result|current_settings)([^>]*)>\n([\s\S]*)\n<\/\1>$/.exec(block.text);
  if (!m) return { kind: "text", text: block.text };
  const attrs = {};
  for (const a of m[2].matchAll(/(\w+)="([^"]*)"/g)) attrs[a[1]] = a[2];
  const kind = { log_summary: "summary", imagine_result: "result", current_settings: "settings" }[m[1]];
  return { kind, attrs, text: m[3] };
}

function addUsage(total, usage) {
  if (!usage) return total;
  const t = total || { requests: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  return {
    requests: t.requests + (usage.requests || 0),
    inputTokens: t.inputTokens + (usage.inputTokens || 0),
    outputTokens: t.outputTokens + (usage.outputTokens || 0),
    cacheReadTokens: t.cacheReadTokens + (usage.cacheReadTokens || 0),
    cacheWriteTokens: t.cacheWriteTokens + (usage.cacheWriteTokens || 0),
  };
}

/**
 * Appends the user's next message: owed tool results first (the API requires them at the start
 * of the turn), then app context, then what the user typed.
 * context: { summary?: {text, attrs}, settingsText?, results?: [{name, text}] }
 */
export function appendUserMessage(record, text, context = {}) {
  const content = [...(record.pendingToolResults || [])];
  record.pendingToolResults = [];
  if (context.summary) content.push(summaryBlock(context.summary.text, context.summary.attrs));
  if (context.settingsText) content.push(settingsBlock(context.settingsText));
  for (const r of context.results || []) content.push(resultBlock(r.name, r.text));
  const typed = String(text || "").trim();
  content.push({ type: "text", text: typed || "(No message - see the data above.)" });
  record.messages.push({ role: "user", content });
  record.updatedAt = new Date().toISOString();
  if (record.title === "New conversation" && typed) {
    record.title = typed.length > 60 ? `${typed.slice(0, 57)}…` : typed;
  }
  return content;
}

/**
 * Records Claude's reply and turns its suggestions into saved configs.
 * Returns { followUp } - true when a suggestion was rejected (or cut off), in which case the
 * tool results have been appended as a user message and the request should be sent again so
 * Claude can correct it. Otherwise the tool results are kept as pending for the next message.
 */
export function handleAssistantResponse(record, response, { baseSettings, rotor, costUsd, usage }) {
  // An empty assistant turn (e.g. a refusal before any output) would make the next request invalid
  const content = response.content && response.content.length ? response.content : [{ type: "text", text: "(No response.)" }];
  record.messages.push({ role: "assistant", content });
  record.costUsd = (record.costUsd || 0) + (costUsd || 0);
  record.usage = addUsage(record.usage, usage);
  record.updatedAt = new Date().toISOString();

  const toolResults = [];
  let rejected = false;
  const truncated = response.stop_reason === "max_tokens";
  for (const block of response.content || []) {
    if (block.type !== "tool_use") continue;
    if (block.name !== FILTER_TOOL_NAME || truncated) {
      rejected = true;
      toolResults.push({
        type: "tool_result",
        tool_use_id: block.id,
        is_error: true,
        content: truncated
          ? "The proposal was cut off by the response length limit. Propose it again, more briefly."
          : `Unknown tool ${block.name}.`,
      });
      continue;
    }
    const validation = validateProposal(block.input, baseSettings, rotor);
    record.configs.push({
      id: newId("f"),
      toolUseId: block.id,
      source: "ai",
      name: String(block.input?.name || "Suggestion"),
      summary: String(block.input?.summary || ""),
      createdAt: new Date().toISOString(),
      changes: validation.changes,
      warnings: validation.warnings,
      errors: validation.errors,
      settings: validation.settings,
      result: null,
    });
    if (!validation.ok) rejected = true;
    toolResults.push({
      type: "tool_result",
      tool_use_id: block.id,
      ...(validation.ok ? {} : { is_error: true }),
      content: toolResultText(validation),
    });
  }

  if (rejected && toolResults.length) {
    record.messages.push({ role: "user", content: toolResults });
    return { followUp: true };
  }
  record.pendingToolResults = toolResults;
  return { followUp: false };
}

/** Saves a settings snapshot as a named config of the user's own. */
export function addUserConfig(record, name, settings, baseSettings) {
  const config = {
    id: newId("f"),
    toolUseId: null,
    source: "user",
    name: String(name || "My config").trim() || "My config",
    summary: "",
    createdAt: new Date().toISOString(),
    changes: baseSettings ? diffSettings(baseSettings, settings) : [],
    warnings: [],
    errors: [],
    settings: JSON.parse(JSON.stringify(settings)),
    result: null,
  };
  record.configs.push(config);
  record.updatedAt = config.createdAt;
  return config;
}

/**
 * Conversation turns for display: user text with context chips, assistant text with suggestion
 * cards (by tool_use id). Thinking and tool_result blocks are not shown.
 */
export function displayTurns(record) {
  const configByTool = new Map((record.configs || []).filter((c) => c.toolUseId).map((c) => [c.toolUseId, c]));
  const turns = [];
  for (const message of record.messages || []) {
    const blocks = typeof message.content === "string" ? [{ type: "text", text: message.content }] : message.content || [];
    if (message.role === "user") {
      const chips = [];
      let text = "";
      for (const b of blocks) {
        const c = classifyBlock(b);
        if (c.kind === "text") text += (text ? "\n" : "") + c.text;
        else if (c.kind === "summary" || c.kind === "result" || c.kind === "settings") chips.push(c);
      }
      if (!text && !chips.length) continue; // tool results only
      turns.push({ role: "user", text: text === "(No message - see the data above.)" ? "" : text, chips });
    } else {
      const parts = [];
      for (const b of blocks) {
        if (b.type === "text" && b.text.trim()) parts.push({ kind: "text", text: b.text });
        else if (b.type === "tool_use") {
          const config = configByTool.get(b.id);
          if (config) parts.push({ kind: "config", configId: config.id });
        }
      }
      if (parts.length) turns.push({ role: "assistant", parts });
    }
  }
  return turns;
}
