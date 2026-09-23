// Keeps Tuning Logs in a GitHub repo (see github_client.js), laid out so the app only ever
// downloads what it needs:
//
//   index.json                                  every log in the repo, grouped by craft - the only
//                                               file read to find a heli's logs
//   crafts/<craft-key>/<logId>/log.json         one log's text: entries, notes, AI conversations
//   crafts/<craft-key>/<logId>/images/<id>.png  one step response graph per entry, written once
//
// A log's folder is fixed when it's first uploaded (sync.cloudDir), so it stays put even if the
// log is later re-linked to a different craft name - index.json always says where each log is.
//
// syncLog() is the whole round trip for one log: read the cloud copy, three-way merge it with the
// local one (tuning_log_sync.js), download any images this computer doesn't have yet, and - if the
// cloud copy is missing anything - commit new images, log.json and index.json together. If another
// computer commits in between, it re-reads, re-merges and tries again.

import { craftKey, mergeLogs, markSynced, stripImages } from "./tuning_log_sync.js";

export const INDEX_PATH = "index.json";
const MAX_ATTEMPTS = 3;
const DOWNLOAD_CONCURRENCY = 4;

export function defaultLogDir(log) {
  return `crafts/${craftKey(log.craftName)}/${log.logId}`;
}

function logPath(dir) {
  return `${dir}/log.json`;
}

function imagePath(dir, entryId) {
  return `${dir}/images/${entryId}.png`;
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
  const file = await client.getJsonFile(logPath(row.path));
  if (!file) return null;

  const log = file.json;
  log.entries = log.entries || [];
  log.deletedEntries = log.deletedEntries || [];
  await downloadMissingImages(client, row.path, log);

  const sync = markSynced({ pending: [] }, log, file.sha);
  sync.cloudDir = row.path;
  return { log, sync };
}

/**
 * Brings one log and its cloud copy into step. `local` and `sync` aren't modified.
 * Resolves { log, sync, uploaded, downloaded }: the merged log (with every image available
 * locally or in the cloud) and its new sync state, whether anything was committed, and whether
 * the cloud copy had anything new for this computer.
 * Throws a GitHubError if GitHub can't be reached or refuses the change.
 */
export async function syncLog(client, local, sync, { now = () => new Date().toISOString() } = {}) {
  const dir = sync.cloudDir || defaultLogDir(local);

  for (let attempt = 1; ; attempt++) {
    const remoteFile = await client.getJsonFile(logPath(dir));
    const remote = remoteFile ? remoteFile.json : null;

    // It was in the cloud before and isn't now: deleted (see deleteLog) - don't bring it back.
    if (!remoteFile && sync.baseSha) {
      return { log: local, sync, uploaded: false, downloaded: false, deletedInCloud: true };
    }

    if (remoteFile && remoteFile.sha === sync.baseSha && !sync.pending.length) {
      return { log: local, sync, uploaded: false, downloaded: false };
    }

    const merged = mergeLogs(sync.base, local, remote);
    const downloaded = !!remote && !same(stripImages(merged), stripImages(local));
    await downloadMissingImages(client, dir, merged);

    const mergedText = stripImages(merged);
    const needsUpload = !remote || !same(mergedText, remote);

    if (!needsUpload) {
      const newSync = markSynced(clone(sync), merged, remoteFile.sha);
      newSync.cloudDir = dir;
      return { log: merged, sync: newSync, uploaded: false, downloaded };
    }

    const remoteImageIds = new Set(
      ((remote && remote.entries) || []).filter((entry) => entry.hasImage).map((entry) => entry.id),
    );
    const mergedIds = new Set(merged.entries.map((entry) => entry.id));

    const files = merged.entries
      .filter((entry) => entry.image && !remoteImageIds.has(entry.id))
      .map((entry) => ({ path: imagePath(dir, entry.id), base64: dataUrlToBase64(entry.image) }));

    const deletes = [...remoteImageIds].filter((id) => !mergedIds.has(id)).map((id) => imagePath(dir, id));

    files.push({ path: logPath(dir), text: JSON.stringify(mergedText, null, 2) });

    const index = await fetchIndex(client);
    setIndexRow(index, merged, dir, now());
    files.push({ path: INDEX_PATH, text: JSON.stringify(index, null, 2) });

    let result;
    try {
      result = await client.commitFiles({
        files,
        deletes,
        message: `Tuning log "${merged.name}" (${merged.craftName || "unnamed craft"})`,
      });
    } catch (error) {
      if (error.isConflict && attempt < MAX_ATTEMPTS) continue;
      throw error;
    }

    const newSync = markSynced(clone(sync), merged, result.shas[logPath(dir)]);
    newSync.cloudDir = dir;
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
      for (const entry of (logFile.json && logFile.json.entries) || []) {
        if (entry.hasImage) deletes.push(imagePath(dir, entry.id));
      }
      deletes.push(logPath(dir));
    }

    // Index first: with the one-file-at-a-time fallback, nothing is left pointing at deleted files.
    const files = row ? [{ path: INDEX_PATH, text: JSON.stringify(index, null, 2) }] : [];
    if (!files.length && !deletes.length) return false;

    const name = (row && row.name) || (logFile && logFile.json && logFile.json.name) || logId;
    try {
      await client.commitFiles({ files, deletes, message: `Delete tuning log "${name}"` });
      return true;
    } catch (error) {
      if (error.isConflict && attempt < MAX_ATTEMPTS) continue;
      throw error;
    }
  }
}
