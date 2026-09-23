// Local storage for Tuning Logs: every log this computer has worked on, each with its sync state
// (see tuning_log_sync.js), kept in IndexedDB so logs survive between sessions and work offline.
// Step response images are stored separately from the log's text - a log record stays small and
// quick to rewrite on every change, and an image is only ever written once. IndexedDB also has far
// more room than localStorage (~5 MB), which image-heavy logs quickly outgrow.
//
// Falls back to an in-memory store when IndexedDB isn't available (e.g. tests), so callers never
// need to care which backend is in use.

import { craftKey, pendingCount, stripImages } from "./tuning_log_sync.js";

const DB_NAME = "rfTuningLogs";
const DB_VERSION = 1;
const LOGS = "logs";
const IMAGES = "images";

function imageKey(logId, entryId) {
  return `${logId}/${entryId}`;
}

function requestToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function createIndexedDbBackend(indexedDB) {
  let dbPromise = null;

  function open() {
    if (!dbPromise) {
      dbPromise = new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        request.onupgradeneeded = () => {
          const db = request.result;
          if (!db.objectStoreNames.contains(LOGS)) {
            db.createObjectStore(LOGS, { keyPath: "logId" });
          }
          if (!db.objectStoreNames.contains(IMAGES)) {
            db.createObjectStore(IMAGES);
          }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    }
    return dbPromise;
  }

  async function run(storeName, mode, action) {
    const db = await open();
    const tx = db.transaction(storeName, mode);
    const done = new Promise((resolve, reject) => {
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
    const [result] = await Promise.all([requestToPromise(action(tx.objectStore(storeName))), done]);
    return result;
  }

  return {
    get: (storeName, key) => run(storeName, "readonly", (s) => s.get(key)),
    getAll: (storeName) => run(storeName, "readonly", (s) => s.getAll()),
    put: (storeName, value, key) =>
      run(storeName, "readwrite", (s) => (key === undefined ? s.put(value) : s.put(value, key))),
    delete: (storeName, key) => run(storeName, "readwrite", (s) => s.delete(key)),
  };
}

export function createMemoryBackend() {
  const stores = { [LOGS]: new Map(), [IMAGES]: new Map() };
  const copy = (value) => (value === undefined ? undefined : structuredClone(value));

  return {
    get: async (storeName, key) => copy(stores[storeName].get(key)),
    getAll: async (storeName) => [...stores[storeName].values()].map(copy),
    put: async (storeName, value, key) => {
      stores[storeName].set(key === undefined ? value.logId : key, copy(value));
    },
    delete: async (storeName, key) => {
      stores[storeName].delete(key);
    },
  };
}

function defaultBackend() {
  return globalThis.indexedDB ? createIndexedDbBackend(globalThis.indexedDB) : createMemoryBackend();
}

/**
 * Summary of a stored log for pickers/lists, without loading its entries' images.
 */
function summarize(record) {
  const log = record.log;
  return {
    logId: log.logId,
    name: log.name,
    craftName: log.craftName,
    craftKey: craftKey(log.craftName),
    entryCount: (log.entries || []).length,
    pendingCount: pendingCount(record.sync),
    lastSyncedAt: (record.sync && record.sync.lastSyncedAt) || null,
    updatedAt: record.updatedAt,
  };
}

export function createTuningLogDb(backend = defaultBackend()) {
  // Serialises writes, so a slow write can't land after (and overwrite) a later one.
  let writeQueue = Promise.resolve();
  function queue(action) {
    const result = writeQueue.then(action);
    writeQueue = result.catch(() => {});
    return result;
  }

  /**
   * Saves the log's text and sync state. Image data isn't written here (see putImage) - only
   * whether each entry has one.
   */
  function putLog(log, sync) {
    const record = { logId: log.logId, log: stripImages(log), sync, updatedAt: new Date().toISOString() };
    return queue(() => backend.put(LOGS, record));
  }

  function putImage(logId, entryId, dataUrl) {
    return queue(() => backend.put(IMAGES, dataUrl, imageKey(logId, entryId)));
  }

  function deleteImage(logId, entryId) {
    return queue(() => backend.delete(IMAGES, imageKey(logId, entryId)));
  }

  function getImage(logId, entryId) {
    return backend.get(IMAGES, imageKey(logId, entryId));
  }

  /**
   * Loads a log with its locally stored images put back on its entries, plus its sync state.
   * Resolves null if there's no such log.
   */
  async function getLog(logId) {
    await writeQueue;
    const record = await backend.get(LOGS, logId);
    if (!record) return null;

    const log = record.log;
    for (const entry of log.entries || []) {
      if (entry.hasImage) {
        const image = await getImage(logId, entry.id);
        if (image) {
          entry.image = image;
        }
      }
    }

    return { log, sync: record.sync };
  }

  /**
   * Every stored log, most recently changed first.
   */
  async function listLogs() {
    await writeQueue;
    const records = await backend.getAll(LOGS);
    return records.map(summarize).sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""));
  }

  async function deleteLog(logId) {
    const record = await backend.get(LOGS, logId);
    if (record) {
      for (const entry of record.log.entries || []) {
        await deleteImage(logId, entry.id);
      }
    }
    return queue(() => backend.delete(LOGS, logId));
  }

  return { putLog, putImage, deleteImage, getImage, getLog, listLogs, deleteLog };
}
