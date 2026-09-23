import { defineStore } from "pinia";
import { ref, computed, toRaw, watch } from "vue";
import { PrefStorage } from "../pref_storage.js";
import { triggerDownload } from "../tools.js";
import * as TuningLog from "../tuning_log.js";
import { createTuningLogDb } from "../tuning_log_db.js";
import { OPS, emptySyncState, recordChange, pendingCount, mergeLogs } from "../tuning_log_sync.js";
import * as Cloud from "../tuning_log_cloud.js";
import { createGitHubClient } from "../github_client.js";
import { useSettingsStore } from "./settings.js";

const prefs = new PrefStorage();

// Shared by every store instance, so a log saved by one is there for the next (and replaceable in
// tests).
let db = createTuningLogDb();

export function setTuningLogDb(newDb) {
  db = newDb;
}

// How long after the last change to wait before syncing (so a burst of edits is one commit), and
// how long to wait before retrying after failing to reach GitHub.
let syncDelayMs = 3000;
let retryDelayMs = 60000;
let clientFactory = createGitHubClient;

/**
 * For tests: replace the GitHub client factory, and the sync delays (null disables automatic
 * syncing - call syncNow() instead).
 */
export function setTuningLogCloudForTests(options) {
  if (options.clientFactory) clientFactory = options.clientFactory;
  if ("syncDelayMs" in options) syncDelayMs = options.syncDelayMs;
  if ("retryDelayMs" in options) retryDelayMs = options.retryDelayMs;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function changeKey(c) {
  return `${c.op}|${c.entryId || ""}|${c.at}`;
}

function prefGet(name) {
  return new Promise((resolve) => prefs.get(name, resolve));
}

function saveImages(log) {
  return Promise.all(
    (log.entries || []).filter((entry) => entry.image).map((entry) => db.putImage(log.logId, entry.id, entry.image)),
  );
}

export const useTuningLogStore = defineStore("tuningLog", () => {
  const currentLog = ref(null);
  // Sync state (outbox of unsynced changes etc.) for currentLog - see tuning_log_sync.js.
  const currentSync = ref(null);
  // Summaries of every log stored on this computer - see tuning_log_db.js listLogs().
  const localLogs = ref([]);
  const aiExpertMode = ref(false);
  const aiUseSkills = ref(true);
  const apiKeyBannerDismissed = ref(false);

  const hasLog = computed(() => currentLog.value !== null);
  const entries = computed(() => (currentLog.value ? currentLog.value.entries : []));
  const totalCostUsd = computed(() =>
    entries.value.reduce((sum, entry) => sum + ((entry.ai && entry.ai.costUsd) || 0), 0),
  );
  const pendingChangeCount = computed(() => pendingCount(currentSync.value));

  // --- Cloud (GitHub) sync - see tuning_log_cloud.js ---
  const settingsStore = useSettingsStore();
  const cloudEnabled = computed(
    () => !!(settingsStore.userSettings.githubRepo && settingsStore.userSettings.githubToken),
  );
  const syncing = ref(false);
  const syncError = ref(null); // { message, offline } from the last failed sync, cleared on success
  const lastSyncedAt = ref(null);
  // Unsynced changes across every log on this computer, not just the current one.
  const totalPendingCount = computed(() => {
    const others = localLogs.value
      .filter((l) => !currentLog.value || l.logId !== currentLog.value.logId)
      .reduce((sum, l) => sum + (l.pendingCount || 0), 0);
    return others + pendingChangeCount.value;
  });
  // off | syncing | offline | error | pending | synced
  const syncStatus = computed(() => {
    if (!cloudEnabled.value) return "off";
    if (syncing.value) return "syncing";
    if (syncError.value) return syncError.value.offline ? "offline" : "error";
    if (totalPendingCount.value) return "pending";
    return "synced";
  });

  async function refreshLocalLogs() {
    localLogs.value = await db.listLogs();
  }

  function persist() {
    if (!currentLog.value) return Promise.resolve();

    // A plain copy: items the outbox got back from filtering a reactive array are Vue proxies,
    // which IndexedDB can't store.
    const sync = JSON.parse(JSON.stringify(currentSync.value));
    return db
      .putLog(toRaw(currentLog.value), sync)
      .then(refreshLocalLogs)
      .catch((error) => console.error("Could not save the tuning log locally", error));
  }

  function change(op, entryId) {
    recordChange(currentSync.value, { op, entryId });
    scheduleSync();
    return persist();
  }

  let client = null;
  let clientKey = "";

  function getClient() {
    const settings = settingsStore.userSettings;
    if (!settings.githubRepo || !settings.githubToken) return null;

    const key = `${settings.githubRepo}|${settings.githubBranch}|${settings.githubToken}`;
    if (key !== clientKey) {
      client = clientFactory({ repo: settings.githubRepo, branch: settings.githubBranch, token: settings.githubToken });
      clientKey = key;
    }
    return client;
  }

  let syncTimer = null;

  function scheduleSync(delay = syncDelayMs) {
    // syncDelayMs null: automatic syncing is off (tests) - only syncNow() syncs.
    if (!cloudEnabled.value || syncDelayMs === null || delay === null) return;
    clearTimeout(syncTimer);
    syncTimer = setTimeout(() => {
      syncTimer = null;
      syncNow();
    }, delay);
  }

  /**
   * Stores what a sync of one log produced, keeping any changes made to that log while the sync
   * was running: those are merged on top of the synced copy and stay pending for the next sync.
   */
  async function applySyncResult(start, result) {
    const logId = start.log.logId;
    const isCurrent = currentLog.value && currentLog.value.logId === logId;
    const now = isCurrent
      ? { log: clone(toRaw(currentLog.value)), sync: clone(currentSync.value) }
      : await db.getLog(logId);
    if (!now) return; // Deleted from this computer meanwhile.

    const startKeys = new Set(start.sync.pending.map(changeKey));
    const newPending = now.sync.pending.filter((c) => !startKeys.has(changeKey(c)));

    const log = newPending.length ? mergeLogs(start.log, now.log, result.log) : result.log;
    const sync = { ...result.sync, pending: newPending };

    // Store images that arrived from the cloud; drop ones whose entries the cloud copy deleted.
    const hadImage = new Set(start.log.entries.filter((e) => e.image).map((e) => e.id));
    const finalIds = new Set(log.entries.map((e) => e.id));
    for (const entry of log.entries) {
      if (entry.image && !hadImage.has(entry.id)) await db.putImage(logId, entry.id, entry.image);
    }
    for (const id of hadImage) {
      if (!finalIds.has(id)) await db.deleteImage(logId, id);
    }

    if (currentLog.value && currentLog.value.logId === logId) {
      currentLog.value = log;
      currentSync.value = sync;
      await persist();
    } else {
      await db.putLog(log, sync);
    }
  }

  async function syncOne(activeClient, logId) {
    const isCurrent = currentLog.value && currentLog.value.logId === logId;
    const start = isCurrent
      ? { log: clone(toRaw(currentLog.value)), sync: clone(currentSync.value) }
      : await db.getLog(logId);
    if (!start) return;

    const result = await Cloud.syncLog(activeClient, start.log, start.sync);
    if (result.uploaded || result.downloaded || result.sync !== start.sync) {
      await applySyncResult(start, result);
    }
  }

  let syncPromise = null;
  let syncAgain = false;

  /**
   * Syncs every log on this computer that has unsynced changes, plus the current log (to pick up
   * changes made elsewhere). Never throws - a failure is reported through syncError/syncStatus and
   * retried later; nothing local is lost either way.
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

        const logs = await db.listLogs();
        const ids = logs.filter((l) => l.pendingCount > 0).map((l) => l.logId);
        if (currentLog.value && !ids.includes(currentLog.value.logId)) ids.unshift(currentLog.value.logId);

        for (const id of ids) {
          await syncOne(activeClient, id);
        }

        syncError.value = null;
        lastSyncedAt.value = new Date().toISOString();
      } catch (error) {
        failed = true;
        syncError.value = { message: error.message, offline: !!error.isNetwork };
        if (!error.isNetwork) console.error("Tuning log sync failed", error);
      } finally {
        syncing.value = false;
        syncPromise = null;
        await refreshLocalLogs().catch(() => {});

        if (syncAgain) {
          syncAgain = false;
          scheduleSync(0);
        } else if (failed && totalPendingCount.value) {
          scheduleSync(retryDelayMs);
        }
      }
    })();

    return syncPromise;
  }

  /**
   * Every log in the cloud for a craft (by its name), most recently updated first, each marked
   * with whether it's already on this computer. Rejects if GitHub can't be reached.
   */
  async function listCloudLogs(craftName) {
    const activeClient = getClient();
    if (!activeClient) return [];

    const index = await Cloud.fetchIndex(activeClient);
    const localIds = new Set(localLogs.value.map((l) => l.logId));
    return Cloud.indexRowsForCraft(index, craftName).map((row) => ({ ...row, isLocal: localIds.has(row.logId) }));
  }

  /**
   * Makes a cloud log (a row from listCloudLogs) the current log - from this computer's copy if it
   * has one (then syncing it), otherwise downloading it with its images. Resolves false if it
   * couldn't be found.
   */
  async function openCloudLog(row) {
    if (await switchLog(row.logId)) {
      return true;
    }

    const activeClient = getClient();
    if (!activeClient) return false;

    const downloaded = await Cloud.downloadLog(activeClient, row);
    if (!downloaded) return false;

    await saveImages(downloaded.log);
    await db.putLog(downloaded.log, downloaded.sync);
    setCurrent(downloaded.log, downloaded.sync);
    await refreshLocalLogs();
    return true;
  }

  function setCurrent(log, sync) {
    currentLog.value = log;
    currentSync.value = sync;
    prefs.set("tuningLogCurrentId", log ? log.logId : null);
  }

  /**
   * Stores a log that's new to this computer - freshly created or imported - with all of it
   * pending sync, and makes it the current log.
   */
  async function adoptLog(log, op) {
    log.entries = log.entries || [];
    log.deletedEntries = log.deletedEntries || [];

    const sync = recordChange(emptySyncState(), { op });
    setCurrent(log, sync);
    await saveImages(log);
    await persist();
    scheduleSync();
    return currentLog.value;
  }

  /**
   * Before tuning logs were kept in IndexedDB, the one current log lived in localStorage under
   * "tuningLog" - move it across (once) so it isn't lost.
   */
  async function migrateLegacyLog() {
    const legacy = await prefGet("tuningLog");
    if (!legacy || !legacy.logId) return;

    if (!(await db.getLog(legacy.logId))) {
      legacy.entries = legacy.entries || [];
      legacy.deletedEntries = legacy.deletedEntries || [];
      await saveImages(legacy);
      await db.putLog(legacy, recordChange(emptySyncState(), { op: OPS.IMPORT_LOG }));
    }

    if (!(await prefGet("tuningLogCurrentId"))) {
      prefs.set("tuningLogCurrentId", legacy.logId);
    }
    prefs.set("tuningLog", null);
  }

  async function loadFromCache() {
    try {
      await migrateLegacyLog();

      const currentId = await prefGet("tuningLogCurrentId");
      const stored = currentId ? await db.getLog(currentId) : null;

      // Unless a log was already created/imported/switched to while this was loading.
      if (stored && !currentLog.value) {
        currentLog.value = stored.log;
        currentSync.value = stored.sync;
      }

      await refreshLocalLogs();
    } catch (error) {
      console.error("Could not load tuning logs", error);
    }
  }

  function createLog(name, craftName) {
    adoptLog(TuningLog.create(name, craftName), OPS.CREATE_LOG);
    return currentLog.value;
  }

  /**
   * Makes a log already stored on this computer the current one. Resolves false if it isn't there.
   */
  async function switchLog(logId) {
    const stored = await db.getLog(logId);
    if (!stored) return false;

    setCurrent(stored.log, stored.sync);
    scheduleSync(0);
    return true;
  }

  /**
   * Stops using the current log. It stays stored on this computer (see localLogs/switchLog).
   */
  function closeLog() {
    setCurrent(null, null);
  }

  /**
   * Removes a log from this computer entirely, unsynced changes and all.
   */
  async function deleteLocalLog(logId) {
    if (currentLog.value && currentLog.value.logId === logId) {
      setCurrent(null, null);
    }
    await db.deleteLog(logId);
    await refreshLocalLogs();
  }

  function findEntry(entryId) {
    return entries.value.find((entry) => entry.id === entryId) || null;
  }

  /**
   * options: { image, config, notes, craftName, timestamp }
   */
  function addEntry(options) {
    if (!currentLog.value) return null;

    const entry = TuningLog.addEntry(currentLog.value, options);
    if (entry.image) {
      db.putImage(currentLog.value.logId, entry.id, entry.image).catch((error) =>
        console.error("Could not save the step response image locally", error),
      );
    }
    change(OPS.ADD_ENTRY, entry.id);
    return entry;
  }

  function deleteEntry(entryId) {
    if (!currentLog.value) return;

    const index = currentLog.value.entries.findIndex((entry) => entry.id === entryId);
    if (index === -1) return;

    currentLog.value.entries.splice(index, 1);
    currentLog.value.deletedEntries = currentLog.value.deletedEntries || [];
    currentLog.value.deletedEntries.push({ id: entryId, deletedAt: new Date().toISOString() });

    db.deleteImage(currentLog.value.logId, entryId).catch(() => {});
    change(OPS.DELETE_ENTRY, entryId);
  }

  function updateEntryNotes(entryId, notes) {
    const entry = findEntry(entryId);
    if (!entry) return;

    entry.notes = notes;
    change(OPS.UPDATE_NOTES, entryId);
  }

  /**
   * result: { model, conversation, costUsd } - costUsd is added to any cost already recorded for
   * this entry (a follow-up question adds to the running total, it doesn't replace it).
   */
  function setEntryAiResult(entryId, result) {
    const entry = findEntry(entryId);
    if (!entry) return;

    entry.ai = entry.ai || {};
    entry.ai.model = result.model;
    entry.ai.conversation = result.conversation;
    entry.ai.costUsd = (entry.ai.costUsd || 0) + (result.costUsd || 0);
    change(OPS.SET_AI, entryId);
  }

  function importFromFile(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();

      reader.onload = (e) => {
        let log;
        try {
          log = JSON.parse(e.target.result);
        } catch {
          reject(new Error("This file is not valid JSON."));
          return;
        }

        const error = TuningLog.validationError(log);
        if (error) {
          reject(new Error(error));
          return;
        }

        adoptLog(log, OPS.IMPORT_LOG).then(resolve, reject);
      };

      reader.onerror = () => reject(new Error("Could not read file"));

      reader.readAsText(file);
    });
  }

  function exportToFile() {
    if (!currentLog.value) return;

    const raw = toRaw(currentLog.value);
    const filename = TuningLog.buildFilename(raw);
    triggerDownload(new Blob([JSON.stringify(raw, null, 2)], { type: "application/json" }), filename);
  }

  function setAiExpertMode(value) {
    aiExpertMode.value = value;
    prefs.set("tuningLogAiExpertMode", value);
  }

  function setAiUseSkills(value) {
    aiUseSkills.value = value;
    prefs.set("tuningLogAiUseSkills", value);
  }

  function dismissApiKeyBanner() {
    apiKeyBannerDismissed.value = true;
    prefs.set("tuningLogApiKeyBannerDismissed", true);
  }

  // Restore the persisted tuning log and prefs as soon as the store is created, then catch up with
  // the cloud: upload anything done offline last time, and pick up changes made elsewhere.
  const ready = loadFromCache().then(() => scheduleSync(0));

  if (globalThis.addEventListener) {
    globalThis.addEventListener("online", () => scheduleSync(0));
  }

  // New repo/token in Settings - start using it straight away.
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
  prefs.get("tuningLogAiExpertMode", (value) => {
    aiExpertMode.value = !!value;
  });
  prefs.get("tuningLogAiUseSkills", (value) => {
    aiUseSkills.value = value === undefined || value === null ? true : !!value;
  });
  prefs.get("tuningLogApiKeyBannerDismissed", (value) => {
    apiKeyBannerDismissed.value = !!value;
  });

  return {
    currentLog,
    currentSync,
    localLogs,
    aiExpertMode,
    aiUseSkills,
    apiKeyBannerDismissed,
    hasLog,
    entries,
    totalCostUsd,
    pendingChangeCount,
    totalPendingCount,
    cloudEnabled,
    syncStatus,
    syncError,
    lastSyncedAt,
    ready,
    syncNow,
    listCloudLogs,
    openCloudLog,
    createLog,
    switchLog,
    closeLog,
    deleteLocalLog,
    addEntry,
    deleteEntry,
    updateEntryNotes,
    setEntryAiResult,
    importFromFile,
    exportToFile,
    setAiExpertMode,
    setAiUseSkills,
    dismissApiKeyBanner,
  };
});
