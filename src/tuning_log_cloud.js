// Keeps Tuning Logs in a GitHub repo (see github_client.js), laid out so the app only ever
// downloads what it needs:
//
//   index.json                                  every log in the repo, grouped by craft - the only
//                                               file read to find a heli's logs
//   crafts/<craft-key>/<logId>/log.json         one log's name, craft, description and deletion
//                                               tombstones, plus entryFiles: [{ id, hash }] - the
//                                               list of its entries, in order
//   crafts/<craft-key>/<logId>/entries/<id>.json one entry's text: config, notes, AI conversation
//   crafts/<craft-key>/<logId>/images/<id>.png  one step response graph per entry, rewritten only
//                                               when re-captured (entry.imageUpdatedAt changes)
//
// Entries rarely change once added, so each is its own file: adding one uploads just that entry
// (and its image) plus the small log.json and index.json, and deleting one only rewrites log.json.
// An entry's hash (of its text) says whether it changed, so a sync only downloads entries whose
// hash isn't one this computer already has, and only uploads entries whose hash the cloud lacks.
//
// Logs uploaded before entries had their own files keep every entry inside log.json ("entries"
// rather than "entryFiles"). Those are still read, and rewritten in the new layout the next time
// they're synced (or all at once by migrateLegacyLogs). The whole log as one file is still what
// Export/Import use (see stores/tuningLog.js exportToFile).
//
// sync.cloudUpdated is the log's index.json "updated" stamp when this computer was last in step with
// the cloud copy, so a different stamp in the index means another computer has changed it since.
//
// A log's folder is fixed when it's first uploaded (sync.cloudDir), so it stays put even if the
// log is later re-linked to a different craft name - index.json always says where each log is.
//
// syncLog() is the whole round trip for one log: read the cloud copy, three-way merge it with the
// local one (tuning_log_sync.js), download any images this computer doesn't have yet, and - if the
// cloud copy is missing anything - commit new images, log.json and index.json together. If another
// computer commits in between, it re-reads, re-merges and tries again.

import { craftKey, mergeLogs, markSynced, stripImages } from "./tuning_log_sync.js";
import { hashHex } from "./tuning_log.js";

export const INDEX_PATH = "index.json";
const MAX_ATTEMPTS = 3;
const DOWNLOAD_CONCURRENCY = 4;

export function defaultLogDir(log) {
  return `crafts/${craftKey(log.craftName)}/${log.logId}`;
}

function logPath(dir) {
  return `${dir}/log.json`;
}

function entryPath(dir, entryId) {
  return `${dir}/entries/${entryId}.json`;
}

function imagePath(dir, entryId) {
  return `${dir}/images/${entryId}.png`;
}

/** Hash of an entry's text (no image data), as listed in log.json's entryFiles. */
export function entryHash(entry) {
  return hashHex(JSON.stringify(entry));
}

/**
 * A copy of `object` with key `from` replaced by `to` (set to `value`) in the same position, so
 * the log reads back with the same key order it was written with (logs are compared as JSON).
 */
function replaceKey(object, from, to, value) {
  const result = {};
  for (const [key, existing] of Object.entries(object)) {
    if (key === from) {
      result[to] = value;
    } else if (key !== to) {
      result[key] = existing;
    }
  }
  if (!(from in object)) result[to] = value;
  return result;
}

/** Whether a log.json is in the old layout, with every entry inside it. */
function isLegacyLogFile(json) {
  // An older version of the app syncing a new-layout log writes "entries" back (keeping a stale
  // "entryFiles"), so "entries" wins whenever it's there.
  return Array.isArray(json && json.entries);
}

/**
 * Reads a log's log.json and the entry files it lists. Entries whose hash matches one in `known`
 * (logs this computer already has, without images) are taken from there instead of downloaded.
 * Resolves null if there's no log.json, otherwise
 *   { sha, log, legacy, hashes: Map(entryId -> hash) of the entry files in the cloud }
 * An entry file that's missing is left out (another computer that has the entry will put it back).
 */
async function readCloudLog(client, dir, known = []) {
  const file = await client.getJsonFile(logPath(dir));
  if (!file) return null;

  const json = file.json || {};
  if (isLegacyLogFile(json)) {
    const log = { ...json };
    delete log.entryFiles;
    log.deletedEntries = log.deletedEntries || [];
    // Entry files left from before an older app rewrote it: all rewritten (no hash is trusted),
    // and any no longer in the log deleted.
    const stale = Array.isArray(json.entryFiles) ? json.entryFiles : [];
    return { sha: file.sha, log, legacy: true, hashes: new Map(stale.map((row) => [row.id, null])) };
  }

  const rows = Array.isArray(json.entryFiles) ? json.entryFiles : [];
  const knownByHash = new Map();
  for (const log of known) {
    for (const entry of (log && log.entries) || []) {
      knownByHash.set(`${entry.id}:${entryHash(entry)}`, entry);
    }
  }

  const entries = new Map();
  const missing = [];
  for (const row of rows) {
    const entry = knownByHash.get(`${row.id}:${row.hash}`);
    if (entry) {
      entries.set(row.id, clone(entry));
    } else {
      missing.push(row);
    }
  }

  await inBatches(missing, DOWNLOAD_CONCURRENCY, async (row) => {
    const entryFile = await client.getJsonFile(entryPath(dir, row.id));
    if (entryFile) {
      entries.set(row.id, entryFile.json);
    } else {
      console.warn(`Tuning log entry ${entryPath(dir, row.id)} is missing from the cloud`);
    }
  });

  const log = replaceKey(
    json,
    "entryFiles",
    "entries",
    rows.filter((row) => entries.has(row.id)).map((row) => entries.get(row.id)),
  );
  log.deletedEntries = log.deletedEntries || [];
  return { sha: file.sha, log, legacy: false, hashes: new Map(rows.map((row) => [row.id, row.hash])) };
}

/**
 * The files that store `log` (without images) in the new layout, given what the cloud has
 * (a readCloudLog result, or null): the entry files that changed, entry files to delete, and
 * log.json - in that order, so with the one-file-at-a-time fallback log.json never lists an entry
 * whose file isn't there yet.
 */
function logFiles(dir, log, cloud) {
  const files = [];
  const rows = [];
  for (const entry of log.entries || []) {
    const hash = entryHash(entry);
    rows.push({ id: entry.id, hash });
    if (!cloud || cloud.hashes.get(entry.id) !== hash) {
      files.push({ path: entryPath(dir, entry.id), text: JSON.stringify(entry, null, 2) });
    }
  }

  const ids = new Set(rows.map((row) => row.id));
  const deletes = cloud ? [...cloud.hashes.keys()].filter((id) => !ids.has(id)).map((id) => entryPath(dir, id)) : [];

  const logJson = replaceKey(log, "entries", "entryFiles", rows);
  files.push({ path: logPath(dir), text: JSON.stringify(logJson, null, 2) });

  return { files, deletes };
}

function dataUrlToBase64(dataUrl) {
  return String(dataUrl || "").replace(/^data:[^;]+;base64,/, "");
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function same(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function emptyIndex() {
  return { formatVersion: 1, crafts: {} };
}

function normaliseIndex(json) {
  const index = json && typeof json === "object" && !Array.isArray(json) ? json : emptyIndex();
  index.formatVersion = index.formatVersion || 1;
  if (!index.crafts || typeof index.crafts !== "object") index.crafts = {};
  return index;
}

/**
 * Reads index.json. Resolves an empty index if the repo doesn't have one yet.
 */
export async function fetchIndex(client) {
  const file = await client.getJsonFile(INDEX_PATH);
  return normaliseIndex(file && file.json);
}

/**
 * Records where a log lives and a summary of it, under its (current) craft - moving it there if it
 * was listed under another craft before. Modifies and returns `index`.
 */
export function setIndexRow(index, log, dir, updated) {
  for (const group of Object.values(index.crafts)) {
    if (group.logs && group.logs[log.logId]) {
      delete group.logs[log.logId];
    }
  }

  const key = craftKey(log.craftName);
  const group = index.crafts[key] || (index.crafts[key] = { craftName: log.craftName || "", logs: {} });
  group.logs = group.logs || {};
  if (log.craftName) group.craftName = log.craftName;

  group.logs[log.logId] = {
    name: log.name,
    craftName: log.craftName || "",
    path: dir,
    updated,
    entryCount: (log.entries || []).length,
  };

  for (const [otherKey, otherGroup] of Object.entries(index.crafts)) {
    if (!Object.keys(otherGroup.logs || {}).length) delete index.crafts[otherKey];
  }

  return index;
}

/**
 * Takes a log out of the index. Modifies `index`; resolves the removed row, or null if it wasn't
 * listed.
 */
export function removeIndexRow(index, logId) {
  for (const [key, group] of Object.entries(index.crafts)) {
    const row = group.logs && group.logs[logId];
    if (!row) continue;

    delete group.logs[logId];
    if (!Object.keys(group.logs).length) delete index.crafts[key];
    return row;
  }
  return null;
}

/**
 * Every log listed for a craft, most recently updated first:
 * [{ logId, name, craftName, path, updated, entryCount }]
 */
export function indexRowsForCraft(index, craftName) {
  const group = index.crafts[craftKey(craftName)];
  if (!group || !group.logs) return [];

  return Object.entries(group.logs)
    .map(([logId, row]) => ({ logId, ...row }))
    .sort((a, b) => String(b.updated || "").localeCompare(String(a.updated || "")));
}

function indexRowUpdated(index, logId) {
  for (const group of Object.values(index.crafts)) {
    const row = group.logs && group.logs[logId];
    if (row) return row.updated || null;
  }
  return null;
}

/**
 * Whether the cloud copy of a log (its row from indexRowsForCraft) has changed since this computer
 * was last in step with it. `summary` is this computer's tuning_log_db.js listLogs() summary.
 */
export function isNewerInCloud(row, summary) {
  if (!row || !row.updated || !summary.lastSyncedAt) return false;
  // Synced before cloudUpdated was recorded - fall back to comparing times (across computers'
  // clocks, so only roughly).
  if (!summary.cloudUpdated) return row.updated > summary.lastSyncedAt;
  return row.updated !== summary.cloudUpdated;
}

async function inBatches(items, limit, action) {
  for (let i = 0; i < items.length; i += limit) {
    await Promise.all(items.slice(i, i + limit).map(action));
  }
}

/**
 * Downloads the images of any entries that have one in the cloud but not locally, putting them on
 * the entries as data URLs. An image that can't be found is skipped (the entry keeps hasImage).
 */
async function downloadMissingImages(client, dir, log) {
  const missing = (log.entries || []).filter((entry) => entry.hasImage && !entry.image);

  await inBatches(missing, DOWNLOAD_CONCURRENCY, async (entry) => {
    const file = await client.getFileBase64(imagePath(dir, entry.id));
    if (file) {
      entry.image = `data:image/png;base64,${file.base64}`;
    }
  });
}

/**
 * Downloads a log listed in the index (a row from indexRowsForCraft), with its images. Resolves
 * { log, sync } ready to store locally as already in step with the cloud, or null if the log's
 * file is missing.
 */
export async function downloadLog(client, row) {
  const cloud = await readCloudLog(client, row.path);
  if (!cloud) return null;

  const log = cloud.log;
  await downloadMissingImages(client, row.path, log);

  const sync = markSynced({ pending: [] }, log, cloud.sha);
  sync.cloudDir = row.path;
  sync.cloudUpdated = row.updated || null;
  return { log, sync };
}

/**
 * Brings one log and its cloud copy into step. `local` and `sync` aren't modified.
 * Resolves { log, sync, uploaded, downloaded }: the merged log (with every image available
 * locally or in the cloud) and its new sync state, whether anything was committed, and whether
 * the cloud copy had anything new for this computer.
 * Throws a GitHubError if GitHub can't be reached or refuses the change.
 * onProgress(sentBytes, totalBytes), if given, follows the upload (see commitFiles).
 */
export async function syncLog(client, local, sync, { now = () => new Date().toISOString(), onProgress } = {}) {
  const dir = sync.cloudDir || defaultLogDir(local);

  for (let attempt = 1; ; attempt++) {
    // Entry files are only downloaded if log.json lists one this computer hasn't got.
    const cloud = await readCloudLog(client, dir, [sync.base, stripImages(local)]);
    const remote = cloud ? cloud.log : null;

    // It was in the cloud before and isn't now: deleted (see deleteLog) - don't bring it back.
    if (!cloud && sync.baseSha) {
      return { log: local, sync, uploaded: false, downloaded: false, deletedInCloud: true };
    }

    if (cloud && cloud.sha === sync.baseSha && !sync.pending.length && !cloud.legacy) {
      return { log: local, sync, uploaded: false, downloaded: false };
    }

    const merged = mergeLogs(sync.base, local, remote);
    const downloaded = !!remote && !same(stripImages(merged), stripImages(local));
    await downloadMissingImages(client, dir, merged);

    const mergedText = stripImages(merged);
    // An old-layout log.json is rewritten in the new layout even if nothing else changed.
    const needsUpload = !cloud || cloud.legacy || !same(mergedText, remote);

    if (!needsUpload) {
      const newSync = markSynced(clone(sync), merged, cloud.sha);
      newSync.cloudDir = dir;
      newSync.cloudUpdated = indexRowUpdated(await fetchIndex(client), local.logId);
      return { log: merged, sync: newSync, uploaded: false, downloaded };
    }

    const remoteImages = new Map(
      ((remote && remote.entries) || [])
        .filter((entry) => entry.hasImage)
        .map((entry) => [entry.id, entry.imageUpdatedAt || ""]),
    );
    const remoteImageIds = new Set(remoteImages.keys());
    const mergedIds = new Set(merged.entries.map((entry) => entry.id));

    // New images, plus any re-captured here since the cloud copy's was uploaded.
    const files = merged.entries
      .filter((entry) => entry.image && remoteImages.get(entry.id) !== (entry.imageUpdatedAt || ""))
      .map((entry) => ({ path: imagePath(dir, entry.id), base64: dataUrlToBase64(entry.image) }));

    const deletes = [...remoteImageIds].filter((id) => !mergedIds.has(id)).map((id) => imagePath(dir, id));

    const text = logFiles(dir, mergedText, cloud);
    files.push(...text.files);
    deletes.push(...text.deletes);

    const index = await fetchIndex(client);
    const updated = now();
    setIndexRow(index, merged, dir, updated);
    files.push({ path: INDEX_PATH, text: JSON.stringify(index, null, 2) });

    let result;
    try {
      result = await client.commitFiles({
        files,
        deletes,
        onProgress,
        message: `Tuning log "${merged.name}" (${merged.craftName || "unnamed craft"})`,
      });
    } catch (error) {
      if (error.isConflict && attempt < MAX_ATTEMPTS) continue;
      throw error;
    }

    const newSync = markSynced(clone(sync), merged, result.shas[logPath(dir)]);
    newSync.cloudDir = dir;
    newSync.cloudUpdated = updated;
    return { log: merged, sync: newSync, uploaded: true, downloaded };
  }
}

/**
 * Deletes a log from the repo - its index row, log.json and images - in one commit. `fallbackDir`
 * (this computer's sync.cloudDir) is used if the index doesn't list the log. Resolves whether
 * there was anything to delete. Throws a GitHubError if GitHub can't be reached or refuses.
 */
export async function deleteLog(client, logId, fallbackDir = null) {
  for (let attempt = 1; ; attempt++) {
    const index = await fetchIndex(client);
    const row = removeIndexRow(index, logId);
    const dir = (row && row.path) || fallbackDir;

    const deletes = [];
    const logFile = dir ? await client.getJsonFile(logPath(dir)) : null;
    if (logFile) {
      const json = logFile.json || {};
      for (const entry of json.entries || []) {
        if (entry.hasImage) deletes.push(imagePath(dir, entry.id));
      }
      // log.json doesn't say which entries have images - deleting one that isn't there is skipped.
      for (const row of json.entryFiles || []) {
        deletes.push(entryPath(dir, row.id), imagePath(dir, row.id));
      }
      deletes.push(logPath(dir));
    }

    // Index first: with the one-file-at-a-time fallback, nothing is left pointing at deleted files.
    const files = row ? [{ path: INDEX_PATH, text: JSON.stringify(index, null, 2) }] : [];
    if (!files.length && !deletes.length) return false;

    const name = (row && row.name) || (logFile && logFile.json && logFile.json.name) || logId;
    try {
      await client.commitFiles({ files, deletes: [...new Set(deletes)], message: `Delete tuning log "${name}"` });
      return true;
    } catch (error) {
      if (error.isConflict && attempt < MAX_ATTEMPTS) continue;
      throw error;
    }
  }
}

/**
 * Rewrites every log in the repo that's still in the old layout (all entries inside log.json) in
 * the new one, one commit per log. Logs are left where they are and index.json is unchanged; other
 * computers pick up the new layout on their next sync without downloading anything new.
 * onProgress(done, total), if given, is called after each log. Resolves { migrated, total }.
 * Throws a GitHubError if GitHub can't be reached or refuses.
 */
export async function migrateLegacyLogs(client, { onProgress } = {}) {
  const rows = Object.values((await fetchIndex(client)).crafts).flatMap((group) =>
    Object.entries(group.logs || {}).map(([logId, row]) => ({ logId, ...row })),
  );

  let migrated = 0;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    for (let attempt = 1; ; attempt++) {
      const cloud = await readCloudLog(client, row.path);
      if (!cloud || !cloud.legacy) break;

      const { files, deletes } = logFiles(row.path, cloud.log, cloud);
      try {
        await client.commitFiles({ files, deletes, message: `Tuning log "${row.name}": one file per entry` });
        migrated++;
        break;
      } catch (error) {
        if (error.isConflict && attempt < MAX_ATTEMPTS) continue;
        throw error;
      }
    }
    if (onProgress) onProgress(i + 1, rows.length);
  }

  return { migrated, total: rows.length };
}
