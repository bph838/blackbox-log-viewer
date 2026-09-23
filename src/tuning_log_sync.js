// Offline-first bookkeeping for Tuning Logs: the local copy is always the working copy, and every
// change made to it is recorded in an "outbox" (sync.pending) until a cloud copy confirms it. When
// the local and cloud copies have both changed since they were last in step, mergeLogs() combines
// them with a three-way merge against the last-synced copy (sync.base), so nothing done offline -
// or on another computer - is lost: entries are unioned by id, deletions are carried as
// tombstones (log.deletedEntries) so the other copy can't bring a deleted entry back, and a note or
// AI conversation edited on both sides keeps both versions rather than one silently overwriting
// the other. A tombstone only applies to an entry added before it (entry.addedAt < deletedAt), so
// deleting an entry and then capturing the same flight again (same id) keeps the new entry.
//
// Everything here is pure (no storage or network) - see stores/tuningLog.js for where it's used.

export const OPS = {
  CREATE_LOG: "createLog",
  IMPORT_LOG: "importLog",
  ADD_ENTRY: "addEntry",
  DELETE_ENTRY: "deleteEntry",
  UPDATE_NOTES: "updateNotes",
  SET_AI: "setAi",
};

export const NOTES_CONFLICT_SEPARATOR = "--- Also edited on another device ---";

/**
 * Normalises a craft name into the key logs are grouped under, so "TRON 7.0" and " Tron 7.0"
 * are the same heli. Also safe to use as a folder name.
 */
export function craftKey(craftName) {
  const key = String(craftName || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return key || "unnamed";
}

/**
 * base: the log (without images) as it was when the local and cloud copies were last in step, or
 * null if this log has never been synced. baseSha: the cloud copy's version at that point.
 */
export function emptySyncState() {
  return { base: null, baseSha: null, lastSyncedAt: null, pending: [] };
}

/**
 * Adds a change to the outbox, collapsing it with earlier unsynced changes where that loses
 * nothing: repeated edits to the same entry's notes/AI result count once, and deleting an entry
 * replaces its other pending changes. (A deletion is always kept, even for an entry that looks
 * unsynced - a sync may be uploading that entry at this very moment.) Returns the same sync object.
 */
export function recordChange(sync, change) {
  const at = change.at || new Date().toISOString();
  const pending = sync.pending;

  if (change.op === OPS.DELETE_ENTRY) {
    sync.pending = pending.filter((c) => c.entryId !== change.entryId);
    sync.pending.push({ op: change.op, entryId: change.entryId, at });
    return sync;
  }

  if (change.op === OPS.UPDATE_NOTES || change.op === OPS.SET_AI) {
    const existing = pending.find((c) => c.op === change.op && c.entryId === change.entryId);
    if (existing) {
      existing.at = at;
      return sync;
    }
  }

  pending.push(change.entryId ? { op: change.op, entryId: change.entryId, at } : { op: change.op, at });
  return sync;
}

export function pendingCount(sync) {
  return (sync && sync.pending && sync.pending.length) || 0;
}

/**
 * Call once the cloud has confirmed it holds `syncedLog`: that becomes the new base for future
 * merges, and the outbox empties.
 */
export function markSynced(sync, syncedLog, sha, at) {
  sync.base = stripImages(syncedLog);
  sync.baseSha = sha || null;
  sync.lastSyncedAt = at || new Date().toISOString();
  sync.pending = [];
  return sync;
}

/**
 * A deep copy of `log` with each entry's image data removed (entry.hasImage marks where one
 * was). Images are stored and synced separately from the log's text, which stays small.
 */
export function stripImages(log) {
  if (!log) return null;

  const copy = clone(log);
  for (const entry of copy.entries || []) {
    if (entry.image) {
      entry.hasImage = true;
    }
    delete entry.image;
  }
  return copy;
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function same(a, b) {
  return JSON.stringify(a === undefined ? null : a) === JSON.stringify(b === undefined ? null : b);
}

function byId(entries) {
  const map = new Map();
  for (const entry of entries || []) {
    map.set(entry.id, entry);
  }
  return map;
}

/**
 * Unions tombstones by entry id, keeping the latest deletion of each - so an entry deleted, re-added
 * and deleted again stays deleted.
 */
function mergeTombstones(...lists) {
  const map = new Map();
  for (const list of lists) {
    for (const tombstone of list || []) {
      const existing = map.get(tombstone.id);
      if (!existing || String(tombstone.deletedAt) > String(existing.deletedAt)) {
        map.set(tombstone.id, tombstone);
      }
    }
  }
  return [...map.values()];
}

/**
 * Whether a tombstone deletes this entry: only if the entry was added before the deletion. (Entries
 * from before addedAt existed count as added at the beginning of time.)
 */
function isDeleted(entry, tombstones) {
  const tombstone = tombstones.get(entry.id);
  return !!tombstone && String(tombstone.deletedAt) > String(entry.addedAt || "");
}

/**
 * Picks a value changed on only one side; when both sides changed it differently, returns
 * `conflict` so the caller can combine them.
 */
function threeWay(base, local, remote) {
  if (same(local, remote)) return { value: local };
  if (same(local, base)) return { value: remote };
  if (same(remote, base)) return { value: local };
  return { conflict: true };
}

function mergeNotes(base, local, remote) {
  const result = threeWay(base || "", local || "", remote || "");
  if (!result.conflict) return result.value;

  if (!local) return remote;
  if (!remote) return local;
  return `${local}\n\n${NOTES_CONFLICT_SEPARATOR}\n${remote}`;
}

/**
 * Both copies asked the AI about the same entry: keep both conversations. They share whatever
 * prefix was already in step (base), then each side's own follow-ups - each follow-up is a whole
 * user/assistant pair, so appending one side's after the other's keeps the turns alternating.
 */
function mergeAi(base, local, remote) {
  const result = threeWay(base, local, remote);
  if (!result.conflict) return clone(result.value);

  if (!local) return clone(remote);
  if (!remote) return clone(local);

  const localConversation = local.conversation || [];
  const remoteConversation = remote.conversation || [];

  let prefix = 0;
  while (
    prefix < localConversation.length &&
    prefix < remoteConversation.length &&
    same(localConversation[prefix], remoteConversation[prefix])
  ) {
    prefix++;
  }

  let conversation;
  let costUsd;
  if (prefix === localConversation.length || prefix === remoteConversation.length) {
    // One is just a continuation of the other.
    const longer = localConversation.length >= remoteConversation.length ? local : remote;
    conversation = longer.conversation || [];
    costUsd = Math.max(local.costUsd || 0, remote.costUsd || 0);
  } else {
    conversation = [...remoteConversation, ...localConversation.slice(prefix)];
    costUsd = (local.costUsd || 0) + (remote.costUsd || 0) - ((base && base.costUsd) || 0);
  }

  return clone({ model: local.model || remote.model, conversation, costUsd });
}

function mergeEntry(base, local, remote) {
  // One side deleted this entry and captured the same flight again: that's a new entry, not an
  // edit of the old one - the newer one replaces it outright.
  if ((local.addedAt || "") !== (remote.addedAt || "")) {
    const newer = clone(String(local.addedAt || "") > String(remote.addedAt || "") ? local : remote);
    if (!newer.image && local.image) newer.image = local.image;
    return newer;
  }

  const merged = clone(remote);

  // Image data is never in a remote/base copy - keep whatever the local copy already has loaded.
  if (local.image && !merged.image) {
    merged.image = local.image;
  }

  const notes = mergeNotes(base && base.notes, local.notes, remote.notes);
  merged.notes = notes || "";

  const ai = mergeAi(base && base.ai, local.ai, remote.ai);
  if (ai) {
    merged.ai = ai;
  } else {
    delete merged.ai;
  }

  return merged;
}

/**
 * Three-way merge of a tuning log.
 *   base:   the copy both sides last agreed on (sync.base), or null if never synced
 *   local:  this computer's working copy
 *   remote: the cloud copy, or null if it isn't in the cloud yet
 * Returns a new merged log; none of the inputs are modified. Entry order follows the remote copy,
 * then any entries only the local copy has, in its order.
 */
export function mergeLogs(base, local, remote) {
  if (!remote) return clone(local);
  if (!local) return clone(remote);

  const deletedEntries = mergeTombstones(base && base.deletedEntries, local.deletedEntries, remote.deletedEntries);
  const tombstones = new Map(deletedEntries.map((t) => [t.id, t]));

  const baseEntries = byId(base && base.entries);
  const localEntries = byId(local.entries);

  const entries = [];
  const seen = new Set();

  for (const remoteEntry of remote.entries || []) {
    seen.add(remoteEntry.id);

    const localEntry = localEntries.get(remoteEntry.id);
    const remoteAlive = !isDeleted(remoteEntry, tombstones);
    const localAlive = !!localEntry && !isDeleted(localEntry, tombstones);

    if (remoteAlive && localAlive) {
      entries.push(mergeEntry(baseEntries.get(remoteEntry.id), localEntry, remoteEntry));
    } else if (remoteAlive) {
      entries.push(clone(remoteEntry));
    } else if (localAlive) {
      entries.push(clone(localEntry));
    }
  }

  for (const localEntry of local.entries || []) {
    if (seen.has(localEntry.id) || isDeleted(localEntry, tombstones)) continue;

    // Not in the cloud copy and not deleted there either: new here (or the cloud copy lost it) -
    // keep it either way.
    entries.push(clone(localEntry));
  }

  const merged = clone(remote);
  merged.entries = entries;
  merged.deletedEntries = deletedEntries;

  // Log-level fields: whichever side changed wins; if both did, this computer's edit wins.
  for (const field of ["name", "craftName"]) {
    const result = threeWay(base && base[field], local[field], remote[field]);
    merged[field] = result.conflict ? local[field] : result.value;
  }

  return merged;
}
