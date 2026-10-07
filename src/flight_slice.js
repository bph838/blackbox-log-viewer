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

export const FLIGHT_SLICE_SAMPLE_RATES = [ 250, 500, 1000];
export const DEFAULT_FLIGHT_SLICE_SAMPLE_RATE = 500;
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
 * How the main graph draws a field - its colour, curve (display-unit range + expo) and smoothing
 * radius in us - kept on the slice so the Tuning Log can redraw it the same way. Only what's set.
 */
function displaySettings(field) {
  const settings = {};
  if (field.color) settings.color = field.color;
  const minMax = field.curve?.MinMax;
  if (minMax && Number.isFinite(minMax.min) && Number.isFinite(minMax.max) && minMax.max > minMax.min) {
    settings.curve = { min: minMax.min, max: minMax.max, power: field.curve.power ?? 1, steps: field.curve.steps };
  }
  if (field.smoothing > 0) settings.smoothing = field.smoothing;
  return settings;
}

/**
 * The fields to include: every visible (not eye-toggled-off) field of the workspace's graphs that
 * exists in this log, de-duplicated by field name.
 *
 * graphs: [{ label, height, fields: [{ name, friendlyName, hidden, color, curve, smoothing }] }] - e.g.
 * the active graph config's getGraphs(). Everything after hidden is optional.
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
      fields.push({
        graph: graph.label || "",
        name: field.name,
        label: field.friendlyName || field.name,
        index,
        ...displaySettings(field),
      });
    }
  }

  return fields;
}

// The graphs the slice's fields come from, in order, with their relative heights
function sliceGraphs(graphs, fields) {
  const used = new Set(fields.map((field) => field.graph));
  return (graphs || [])
    .filter((graph) => used.has(graph.label || ""))
    .map((graph) => ({ label: graph.label || "", height: graph.height > 0 ? graph.height : 1 }));
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
    // color/curve/smoothing (and graphs' heights) are how the main graph draws them, kept so the
    // Tuning Log can redraw the slice to match
    fields: fields.map(({ graph, name, label, unit, color, curve, smoothing }) => ({
      graph,
      name,
      label,
      unit,
      ...(color ? { color } : {}),
      ...(curve ? { curve } : {}),
      ...(smoothing ? { smoothing } : {}),
    })),
    graphs: sliceGraphs(options.graphs, fields),
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

const HEADING_RE = new RegExp(
  `^${FLIGHT_SLICE_MARKER.replace(/[[\]]/g, "\\$&")} (-?[\\d.]+) s isolated from (-?[\\d.]+) s into the log` +
    `(?:, "(.*)" workspace)?, averaged to (\\d+) Hz`,
);
const FIELD_LINE_RE = /^- (.+?): (.*?)(?: \((.*) graph\))?(?:, ([^,]*))?$/;

/**
 * Reads a slice back out of the text block it was sent to the AI in (sliceToPromptText), so a
 * conversation can show each slice where it was sent, even after the entry's slice has been
 * replaced. Returns a slice-like object ({ durationMs, range: { offsetMs }, sampleRateHz,
 * workspace, fields, csv }) for parseSliceSeries, or null if the text isn't a full slice.
 * How the fields were drawn (colours etc.) isn't in the text - see mergeSliceDisplay.
 */
export function parseSlicePromptText(text) {
  text = String(text ?? "");
  const heading = HEADING_RE.exec(text);
  const csv = /```csv\n([\s\S]*?)\n```/.exec(text);
  if (!heading || !csv) return null;

  const fields = [];
  const legend = /\nFields:\n([\s\S]*?)\n\n/.exec(text);
  for (const line of legend ? legend[1].split("\n") : []) {
    const match = FIELD_LINE_RE.exec(line);
    if (match) fields.push({ name: match[1], label: match[2], graph: match[3] || "", unit: match[4] || "" });
  }

  return {
    durationMs: Number(heading[1]) * 1000,
    range: { offsetMs: Number(heading[2]) * 1000 },
    workspace: heading[3] || "",
    sampleRateHz: Number(heading[4]),
    fields,
    csv: csv[1],
  };
}

/**
 * Copies how fields are drawn (colour, curve, smoothing, graph heights) onto a parsed slice from
 * another slice (e.g. the entry's saved one) wherever the field and graph names match.
 */
export function mergeSliceDisplay(slice, source) {
  if (!source?.fields?.length) return slice;
  const byName = new Map(source.fields.map((field) => [field.name, field]));
  const fields = slice.fields.map((field) => {
    const from = byName.get(field.name);
    if (!from) return field;
    const { color, curve, smoothing } = from;
    return { ...field, ...(color ? { color } : {}), ...(curve ? { curve } : {}), ...(smoothing ? { smoothing } : {}) };
  });
  const used = new Set(fields.map((field) => field.graph));
  const graphs = (source.graphs || []).filter((graph) => used.has(graph.label));
  return { ...slice, fields, ...(graphs.length ? { graphs } : {}) };
}

// Splits one CSV line as written by csvCell - only text cells are ever quoted
function parseCsvLine(line) {
  const cells = [];
  let i = 0;
  while (i <= line.length) {
    if (line[i] === '"') {
      let text = "";
      i++;
      while (i < line.length) {
        if (line[i] === '"' && line[i + 1] === '"') {
          text += '"';
          i += 2;
        } else if (line[i] === '"') {
          i++;
          break;
        } else {
          text += line[i++];
        }
      }
      cells.push(text);
      i++; // the comma
    } else {
      const end = line.indexOf(",", i);
      cells.push(line.slice(i, end === -1 ? line.length : end));
      i = end === -1 ? line.length + 1 : end + 1;
    }
  }
  return cells;
}

/**
 * The numeric series of a slice, read back from its CSV, for drawing it in the Tuning Log.
 * Returns { times, series: [{ name, label, graph, unit, color, values }] } - times in ms from the
 * block start, values aligned to times with null for gaps. Non-numeric fields are left out.
 */
export function parseSliceSeries(slice) {
  const lines = String(slice?.csv ?? "").split("\n").filter(Boolean);
  if (lines.length < 2) return { times: [], series: [] };

  const header = parseCsvLine(lines[0]);
  const fieldsByName = new Map((slice.fields || []).map((field) => [field.name, field]));
  const columns = header.slice(1).map((name) => ({ name, field: fieldsByName.get(name), values: [] }));
  const times = [];

  for (const line of lines.slice(1)) {
    const cells = parseCsvLine(line);
    times.push(Number(cells[0]));
    columns.forEach((column, c) => {
      const cell = cells[c + 1];
      const value = cell === "" || cell === undefined ? null : Number(cell);
      column.values.push(Number.isFinite(value) ? value : null);
    });
  }

  const series = columns
    // A text column (flags, enums) parses to all nulls
    .filter((column) => column.values.some((value) => value !== null))
    .map(({ name, field, values }) => ({
      name,
      label: field?.label || name,
      graph: field?.graph || "",
      unit: field?.unit || "",
      color: field?.color || null,
      curve: field?.curve || null,
      smoothing: field?.smoothing || 0,
      values,
    }));

  return { times, series };
}

/**
 * Centred moving average over +/- radiusMs, like the main graph's field smoothing (whose radius
 * is in us). Nulls are skipped and stay null. times must be ascending.
 */
export function smoothSeries(times, values, radiusMs) {
  if (!(radiusMs > 0)) return values;
  const out = new Array(values.length).fill(null);
  let lo = 0;
  let hi = 0;
  let sum = 0;
  let count = 0;
  for (let i = 0; i < times.length; i++) {
    while (hi < times.length && times[hi] <= times[i] + radiusMs) {
      if (values[hi] !== null) {
        sum += values[hi];
        count++;
      }
      hi++;
    }
    while (times[lo] < times[i] - radiusMs) {
      if (values[lo] !== null) {
        sum -= values[lo];
        count--;
      }
      lo++;
    }
    if (values[i] !== null && count) out[i] = sum / count;
  }
  return out;
}

/**
 * Reduces a series to at most ~2 x buckets points, keeping each bucket's min and max (in time
 * order) so spikes and peaks survive. Returns [{ t, v }]; null values are dropped.
 */
export function decimateMinMax(times, values, buckets) {
  const points = [];
  for (let i = 0; i < times.length; i++) {
    if (values[i] !== null) points.push({ t: times[i], v: values[i] });
  }
  if (points.length <= buckets * 2 || buckets < 1) return points;

  const size = points.length / buckets;
  const out = [];
  for (let b = 0; b < buckets; b++) {
    const from = Math.floor(b * size);
    const to = Math.min(points.length, Math.floor((b + 1) * size));
    let min = points[from];
    let max = points[from];
    for (let i = from + 1; i < to; i++) {
      if (points[i].v < min.v) min = points[i];
      if (points[i].v > max.v) max = points[i];
    }
    if (min === max) out.push(min);
    else if (min.t <= max.t) out.push(min, max);
    else out.push(max, min);
  }
  return out;
}

/**
 * Rough token estimate (~3.5 characters per token for numeric CSV) for showing the cost of
 * attaching a slice before it's sent.
 */
export function estimateSliceTokens(slice) {
  return Math.round(sliceToPromptText(slice).length / 3.5);
}
