// Local storage for AI Filters conversations: IndexedDB (same backend as the Tuning Log, own
// database), falling back to memory when IndexedDB isn't available (tests).

import { createIndexedDbBackend, createMemoryBackend } from "../../tuning_log_db.js";

const STORE = "conversations";
export const AI_FILTERS_SCHEMA = Object.freeze({
  name: "rfImagineAiFilters",
  version: 1,
  stores: [{ name: STORE, keyPath: "id" }],
});

export function craftKeyOf(craftName) {
  return String(craftName || "")
    .trim()
    .toLowerCase();
}

function defaultBackend() {
  return globalThis.indexedDB
    ? createIndexedDbBackend(globalThis.indexedDB, AI_FILTERS_SCHEMA)
    : createMemoryBackend(AI_FILTERS_SCHEMA);
}

function summarize(record) {
  return {
    id: record.id,
    title: record.title,
    craftName: record.craftName,
    craftKey: craftKeyOf(record.craftName),
    updatedAt: record.updatedAt,
    createdAt: record.createdAt,
    configCount: (record.configs || []).length,
    costUsd: record.costUsd || 0,
  };
}

export function createConversationDb(backend = defaultBackend()) {
  let writeQueue = Promise.resolve();
  const queue = (action) => {
    const result = writeQueue.then(action);
    writeQueue = result.catch(() => {});
    return result;
  };

  return {
    /** Summaries, newest first; pass a craft name to only list that craft's conversations. */
    async list(craftName) {
      const all = (await backend.getAll(STORE)).map(summarize);
      const key = craftName === undefined ? null : craftKeyOf(craftName);
      return all
        .filter((c) => key === null || c.craftKey === key)
        .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    },
    get: (id) => backend.get(STORE, id),
    // a plain copy, so Vue proxies never reach IndexedDB
    put: (record) => queue(() => backend.put(STORE, JSON.parse(JSON.stringify(record)))),
    delete: (id) => queue(() => backend.delete(STORE, id)),
  };
}
