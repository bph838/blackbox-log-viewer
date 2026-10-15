// State and actions for Imagine's AI Filters panel: conversations (stored locally per craft),
// sending messages to Claude through the Tuning Log's shared streamClaude(), suggestion cards,
// applying configs to the Filters panel and feeding Imagine's results back.

import { defineStore } from "pinia";
import { computed, ref, shallowRef } from "vue";
import { useSettingsStore } from "../../stores/settings.js";
import { resolveAiModel } from "../../user_settings_data.js";
import { streamClaude } from "../../tuning_ai.js";
import { useImagineStore } from "../imagine_store.js";
import { createConversationDb } from "./conversation_db.js";
import {
  addUserConfig,
  appendUserMessage,
  createConversation,
  handleAssistantResponse,
  MAX_TOOL_ROUNDS,
} from "./conversation.js";
import { buildLogSummary, buildResultSummary } from "./filter_summary.js";
import { changesToCli, diffSettings, FILTER_TOOL } from "./filter_tool.js";
import { AI_FILTERS_SYSTEM_PROMPT } from "./system_prompt.js";

let db = createConversationDb();
/** Tests swap in a memory-backed db. */
export function setConversationDb(newDb) {
  db = newDb;
}

const PANEL_KEY = "imagine.aiPanel";

function readPanelPref() {
  try {
    return JSON.parse(globalThis.localStorage?.getItem(PANEL_KEY) ?? "null") || {};
  } catch {
    return {};
  }
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

export const useAiFiltersStore = defineStore("imagineAiFilters", () => {
  const imagine = useImagineStore();
  const settingsStore = useSettingsStore();

  const pref = readPanelPref();
  const open = ref(!!pref.open);
  const width = ref(pref.width || 400);

  const conversations = ref([]); // summaries for the current craft
  const current = ref(null); // the open conversation record
  const busy = ref(false);
  const status = ref(null); // { phase, requestBytes, startedAt }
  const streamingText = ref("");
  const error = ref("");
  const activeConfigId = ref(null); // config currently loaded in the Filters panel
  const applyingConfigId = ref(null);
  let cancelRequest = null;
  // What send() changed on the record besides the message, undone if the first request fails
  let rollback = null;
  const lastRequest = shallowRef(null); // the context sent with the last message, for "data sent"

  const apiKey = computed(() => settingsStore.userSettings.aiApiKey || "");
  const hasApiKey = computed(() => !!apiKey.value);
  const model = computed({
    get: () => resolveAiModel(settingsStore.userSettings.aiModel),
    set: (v) => settingsStore.saveSetting("aiModel", v),
  });
  const craftName = computed(() => imagine.sysConfig?.["Craft name"] || "");

  function savePanelPref() {
    try {
      globalThis.localStorage?.setItem(PANEL_KEY, JSON.stringify({ open: open.value, width: width.value }));
    } catch {
      // not remembered
    }
  }
  function setOpen(v) {
    open.value = v;
    savePanelPref();
  }
  function setWidth(px) {
    width.value = Math.min(560, Math.max(320, Math.round(px)));
    savePanelPref();
  }

  function persist() {
    if (!current.value) return Promise.resolve();
    return db
      .put(current.value)
      .then(refreshList)
      .catch((e) => console.error("Could not save the AI Filters conversation", e));
  }

  async function refreshList() {
    conversations.value = await db.list(craftName.value);
  }

  async function loadForCraft() {
    await refreshList();
    if (current.value && current.value.craftName.toLowerCase() !== craftName.value.toLowerCase()) {
      current.value = null;
    }
    if (!current.value && conversations.value.length) {
      await openConversation(conversations.value[0].id);
    }
  }

  function newConversation() {
    cancel();
    current.value = createConversation({ craftName: craftName.value, model: model.value });
    activeConfigId.value = null;
    error.value = "";
    return current.value;
  }

  async function openConversation(id) {
    cancel();
    const record = await db.get(id);
    if (record) {
      current.value = record;
      activeConfigId.value = null;
      error.value = "";
    }
  }

  async function renameConversation(title) {
    if (!current.value) return;
    current.value.title = String(title || "").trim() || current.value.title;
    await persist();
  }

  async function deleteConversation(id) {
    await db.delete(id);
    if (current.value?.id === id) current.value = null;
    await refreshList();
  }

  // ---- what goes to Claude ----

  function logRef() {
    return {
      fileName: imagine.fileName,
      logIndex: imagine.logIndex,
      start: imagine.range.start,
      end: imagine.range.end,
    };
  }

  function summaryContext() {
    return {
      craftName: craftName.value,
      fileName: imagine.fileName,
      firmware: imagine.firmware,
      rates: imagine.rates,
      data: imagine.data,
      range: imagine.range,
      rotor: imagine.rotor,
      speeds: imagine.rotorSpeeds,
      headStats: headStats(),
      settings: imagine.settings,
      craftFileName: imagine.craftFileName,
      validation: imagine.validation,
    };
  }

  function headStats() {
    const d = imagine.data;
    if (!d?.hasHeadspeed) return null;
    const v = [];
    for (let i = imagine.range.start; i < imagine.range.end; i += 5) if (d.headspeed[i] > 100) v.push(d.headspeed[i]);
    if (!v.length) return null;
    v.sort((a, b) => a - b);
    return { p10: v[Math.floor(v.length * 0.1)], p90: v[Math.floor(v.length * 0.9)] };
  }

  /** The app context that the next message will carry (summary / settings change / results). */
  function nextContext() {
    const record = current.value;
    const context = {};
    const ref_ = logRef();
    const sameLog = record?.logRef && JSON.stringify(record.logRef) === JSON.stringify(ref_);
    if (!sameLog) {
      context.summary = { text: buildLogSummary(summaryContext()), attrs: { file: imagine.fileName } };
    } else if (record.sentSettings) {
      const changes = diffSettings(record.sentSettings, imagine.settings);
      if (changes.length) {
        context.settingsText = `The Filters panel now differs from what you last saw:\n${changesToCli(changes)}`;
      }
    }
    context.results = (record?.configs || [])
      .filter((c) => c.result && !c.result.sent)
      .map((c) => ({ name: c.name, text: c.result.text, id: c.id }));
    return context;
  }

  function send(text) {
    error.value = "";
    if (!hasApiKey.value) {
      error.value = "Add your Anthropic API key first (see above).";
      return;
    }
    if (!imagine.hasLog || busy.value) return;
    if (!current.value) newConversation();
    const record = current.value;
    const context = nextContext();
    lastRequest.value = context;
    rollback = {
      logRef: record.logRef,
      sentSettings: record.sentSettings,
      title: record.title,
      sentResultIds: (context.results || []).map((r) => r.id),
    };
    appendUserMessage(record, text, context);
    for (const r of context.results || []) {
      const config = record.configs.find((c) => c.id === r.id);
      if (config) config.result.sent = true;
    }
    if (context.summary) record.logRef = logRef();
    record.sentSettings = clone(imagine.settings);
    record.model = model.value;
    persist();
    request(0);
  }

  function request(round) {
    const record = current.value;
    busy.value = true;
    streamingText.value = "";
    status.value = { phase: "sending", requestBytes: 0, startedAt: Date.now() };
    cancelRequest = streamClaude(
      {
        apiKey: apiKey.value,
        model: model.value,
        effort: settingsStore.userSettings.aiEffort,
        onChunk: (t) => {
          streamingText.value = t;
        },
        onStatus: (s) => {
          status.value = { ...s, startedAt: status.value?.startedAt ?? Date.now() };
        },
      },
      { system: [{ type: "text", text: AI_FILTERS_SYSTEM_PROMPT }], tools: [FILTER_TOOL] },
      clone(record.messages),
      {
        onFinal(response, costUsd, usage) {
          cancelRequest = null;
          rollback = null;
          if (current.value !== record) return;
          const { followUp } = handleAssistantResponse(record, response, {
            baseSettings: record.sentSettings || imagine.settings,
            rotor: imagine.rotor,
            costUsd,
            usage,
          });
          if (response.stop_reason === "refusal") {
            error.value = "Claude declined to answer this request.";
          }
          persist();
          if (followUp && round + 1 < MAX_TOOL_ROUNDS) {
            request(round + 1);
          } else {
            done();
          }
        },
        onError(message) {
          cancelRequest = null;
          error.value = message;
          undoUnansweredMessage(record);
          persist();
          done();
        },
      },
    );
  }

  function done() {
    busy.value = false;
    status.value = null;
    streamingText.value = "";
  }

  function cancel() {
    if (cancelRequest) {
      cancelRequest();
      cancelRequest = null;
      if (current.value) {
        undoUnansweredMessage(current.value);
        persist();
      }
    }
    done();
  }

  /**
   * Removes a user message Claude never answered, so the history stays valid and nothing is sent
   * twice. Tool results it carried become pending again; if it was the user's own message, the
   * context it marked as sent (log summary, results, settings) is marked unsent again.
   */
  function undoUnansweredMessage(record) {
    if (!record.messages.length || record.messages.at(-1).role !== "user") return;
    const removed = record.messages.pop();
    record.pendingToolResults = (removed.content || []).filter((b) => b.type === "tool_result");
    if (rollback) {
      record.logRef = rollback.logRef;
      record.sentSettings = rollback.sentSettings;
      record.title = rollback.title;
      for (const id of rollback.sentResultIds) {
        const config = record.configs.find((c) => c.id === id);
        if (config?.result) config.result.sent = false;
      }
      rollback = null;
    }
  }

  // ---- configs ----

  function findConfig(id) {
    return current.value?.configs.find((c) => c.id === id) || null;
  }

  /** Loads a config into the Filters panel, runs Imagine and keeps the result for Claude. */
  async function applyConfig(id) {
    const config = findConfig(id);
    if (!config?.settings || !imagine.hasLog) return;
    applyingConfigId.value = id;
    try {
      imagine.applySettings(config.settings);
      activeConfigId.value = id;
      await imagine.imagine();
      if (imagine.imagined) {
        config.result = {
          text: buildResultSummary({
            name: config.name,
            data: imagine.data,
            range: imagine.range,
            rates: imagine.rates,
            imagined: imagine.imagined,
            delays: imagine.delays,
            rotor: imagine.rotor,
            speeds: imagine.rotorSpeeds,
          }),
          at: new Date().toISOString(),
          sent: false,
        };
        await persist();
      }
    } finally {
      applyingConfigId.value = null;
    }
  }

  function sendResult(id) {
    const config = findConfig(id);
    if (!config?.result) return;
    send(`I applied "${config.name}" - here's what Imagine shows.`);
  }

  async function saveCurrentAsConfig(name) {
    if (!imagine.hasLog) return null;
    if (!current.value) newConversation();
    const config = addUserConfig(current.value, name, imagine.settings, imagine.logSettings);
    activeConfigId.value = config.id;
    await persist();
    return config;
  }

  async function deleteConfig(id) {
    const record = current.value;
    if (!record) return;
    const config = findConfig(id);
    // Claude's suggestions are part of the conversation history, so only the user's own configs go
    if (!config || config.source !== "user") return;
    record.configs = record.configs.filter((c) => c.id !== id);
    if (activeConfigId.value === id) activeConfigId.value = null;
    await persist();
  }

  /** `set ...` lines for a config: only what differs from the log's own settings. */
  function configCli(id) {
    const config = findConfig(id);
    if (!config?.settings || !imagine.logSettings) return "";
    const changes = diffSettings(imagine.logSettings, config.settings);
    return changes.length ? changesToCli(changes) : "# Same as the log's settings";
  }

  return {
    open,
    width,
    conversations,
    current,
    busy,
    status,
    streamingText,
    error,
    activeConfigId,
    applyingConfigId,
    lastRequest,
    hasApiKey,
    model,
    craftName,
    setOpen,
    setWidth,
    loadForCraft,
    refreshList,
    newConversation,
    openConversation,
    renameConversation,
    deleteConversation,
    nextContext,
    send,
    cancel,
    applyConfig,
    sendResult,
    saveCurrentAsConfig,
    deleteConfig,
    configCli,
    findConfig,
  };
});
