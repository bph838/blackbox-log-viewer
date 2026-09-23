import { defineStore } from "pinia";
import { ref, computed, toRaw } from "vue";
import { PrefStorage } from "../pref_storage.js";
import { triggerDownload } from "../tools.js";
import * as TuningLog from "../tuning_log.js";
import { createTuningLogDb } from "../tuning_log_db.js";
import { OPS, emptySyncState, recordChange, pendingCount } from "../tuning_log_sync.js";

const prefs = new PrefStorage();

// Shared by every store instance, so a log saved by one is there for the next (and replaceable in
// tests).
let db = createTuningLogDb();

export function setTuningLogDb(newDb) {
  db = newDb;
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
    return persist();
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

  // Restore the persisted tuning log and prefs as soon as the store is created.
  const ready = loadFromCache();
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
    ready,
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
