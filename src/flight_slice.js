// A "flight slice": a compact, downsampled snapshot of the isolated block of the flight log
// (Ctrl+I / Ctrl+O - see isolation.js), holding only the fields the current workspace is showing.
// It's built on demand from the Tuning Log, saved on the entry (so it survives the flight log
// being closed, and syncs like notes do), and sent to the AI as CSV text alongside the step
// response image.
//
// Raw blackbox data is far too big to send as-is (4 kHz x a dozen fields is millions of tokens
// for a short flight), so each field is averaged into buckets at the chosen sample rate - a crude
// low-pass that keeps tracking behaviour (setpoint vs gyro, bounce-back, windup) readable without
// aliasing high-frequency noise into nonsense.

import { FlightLogParser } from "./flightlog_parser.js";
import { FlightLogFieldPresenter } from "./flightlog_fields_presenter.js";

export const FLIGHT_SLICE_SAMPLE_RATES = [25, 50, 100, 200, 250, 500, 1000];
export const DEFAULT_FLIGHT_SLICE_SAMPLE_RATE = 100;
// Refuse to build a slice bigger than this many rows - roughly 200k+ tokens with a typical field
// count, already well past what's sensible to send in one request.
export const FLIGHT_SLICE_MAX_ROWS = 20000;
// Prefix on the text block a slice is sent in, so the Tuning Log can recognise it in a stored
// conversation and show a badge instead of a wall of CSV.
export const FLIGHT_SLICE_MARKER = "[Isolated flight data]";

const TIME_INDEX = FlightLogParser.prototype.FLIGHT_LOG_FIELD_INDEX_TIME;

/**
 * Splits a presenter-formatted value such as "-12.5 °/s", "45.00 %" or "3000 rpm (50.0 Hz)" into
 * its number and unit. Returns null for values that aren't a leading number (flags, enums).
 */
export function parseFriendlyValue(text) {
  const match = /^\s*(-?\d+(?:\.\d+)?)\s*(.*)$/.exec(String(text ?? ""));
  if (!match) return null;
  // Drop any secondary reading after the main unit, e.g. "rpm (50.0 Hz)" or "rpm / 12.3 hz"
  const unit = match[2].replace(/\s+[(/].*$/, "").trim();
  return { value: Number(match[1]), unit };
}

function round(value) {
  return Number(value.toFixed(Math.abs(value) >= 100 ? 1 : 2));
}

function csvCell(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "number") return String(value);
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/**
 * The fields to include: every visible (not eye-toggled-off) field of the workspace's graphs that
 * exists in this log, de-duplicated by field name.
 *
 * graphs: [{ label, fields: [{ name, friendlyName, hidden }] }] - e.g. graphStore.legendGraphs.
 */
export function selectSliceFields(graphs, flightLog) {
  const seen = new Set();
  const fields = [];

  for (const graph of graphs || []) {
    for (const field of graph.fields || []) {
      if (field.hidden || seen.has(field.name)) continue;
      const index = flightLog.getMainFieldIndexByName(field.name);
      if (index === undefined) continue;
      seen.add(field.name);
      fields.push({ graph: graph.label || "", name: field.name, label: field.friendlyName || field.name, index });
    }
  }

  return fields;
}

/**
 * Builds a slice of the flight log between range.start and range.end (blackbox microseconds).
 *
 * options: { flightLog, range: { start, end }, graphs, sampleRateHz, workspace, decode }
 * decode(fieldName, rawValue) -> display string, defaults to FlightLogFieldPresenter (the same
 * formatting the legend uses) - overridable for tests.
 *
 * Throws an Error with a user-facing message if the slice can't be built.
 */
export function buildFlightSlice(options) {
  const { flightLog, range } = options;
  const sampleRateHz = options.sampleRateHz || DEFAULT_FLIGHT_SLICE_SAMPLE_RATE;
  const decode =
    options.decode || ((name, raw) => FlightLogFieldPresenter.decodeFieldToFriendly(flightLog, name, raw));

  if (!range || !(range.end > range.start)) {
    throw new Error("No isolated block is set - mark one with Ctrl+I and Ctrl+O first.");
  }

  const fields = selectSliceFields(options.graphs, flightLog);
  if (!fields.length) {
    throw new Error("The current workspace isn't showing any fields from this log.");
  }

  const bucketUs = 1e6 / sampleRateHz;
  const rowCount = Math.ceil((range.end - range.start) / bucketUs);
  if (rowCount > FLIGHT_SLICE_MAX_ROWS) {
    throw new Error(
      `That would be ${rowCount} rows - lower the sample rate or isolate a shorter block (max ${FLIGHT_SLICE_MAX_ROWS}).`,
    );
  }

  // Per bucket, per field: running sum + count (numeric fields), or the last raw value (others)
  const sums = fields.map(() => new Float64Array(rowCount));
  const counts = fields.map(() => new Uint32Array(rowCount));
  const lastRaw = fields.map(() => new Array(rowCount));

  for (const chunk of flightLog.getChunksInTimeRange(range.start, range.end)) {
    for (const frame of chunk.frames) {
      const time = frame[TIME_INDEX];
      if (time < range.start || time >= range.end) continue;
      const bucket = Math.floor((time - range.start) / bucketUs);

      fields.forEach((field, f) => {
        const raw = frame[field.index];
        if (typeof raw !== "number" || Number.isNaN(raw)) return;
        sums[f][bucket] += raw;
        counts[f][bucket]++;
        lastRaw[f][bucket] = raw;
      });
    }
  }

  // Work out each field's unit, and whether it decodes to a number at all (flags/enums don't, so
  // they're reported as their last text value per bucket rather than averaged)
  fields.forEach((field, f) => {
    const sample = lastRaw[f].find((raw) => raw !== undefined);
    const parsed = sample === undefined ? null : parseFriendlyValue(decode(field.name, sample));
    field.numeric = sample === undefined || parsed !== null;
    field.unit = parsed?.unit || "";
  });

  const rows = [];
  for (let b = 0; b < rowCount; b++) {
    if (fields.every((_, f) => counts[f][b] === 0)) continue; // logging gap
    const row = [round((b * bucketUs) / 1000)];
    fields.forEach((field, f) => {
      if (counts[f][b] === 0) {
        row.push(null);
      } else if (field.numeric) {
        const parsed = parseFriendlyValue(decode(field.name, sums[f][b] / counts[f][b]));
        row.push(parsed ? round(parsed.value) : null);
      } else {
        row.push(decode(field.name, lastRaw[f][b]));
      }
    });
    rows.push(row);
  }

  if (!rows.length) {
    throw new Error("There's no logged data in the isolated block.");
  }

  const stats = {};
  fields.forEach((field, f) => {
    if (!field.numeric) return;
    const values = rows.map((row) => row[f + 1]).filter((v) => typeof v === "number");
    if (!values.length) return;
    let min = Infinity;
    let max = -Infinity;
    let sum = 0;
    let sumSq = 0;
    for (const v of values) {
      if (v < min) min = v;
      if (v > max) max = v;
      sum += v;
      sumSq += v * v;
    }
    stats[field.name] = { min, max, mean: round(sum / values.length), rms: round(Math.sqrt(sumSq / values.length)) };
  });

  const header = ["t_ms", ...fields.map((field) => field.name)];
  const csv = [header, ...rows].map((row) => row.map(csvCell).join(",")).join("\n");

  return {
    capturedAt: new Date().toISOString(),
    workspace: options.workspace || "",
    range: { start: range.start, end: range.end, offsetMs: round((range.start - flightLog.getMinTime()) / 1000) },
    durationMs: round((range.end - range.start) / 1000),
    sampleRateHz,
    rowCount: rows.length,
    fields: fields.map(({ graph, name, label, unit }) => ({ graph, name, label, unit })),
    stats,
    csv,
  };
}

function describeFields(slice) {
  return slice.fields
    .map((field) => `- ${field.name}: ${field.label}${field.graph ? ` (${field.graph} graph)` : ""}${field.unit ? `, ${field.unit}` : ""}`)
    .join("\n");
}

function sliceHeading(slice) {
  const seconds = (slice.durationMs / 1000).toFixed(1);
  const start = (slice.range.offsetMs / 1000).toFixed(1);
  return (
    `${FLIGHT_SLICE_MARKER} ${seconds} s isolated from ${start} s into the log` +
    `${slice.workspace ? `, "${slice.workspace}" workspace` : ""}, averaged to ${slice.sampleRateHz} Hz`
  );
}

/**
 * The full text block sent to the AI: what the data is, a field legend, and the CSV.
 */
export function sliceToPromptText(slice) {
  return (
    `${sliceHeading(slice)}.\n\n` +
    "The user isolated this block of the flight to focus the analysis on it. Each row averages the " +
    `raw blackbox samples over a 1/${slice.sampleRateHz} s window (t_ms is the window start, ` +
    "relative to the start of the block); empty cells mean nothing was logged in that window.\n\n" +
    `Fields:\n${describeFields(slice)}\n\n` +
    `\`\`\`csv\n${slice.csv}\n\`\`\``
  );
}

/**
 * A short stats-only summary of a slice, for history entries where resending the CSV would cost
 * too many tokens.
 */
export function sliceToSummaryText(slice) {
  const lines = slice.fields
    .filter((field) => slice.stats[field.name])
    .map((field) => {
      const s = slice.stats[field.name];
      const unit = field.unit ? ` ${field.unit}` : "";
      return `- ${field.label}: min ${s.min}, max ${s.max}, mean ${s.mean}, rms ${s.rms}${unit}`;
    });
  return `${sliceHeading(slice)} (raw data omitted to save tokens):\n${lines.join("\n")}`;
}

export function isFlightSliceText(text) {
  return String(text ?? "").startsWith(FLIGHT_SLICE_MARKER);
}

/**
 * Rough token estimate (~3.5 characters per token for numeric CSV) for showing the cost of
 * attaching a slice before it's sent.
 */
export function estimateSliceTokens(slice) {
  return Math.round(sliceToPromptText(slice).length / 3.5);
}
