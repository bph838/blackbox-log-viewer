// Model for a "Tuning Log": a JSON-serializable history of step response captures (image +
// flight log configuration + notes) for a craft, so changes can be tracked over time and replayed
// as context for AI tuning advice.
// Ported from https://github.com/bph838/rotorflight-blackbox-bellsandwhistles (js/tuning_log.js).
// That version ran under NW.js and persisted itself directly to a file on disk (Node `fs`/
// `crypto`); this app is a plain browser SPA, so persistence instead lives in
// stores/tuningLog.js (localStorage, with explicit export/import) and hashing uses a small
// dependency-free function instead of Node's `crypto` module - the id only needs to be stable and
// collision-resistant for local de-duplication, not cryptographically secure.

function pad2(n) {
  return (n < 10 ? "0" : "") + n;
}

/**
 * A small, fast, deterministic string hash (cyrb53), returned as a fixed-length hex string.
 * Stands in for the original's `md5(text)` - only used as a stable local id, never for anything
 * security-sensitive.
 */
function hashHex(text) {
  let h1 = 0xdeadbeef ^ 0;
  let h2 = 0x41c6ce57 ^ 0;

  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }

  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);

  const hi = (h2 >>> 0).toString(16).padStart(8, "0");
  const lo = (h1 >>> 0).toString(16).padStart(8, "0");
  return hi + lo;
}

/**
 * `logIndex`/`logCount` identify which sub-log within a multi-log BBL file this id is for. A
 * timestamp alone isn't always unique across sub-logs of the same file - e.g. a flight controller
 * without an RTC reports the same placeholder "Log start datetime" for every sub-log, so
 * resolveLogDateTimes() below estimates the same date/time for a run of them. When there's
 * more than one log in the file, fold the log's index into the id so each sub-log still gets a
 * distinct, stable id even when their timestamps collide; a single-log file keeps the plain
 * timestamp-only id (unaffected by whatever index that one log happens to have).
 */
export function makeId(timestampIso, logIndex, logCount) {
  const key = logCount > 1 ? `${timestampIso}|${logIndex}` : String(timestampIso);
  return hashHex(key);
}

export function create(name, craftName) {
  const createdDate = new Date().toISOString();

  return {
    formatVersion: 1,
    logId: hashHex(`${name || ""}|${createdDate}`),
    name: name || craftName || "Tuning Log",
    craftName: craftName || "",
    createdDate,
    entries: [],
  };
}

/**
 * Flattens a flight log's system configuration (PID gains, filters, rates, etc.) into a readable
 * text block, both for display and as context given to the AI.
 */
export function buildConfigSummary(sysConfig) {
  const lines = [];
  const keys = Object.keys(sysConfig || {}).sort();

  for (const key of keys) {
    const value = sysConfig[key];

    if (value === null || value === undefined || typeof value === "function") {
      continue;
    }

    try {
      lines.push(`${key}: ${JSON.stringify(value)}`);
    } catch {
      // Skip values that can't be serialized
    }
  }

  return lines.join("\n");
}

/**
 * Read and validate a flight log's own "Log start datetime" header in isolation, with no
 * fallback - use this when a made-up substitute (see resolveLogDateTimes() below) would be
 * misleading, e.g. showing several distinct recordings as if they happened at the same instant.
 *
 * Flight controllers without an RTC report the header as "0000-01-01T00:00:00.000+00:00" instead
 * of omitting it, which parses as a valid (but useless) Date - treated as absent here too.
 */
export function parseLogStartDateTime(sysConfig) {
  const raw = sysConfig && sysConfig["Log start datetime"];

  if (raw) {
    const parsed = new Date(raw);
    if (!Number.isNaN(parsed.getTime()) && parsed.getUTCFullYear() >= 2000) {
      return parsed.toISOString();
    }
  }

  return null;
}

/**
 * Estimates a start date/time for every sub-log in a BBL file, including ones whose own header
 * lacks a valid "Log start datetime" (see parseLogStartDateTime) - e.g. a flight controller with
 * no RTC reports the same useless placeholder for every sub-log it writes, so on their own they
 * can't be told apart or placed in time at all.
 *
 * Walks the sub-logs in file order, tracking a running "cursor" time: a sub-log with a known start
 * time is trusted outright and resets the cursor to (its own start + its own duration) for the
 * next sub-log; one with no known start time instead takes the current cursor as its *estimated*
 * start (flagged `isCalculated: true`) and then advances the cursor by its own duration anyway -
 * so a run of several unknown sub-logs in a row still increments forward through each of their
 * durations rather than collapsing onto the same instant. Before the first known sub-log (or if
 * the file has none at all), the cursor starts from `fallbackIso` - typically the flight log
 * file's own `lastModified` time (epoch ms, from the browser `File` object - see
 * appStore.logFileLastModified), since that's stable across copying the file (unlike a "created"
 * time, which would reset to "now" when the file is copied off an SD card).
 *
 * `logs`: per sub-log `{ startDateTime: isoString|null, durationMs: number }`, in file order.
 * Returns a same-length/order array of `{ dateTime: isoString|null, isCalculated: boolean }`.
 */
export function resolveLogDateTimes(logs, fallbackIso) {
  let cursor = fallbackIso || null;
  const results = [];

  for (const log of logs) {
    if (log.startDateTime) {
      results.push({ dateTime: log.startDateTime, isCalculated: false });
      cursor = addMs(log.startDateTime, log.durationMs);
    } else {
      results.push({ dateTime: cursor, isCalculated: true });
      cursor = cursor ? addMs(cursor, log.durationMs) : null;
    }
  }

  return results;
}

function addMs(iso, ms) {
  const time = new Date(iso).getTime();
  if (Number.isNaN(time)) {
    return null;
  }

  return new Date(time + (ms || 0)).toISOString();
}

/**
 * options: { image, config, notes, craftName, timestamp, calculatedDateTime, logIndex, logCount }
 */
export function addEntry(log, options) {
  const timestamp = options.timestamp || new Date().toISOString();

  const entry = {
    id: makeId(timestamp, options.logIndex, options.logCount),
    timestamp,
    craftName: options.craftName || "",
    image: options.image,
    config: options.config || "",
    notes: options.notes || "",
  };

  // Persisted on the entry itself (rather than re-derived from the timestamp later) so the
  // "Approximated Datetime" badge still shows correctly for a past entry after its originating flight
  // log file is no longer open - see resolveLogDateTimes() above.
  if (options.calculatedDateTime) {
    entry.calculatedDateTime = true;
  }

  if (options.ai) {
    entry.ai = options.ai;
  }

  log.entries.push(entry);

  return entry;
}

export function buildFilename(log) {
  const now = new Date();
  const stamp = `${now.getFullYear()}${pad2(now.getMonth() + 1)}${pad2(now.getDate())}_${pad2(now.getHours())}${pad2(now.getMinutes())}${pad2(now.getSeconds())}`;

  const safeName = (log.name || "TuningLog").replace(/[^a-z0-9_-]+/gi, "_");

  return `RF_TUNING_LOG_${safeName}_${stamp}.json`;
}

/**
 * Returns an error message if `log` doesn't look like a tuning log file, or null if it's fine to
 * use. Guards against a user picking an unrelated JSON file (or a corrupted one) via Import -
 * without this, e.g. a `null` or non-object `entries` element would later throw when code
 * elsewhere dereferences it directly.
 */
export function validationError(log) {
  if (!log || typeof log !== "object" || Array.isArray(log)) {
    return "This file is not a tuning log.";
  }

  if (typeof log.formatVersion !== "number") {
    return "This file is not a tuning log.";
  }

  if (log.entries !== undefined) {
    if (!Array.isArray(log.entries)) {
      return 'This file is not a tuning log (its "entries" field is malformed).';
    }

    for (const entry of log.entries) {
      if (!entry || typeof entry !== "object") {
        return 'This file is not a tuning log (its "entries" field is malformed).';
      }
    }
  }

  return null;
}
