// Keeps AI Filters conversations in the same GitHub repo as the Tuning Logs (Settings -> Cloud
// Storage), in their own folder so the two never touch each other's files:
//
//   ai-filters/index.json                               every conversation, grouped by craft
//   ai-filters/crafts/<craft-key>/<conversationId>.json  one conversation (messages, configs, ...)
//
// A heli can have any number of conversations; each is its own file, so they sync independently.
//
// Sync bookkeeping lives on the local record and is stripped before upload:
//   rev    goes up with every local save (see ai_filters_store.js persist())
//   cloud  { path, version, updated, syncedRev } - where it lives in the repo, its index version
//          (a fresh random token per upload) when this computer was last in step with it, and the
//          rev that was uploaded/downloaded
//   deleted  a tombstone: deleted here, still to be deleted from the cloud
//
// Conversations are append-only histories that can't be meaningfully merged, so if one was
// changed both here and on another computer since the last sync, both versions are kept: the
// cloud one under the original id, this computer's as a copy.

import { craftKey } from "../../tuning_log_sync.js";

export const INDEX_PATH = "ai-filters/index.json";
const MAX_ATTEMPTS = 3;

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function newId() {
  return `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

export function defaultPath(record) {
  return `ai-filters/crafts/${craftKey(record.craftName)}/${record.id}.json`;
}

/** Whether a local record has changes the cloud doesn't. */
export function isDirty(record) {
  if (record.deleted) return true;
  return !record.cloud || record.cloud.syncedRev !== (record.rev || 0);
}

/** The record as stored in the repo - without this computer's sync bookkeeping. */
export function cloudCopy(record) {
  const copy = clone(record);
  delete copy.cloud;
  delete copy.rev;
  delete copy.deleted;
  return copy;
}

export function emptyIndex() {
  return { formatVersion: 1, crafts: {} };
}

export async function fetchIndex(client) {
  const file = await client.getJsonFile(INDEX_PATH);
  const index = file && file.json && typeof file.json === "object" && !Array.isArray(file.json) ? file.json : emptyIndex();
  index.formatVersion = index.formatVersion || 1;
  if (!index.crafts || typeof index.crafts !== "object") index.crafts = {};
  return index;
}

/** id -> { ...row, craftKey } for every conversation in the index. */
export function indexRows(index) {
  const rows = new Map();
  for (const [key, group] of Object.entries(index.crafts)) {
    for (const [id, row] of Object.entries(group.conversations || {})) rows.set(id, { ...row, craftKey: key });
  }
  return rows;
}

export function removeIndexRow(index, id) {
  for (const [key, group] of Object.entries(index.crafts)) {
    if (group.conversations && group.conversations[id]) {
      delete group.conversations[id];
      if (!Object.keys(group.conversations).length) delete index.crafts[key];
      return true;
    }
  }
  return false;
}

export function setIndexRow(index, record, path, updated, version) {
  removeIndexRow(index, record.id);
  const key = craftKey(record.craftName);
  const group = index.crafts[key] || (index.crafts[key] = { craftName: record.craftName || "", conversations: {} });
  group.conversations = group.conversations || {};
  group.conversations[record.id] = {
    title: record.title,
    craftName: record.craftName || "",
    path,
    updated,
    version,
    messageCount: (record.messages || []).length,
    configCount: (record.configs || []).length,
  };
}

function downloaded(json, row) {
  const record = json;
  record.rev = 0;
  record.cloud = { path: row.path, version: row.version, updated: row.updated, syncedRev: 0 };
  return record;
}

/**
 * Brings this computer's conversations and the cloud's into step, in one commit.
 *   locals:    every local record (including tombstones) - not modified
 *   craftName: the heli whose cloud conversations this computer should have (others are only
 *              downloaded when already here and changed elsewhere); null for none
 * Resolves { saved, removed, conflicts, uploaded }:
 *   saved:     [{ record, baseRev, uploaded }] - records to store locally. baseRev is the local
 *              rev the result is based on (null for a record that's new here): if the local record
 *              has moved on since, only an upload's `cloud` should be applied to it.
 *   removed:   [{ id, baseRev }] - records to delete locally (tombstones done, or deleted elsewhere)
 *   conflicts: [{ id, copyId }] - changed in both places: the cloud version kept `id`, this
 *              computer's became `copyId`
 * Throws a GitHubError if GitHub can't be reached or refuses the change.
 */
export async function syncConversations(client, locals, { craftName = null, now = () => new Date().toISOString() } = {}) {
  for (let attempt = 1; ; attempt++) {
    const index = await fetchIndex(client);
    const rows = indexRows(index);
    const updated = now();
    const result = { saved: [], removed: [], conflicts: [], uploaded: false };
    const files = [];
    const deletes = [];
    const titles = [];
    let indexChanged = false;

    const upload = (record, baseRev, path) => {
      files.push({ path, text: JSON.stringify(cloudCopy(record), null, 2) });
      const version = newId();
      setIndexRow(index, record, path, updated, version);
      indexChanged = true;
      titles.push(record.title);
      const saved = clone(record);
      saved.cloud = { path, version, updated, syncedRev: record.rev || 0 };
      result.saved.push({ record: saved, baseRev, uploaded: true });
    };

    for (const local of locals) {
      const row = rows.get(local.id);
      const baseRev = local.rev || 0;
      const dirty = isDirty(local);

      if (local.deleted) {
        if (row) {
          removeIndexRow(index, local.id);
          deletes.push(row.path);
          indexChanged = true;
        }
        result.removed.push({ id: local.id, baseRev });
        continue;
      }

      if (!row && local.cloud && local.cloud.version) {
        // Deleted on another computer. Keep it only if it's been changed here since.
        if (!dirty) {
          result.removed.push({ id: local.id, baseRev });
          continue;
        }
        upload(local, baseRev, local.cloud.path || defaultPath(local));
        continue;
      }

      const changedElsewhere = !!row && row.version !== (local.cloud && local.cloud.version);
      if (changedElsewhere) {
        const file = await client.getJsonFile(row.path);
        if (file) {
          result.saved.push({ record: downloaded(file.json, row), baseRev, uploaded: false });
          if (dirty) {
            const copy = clone(local);
            copy.id = newId();
            copy.title = `${local.title} (this computer)`;
            copy.cloud = null;
            upload(copy, null, defaultPath(copy));
            result.conflicts.push({ id: local.id, copyId: copy.id });
          }
          continue;
        }
      }

      if (dirty) upload(local, baseRev, (local.cloud && local.cloud.path) || (row && row.path) || defaultPath(local));
    }

    if (craftName !== null && craftName !== undefined) {
      const key = craftKey(craftName);
      const known = new Set(locals.map((l) => l.id));
      for (const [id, row] of rows) {
        if (row.craftKey !== key || known.has(id)) continue;
        const file = await client.getJsonFile(row.path);
        if (file) result.saved.push({ record: downloaded(file.json, row), baseRev: null, uploaded: false });
      }
    }

    if (!files.length && !deletes.length && !indexChanged) return result;

    files.push({ path: INDEX_PATH, text: JSON.stringify(index, null, 2) });
    const message =
      titles.length === 1 && !deletes.length
        ? `AI Filters conversation "${titles[0]}"`
        : `AI Filters: ${titles.length} saved, ${deletes.length} deleted`;
    try {
      await client.commitFiles({ files, deletes, message });
    } catch (error) {
      if (error.isConflict && attempt < MAX_ATTEMPTS) continue;
      throw error;
    }
    result.uploaded = true;
    return result;
  }
}
