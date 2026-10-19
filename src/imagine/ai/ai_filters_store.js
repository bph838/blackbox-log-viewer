// State and actions for Imagine's AI Filters panel: conversations (stored locally per craft),
// sending messages to Claude through the Tuning Log's shared streamClaude(), suggestion cards,
// applying configs to the Filters panel and feeding Imagine's results back.

import { defineStore } from "pinia";
import { computed, ref, shallowRef, watch } from "vue";
import { createGitHubClient } from "../../github_client.js";
import { useSettingsStore } from "../../stores/settings.js";
import { resolveAiModel } from "../../user_settings_data.js";
import { streamClaude } from "../../tuning_ai.js";
import { useImagineStore } from "../imagine_store.js";
import { createConversationDb } from "./conversation_db.js";
import { isDirty, syncConversations } from "./conversation_cloud.js";
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

// Wait after the last change before syncing to GitHub (so a burst of edits is one commit), and
// before retrying after a failure - the same as the Tuning Log.
let syncDelayMs = 3000;
let retryDelayMs = 60000;
let clientFactory = createGitHubClient;

/** For tests: the GitHub client factory and sync delays (null = only syncNow() syncs). */
export function setAiFiltersCloudForTests(options) {
  if (options.clientFactory) clientFactory = options.clientFactory;
  if ("syncDelayMs" in options) syncDelayMs = options.syncDelayMs;
  if ("retryDelayMs" in options) retryDelayMs = options.retryDelayMs;
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
    current.value.rev = (current.value.rev || 0) + 1;
    scheduleSync();
    return db
      .put(current.value)
      .then(refreshList)
      .catch((e) => console.error("Could not save the AI Filters conversation", e));
  }

  async function refreshList() {
    conversations.value = await db.list(craftName.value);
    pendingCount.value = (await db.all()).filter(isDirty).length;
  }

  // ---- GitHub sync (the Tuning Log's repo and token, Settings -> Cloud Storage) ----

  const cloudEnabled = computed(
    () => !!(settingsStore.userSettings.githubRepo && settingsStore.userSettings.githubToken),
  );
  const syncing = ref(false);
  const syncError = ref(null); // { message, offline }
  const pendingCount = ref(0); // conversations with changes not yet in the cloud
  const cloudNotice = ref(""); // e.g. both computers changed the same conversation
  // off | syncing | offline | error | pending | synced - as the Tuning Log's
  const syncStatus = computed(() => {
    if (!cloudEnabled.value) return "off";
    if (syncing.value) return "syncing";
    if (syncError.value) return syncError.value.offline ? "offline" : "error";
    if (pendingCount.value) return "pending";
    return "synced";
  });

  let client = null;
  let clientKey = "";
  function getClient() {
    const s = settingsStore.userSettings;
    if (!s.githubRepo || !s.githubToken) return null;
    const key = `${s.githubRepo}|${s.githubBranch}|${s.githubToken}`;
    if (key !== clientKey) {
      client = clientFactory({ repo: s.githubRepo, branch: s.githubBranch, token: s.githubToken });
      clientKey = key;
    }
    return client;
  }

  let syncTimer = null;
  function scheduleSync(delay = syncDelayMs) {
    if (!cloudEnabled.value || syncDelayMs === null || delay === null) return;
    clearTimeout(syncTimer);
    syncTimer = setTimeout(() => {
      syncTimer = null;
      syncNow();
    }, delay);
  }

  /** The record as it is now on this computer - the open one may be ahead of the database. */
  async function latestLocal(id) {
    if (current.value?.id === id) return current.value;
    return (await db.get(id)) || null;
  }

  async function applySyncResult(result) {
    for (const { id, baseRev } of result.removed) {
      const now = await latestLocal(id);
      // Deleted elsewhere but changed here meanwhile: keep it, it'll be uploaded again.
      if (now && !now.deleted && (now.rev || 0) !== baseRev) continue;
      if (current.value?.id === id) current.value = null;
      await db.delete(id);
    }

    for (const { record, baseRev, uploaded } of result.saved) {
      const now = await latestLocal(record.id);
      const unchanged = baseRev === null ? !now : !!now && (now.rev || 0) === baseRev;
      if (!unchanged) {
        // Changed here while syncing: keep this computer's version, note what's in the cloud.
        if (uploaded && now) {
          now.cloud = record.cloud;
          await db.put(now);
        }
        continue;
      }
      if (current.value?.id === record.id) {
        if (uploaded) current.value.cloud = record.cloud;
        else current.value = record;
        await db.put(current.value);
      } else {
        await db.put(record);
      }
    }

    for (const { id, copyId } of result.conflicts) {
      if (current.value?.id === id) await openConversation(copyId);
      cloudNotice.value =
        "A conversation was changed both here and on another computer. Both versions are kept - " +
        "this computer's is marked “(this computer)”.";
    }
  }

  let syncPromise = null;
  let syncAgain = false;

  /**
   * Uploads conversations changed here and brings in ones changed (or new, for this heli) on
   * other computers. Never throws - failures show in syncStatus and are retried later.
   */
  function syncNow() {
    if (syncPromise) {
      syncAgain = true;
      return syncPromise;
    }
    const activeClient = getClient();
    if (!activeClient) return Promise.resolve();

    clearTimeout(syncTimer);
    syncing.value = true;
    syncPromise = (async () => {
      let failed = false;
      try {
        if (globalThis.navigator && globalThis.navigator.onLine === false) {
          throw Object.assign(new Error("Offline"), { isNetwork: true });
        }
        // Leave the open conversation alone mid-request: its history isn't valid until Claude answers.
        const skip = busy.value && current.value ? current.value.id : null;
        const locals = (await db.all())
          .filter((r) => r.id !== skip)
          .map((r) => (r.id === current.value?.id ? clone(current.value) : r));
        const result = await syncConversations(activeClient, locals, {
          craftName: imagine.hasLog ? craftName.value : null,
        });
        await applySyncResult(result);
        syncError.value = null;
        if (skip) syncAgain = true;
      } catch (e) {
        failed = true;
        syncError.value = { message: e.message, offline: !!e.isNetwork };
        if (!e.isNetwork) console.error("AI Filters sync failed", e);
      } finally {
        syncing.value = false;
        syncPromise = null;
        await refreshList().catch(() => {});
        if (syncAgain) {
          syncAgain = false;
          scheduleSync(busy.value ? syncDelayMs : 0);
        } else if (failed && pendingCount.value) {
          scheduleSync(retryDelayMs);
        }
      }
    })();
    return syncPromise;
  }

  if (globalThis.addEventListener) {
    globalThis.addEventListener("online", () => scheduleSync(0));
  }
  watch(
    () => [
      settingsStore.userSettings.githubRepo,
      settingsStore.userSettings.githubBranch,
      settingsStore.userSettings.githubToken,
    ],
    () => {
      syncError.value = null;
      scheduleSync(0);
    },
  );

  async function loadForCraft() {
    // Bring in this heli's conversations from other computers (and upload anything waiting).
    if (cloudEnabled.value) await syncNow();
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
    const record = await latestLocal(id);
    if (record?.cloud?.version) {
      // In the cloud: keep a tombstone until the cloud copy is deleted too.
      await db.put({
        id,
        deleted: true,
        craftName: record.craftName,
        title: record.title,
        cloud: record.cloud,
        rev: (record.rev || 0) + 1,
      });
      scheduleSync(0);
    } else {
      await db.delete(id);
    }
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
    cloudEnabled,
    syncStatus,
    syncError,
    pendingCount,
    cloudNotice,
    syncNow,
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
