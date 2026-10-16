// Compact text summaries of a log for the AI Filters conversation. Raw gyro samples are far too
// large to send, so Claude gets what it needs to choose filters: the current settings, the noise
// peaks per axis (with their likely source), the noise floor, rotor speeds/harmonics, loop rates,
// and - after a config has been applied - how Imagine says it performed.
//
// Everything here is pure (no store, no DOM) so it can be tested and sized offline.

import { bandRms, welchPsd } from "../analysis.js";
import { settingsToCli } from "../header_settings.js";
import { resolveRpmBanks, rpmSourceName } from "../filters/rpm_filter.js";
import { describeAxisNotches } from "./filter_tool.js";

export const AXES = ["roll", "pitch", "yaw"];
const PSD_SEGMENT = 1024;
const MAX_PEAKS = 8;
const PEAK_MIN_HZ = 5;
const PEAK_HALF_WIDTH_HZ = 1.5; // a peak is the highest point within ±1.5 Hz
const FLOOR_HALF_WIDTH_HZ = 12; // local floor: median within ±12 Hz around the peak
const PEAK_MIN_PROMINENCE_DB = 6;
const SUMMARY_BANDS = [
  [5, 20],
  [20, 50],
  [50, 100],
  [100, 150],
  [150, 200],
  [200, 250],
  [250, 500],
];

const db10 = (x) => (x > 0 ? 10 * Math.log10(x) : -Infinity);
const fmt = (x, d = 1) => (Number.isFinite(x) ? x.toFixed(d) : "–");

function median(values) {
  if (!values.length) return 0;
  const v = [...values].sort((a, b) => a - b);
  return v[Math.floor(v.length / 2)];
}

/** Fold a frequency into [0, rate/2] the way sampling at `rate` aliases it. */
export function foldFrequency(hz, rate) {
  const m = ((hz % rate) + rate) % rate;
  return m > rate / 2 ? rate - m : m;
}

/**
 * Frequencies the rotor makes: main rotor harmonics, tail rotor harmonics, the motor.
 * @returns {Array<{label:string, hz:number}>}
 */
export function rotorFrequencies(rotor, speeds) {
  const out = [];
  const head = speeds?.head;
  if (!head) return out;
  const f1 = head / 60;
  for (let h = 1; h <= 8; h++) out.push({ label: `main rotor ×${h}`, hz: f1 * h });
  if (speeds.tail) {
    const t1 = speeds.tail / 60;
    for (let h = 1; h <= 4; h++) out.push({ label: `tail rotor ×${h}`, hz: t1 * h });
  }
  if (rotor?.mainGearRatio && rotor.mainGearRatio !== 1) {
    out.push({ label: "main motor", hz: f1 / rotor.mainGearRatio });
  }
  return out;
}

/** Best rotor source for a peak frequency: a direct match, or a frequency folded down by the log rate. */
export function identifyPeak(hz, sources, logRateHz) {
  const nyquist = logRateHz / 2;
  let best = null;
  for (const s of sources) {
    const tol = Math.max(1.5, s.hz * 0.015);
    if (s.hz <= nyquist && Math.abs(s.hz - hz) <= tol) {
      const err = Math.abs(s.hz - hz);
      if (!best || err < best.err) best = { err, text: s.label };
    }
  }
  if (best) return best.text;
  for (const s of sources) {
    if (s.hz <= nyquist) continue;
    const folded = foldFrequency(s.hz, logRateHz);
    const tol = Math.max(1.5, s.hz * 0.015);
    if (Math.abs(folded - hz) <= tol) {
      return `possible alias of ${s.label} (${fmt(s.hz, 0)} Hz, folded by the ${fmt(logRateHz, 0)} Hz log rate)`;
    }
  }
  return "unidentified";
}

function psdAt(psd, hz, halfWidthHz) {
  // power in ±halfWidth around hz, as rms deg/s
  return bandRms(psd, Math.max(0, hz - halfWidthHz), hz + halfWidthHz + psd.binHz / 2);
}

/**
 * Noise analysis of one axis of unfiltered gyro over [start, end).
 * @returns {{floorDb:number, riseHz:number|null, bands:Array, peaks:Array, psd:object}}
 */
export function analyseAxisNoise(samples, start, end, rateHz, sources = []) {
  const psd = welchPsd(samples, start, end, rateHz, PSD_SEGMENT);
  const { binHz } = psd;
  const nyquist = rateHz / 2;
  const dbs = Array.from(psd.psd, db10);

  // floor: median level 20 Hz .. Nyquist
  const floorBins = [];
  for (let k = 0; k < dbs.length; k++) if (k * binHz >= 20 && Number.isFinite(dbs[k])) floorBins.push(dbs[k]);
  const floorDb = median(floorBins);

  // where the 5 Hz-smoothed spectrum first rises 6 dB above the floor, from 15 Hz up
  const smoothBins = Math.max(1, Math.round(2.5 / binHz));
  let riseHz = null;
  for (let k = Math.ceil(15 / binHz); k < dbs.length; k++) {
    let sum = 0;
    let n = 0;
    for (let j = Math.max(0, k - smoothBins); j <= Math.min(dbs.length - 1, k + smoothBins); j++) {
      sum += psd.psd[j];
      n++;
    }
    if (db10(sum / n) >= floorDb + 6) {
      riseHz = k * binHz;
      break;
    }
  }

  // peaks: local maxima standing PEAK_MIN_PROMINENCE_DB above the local median
  const half = Math.max(1, Math.round(PEAK_HALF_WIDTH_HZ / binHz));
  const floorHalf = Math.round(FLOOR_HALF_WIDTH_HZ / binHz);
  const candidates = [];
  for (let k = Math.ceil(PEAK_MIN_HZ / binHz); k < dbs.length - 1; k++) {
    let isMax = true;
    for (let j = k - half; j <= k + half; j++) {
      if (j !== k && j >= 0 && j < dbs.length && psd.psd[j] > psd.psd[k]) {
        isMax = false;
        break;
      }
    }
    if (!isMax) continue;
    const around = [];
    for (let j = k - floorHalf; j <= k + floorHalf; j++) {
      if (j >= 0 && j < dbs.length && Math.abs(j - k) > half) around.push(dbs[j]);
    }
    const prominence = dbs[k] - median(around);
    if (prominence >= PEAK_MIN_PROMINENCE_DB) {
      candidates.push({ hz: k * binHz, prominenceDb: prominence, levelDb: dbs[k] });
    }
  }
  // biggest by power, so a tall peak on a raised shoulder still ranks above a small sharp one
  candidates.sort((a, b) => b.levelDb - a.levelDb);
  const peaks = candidates.slice(0, MAX_PEAKS).map((p) => ({
    hz: p.hz,
    prominenceDb: p.prominenceDb,
    rms: psdAt(psd, p.hz, PEAK_HALF_WIDTH_HZ),
    source: identifyPeak(p.hz, sources, rateHz),
  }));
  peaks.sort((a, b) => a.hz - b.hz);

  const bands = SUMMARY_BANDS.filter(([lo]) => lo < nyquist).map(([lo, hi]) => ({
    lo,
    hi: Math.min(hi, nyquist),
    rms: bandRms(psd, lo, Math.min(hi, nyquist)),
  }));

  return { floorDb, riseHz, bands, peaks, psd };
}

/** Gain in dB of `filtered` relative to `raw` around one frequency. */
export function gainAt(rawPsd, filteredPsd, hz) {
  const a = psdAt(rawPsd, hz, PEAK_HALF_WIDTH_HZ);
  const b = psdAt(filteredPsd, hz, PEAK_HALF_WIDTH_HZ);
  return a > 0 && b > 0 ? 20 * Math.log10(b / a) : null;
}

/** The deepest cuts the real (logged) filters made, from 10 Hz to Nyquist, smoothed over ±2 Hz. */
export function deepestCuts(rawPsd, loggedPsd, count = 4) {
  const { binHz } = rawPsd;
  const span = Math.max(1, Math.round(2 / binHz));
  const gains = [];
  for (let k = Math.ceil(10 / binHz); k < rawPsd.psd.length - span; k++) {
    let a = 0;
    let b = 0;
    for (let j = k - span; j <= k + span; j++) {
      a += rawPsd.psd[j];
      b += loggedPsd.psd[j];
    }
    gains.push({ hz: k * binHz, db: db10(b / a) });
  }
  const out = [];
  for (const g of [...gains].sort((x, y) => x.db - y.db)) {
    if (out.every((o) => Math.abs(o.hz - g.hz) > 8)) out.push(g);
    if (out.length >= count) break;
  }
  return out.sort((x, y) => x.hz - y.hz);
}

function rotorSection(ctx) {
  const { rotor, speeds, rates, headStats } = ctx;
  const lines = ["## Rotor"];
  if (!speeds?.head) {
    lines.push("No headspeed in the log, so rotor-related peaks can't be identified and the RPM filter can't track.");
    return lines.join("\n");
  }
  lines.push(
    `headspeed: median ${Math.round(speeds.head)} rpm${ 
      headStats ? ` (10th–90th percentile ${Math.round(headStats.p10)}–${Math.round(headStats.p90)} rpm)` : "" 
      } → main rotor ${fmt(speeds.head / 60)} Hz`,
  );
  const mainRatio = rotor?.mainGearRatio ? `${fmt(1 / rotor.mainGearRatio, 2)} : 1 (motor : rotor)` : "unknown";
  lines.push(`main gear ratio: ${mainRatio}; tail rotor speed: ${rotor?.tailSource ?? "unknown"}${rotor?.tailPerHead ? ` (${fmt(rotor.tailPerHead, 2)} × headspeed)` : ""}`);
  lines.push(`gear ratios and governor come from: ${ctx.craftFileName ?? "no craft config (defaults)"}`);
  const freqs = rotorFrequencies(rotor, speeds);
  const nyquist = rates.logRateHz / 2;
  lines.push(
    `frequencies (Hz): ${ 
      freqs.map((f) => `${f.label} ${fmt(f.hz)}${f.hz > nyquist ? ` (above log Nyquist, appears at ${fmt(foldFrequency(f.hz, rates.logRateHz))})` : ""}`).join("; ")}`,
  );
  return lines.join("\n");
}

function settingsSection(settings) {
  // CLI lines, but RPM banks trimmed to their used slots so they stay short
  const lines = settingsToCli(settings)
    .split("\n")
    .map((line) => {
      const m = /^set (gyro_rpm_notch_(?:source|center|q)_\w+) = ([-\d,]+)$/.exec(line);
      if (!m) return line;
      const values = m[2].split(",");
      let last = values.length;
      while (last > 0 && values[last - 1] === "0") last--;
      return `set ${m[1]} = ${values.slice(0, Math.max(1, last)).join(",")}`;
    });
  const banks = resolveRpmBanks(settings.rpm);
  // in Configurator terms (source, SINGLE/DOUBLE/TRIPLE, Q) - the form suggestions use
  const readable = AXES.map((axis, a) => `${axis}: ${describeAxisNotches(banks, a)}`);
  return [
    "## Current filter settings (Rotorflight CLI names and units)",
    ...lines,
    `RPM notches in effect, as Configurator rows${settings.rpm.preset ? ` (preset ${settings.rpm.preset})` : ""}${settings.rpm.enabled ? "" : " - RPM filter is OFF"}:`,
    ...readable.map((r) => `  ${r}`),
  ].join("\n");
}

function noiseSection(ctx) {
  const { data, range, rates } = ctx;
  const sources = rotorFrequencies(ctx.rotor, ctx.speeds);
  const out = ["## Noise in the unfiltered gyro (gyroRAW) per axis",
    "PSD levels in dB re 1 (deg/s)²/Hz; rms in deg/s. 'logged cut' is how much the filters actually flown (logged gyroADC) removed at that frequency."];
  for (let a = 0; a < 3; a++) {
    const n = analyseAxisNoise(data.raw[a], range.start, range.end, rates.logRateHz, sources);
    const logged = data.logged ? welchPsd(data.logged[a], range.start, range.end, rates.logRateHz, PSD_SEGMENT) : null;
    out.push(`### ${AXES[a]}`);
    out.push(`noise floor ${fmt(n.floorDb)} dB; spectrum first rises 6 dB above the floor at ${n.riseHz == null ? "–" : `${fmt(n.riseHz, 0)} Hz`}`);
    out.push(`band rms: ${n.bands.map((b) => `${b.lo}–${b.hi} Hz ${fmt(b.rms, 2)}`).join(" | ")}`);
    out.push("peaks (Hz | dB above local floor | rms | likely source | logged cut):");
    for (const p of n.peaks) {
      const cut = logged ? gainAt(n.psd, logged, p.hz) : null;
      out.push(`  ${fmt(p.hz)} | +${fmt(p.prominenceDb, 0)} | ${fmt(p.rms, 2)} | ${p.source} | ${cut == null ? "–" : `${fmt(cut, 0)} dB`}`);
    }
    if (!n.peaks.length) out.push("  (no clear peaks)");
    if (logged) {
      const cuts = deepestCuts(n.psd, logged);
      out.push(`deepest cuts made by the flown filters: ${cuts.map((c) => `${fmt(c.hz, 0)} Hz ${fmt(c.db, 0)} dB`).join(", ")}`);
    }
  }
  return out.join("\n");
}

/**
 * The first message's data: log, rates, rotor, current settings and per-axis noise.
 * ctx: { craftName, fileName, firmware, rates, data, range, rotor, speeds, headStats, settings,
 *        craftFileName, validation }
 */
export function buildLogSummary(ctx) {
  const { rates, data, range, firmware } = ctx;
  const seconds = (data.time[range.end - 1] - data.time[range.start]) / 1e6;
  const t0 = data.time[0];
  const pidRate = rates.pidRateHz;
  const dynMax = Math.min(Math.max(ctx.settings.dynNotch.minHz, ctx.settings.dynNotch.maxHz), pidRate / 2);
  const trackerRate = pidRate / Math.max(1, Math.floor(pidRate / 2 / dynMax));
  const header = [
    `## Log`,
    `craft: ${ctx.craftName || "unknown"}; file: ${ctx.fileName || "unknown"}`,
    `firmware: ${firmware?.message ?? "unknown"}`,
    `loop rates: gyro ${fmt(rates.gyroRateHz, 0)} Hz, filters ${fmt(rates.filterRateHz, 0)} Hz, PID ${fmt(pidRate, 0)} Hz; blackbox log ${fmt(rates.logRateHz, 0)} Hz (Nyquist ${fmt(rates.logRateHz / 2, 0)} Hz)`,
    `analysed: ${fmt((data.time[range.start] - t0) / 1e6)}–${fmt((data.time[range.end - 1] - t0) / 1e6)} s (${fmt(seconds, 0)} s, ${range.end - range.start} samples)`,
    `dynamic notch tracker with the current max frequency samples at ${fmt(trackerRate, 0)} Hz, so it sees up to ${fmt(trackerRate / 2, 0)} Hz; stronger vibration above that folds down into its view.`,
  ];
  // Rotor frequencies the tracker would see folded into its search range (it averages its input,
  // which weakens them, but a strong one can still capture a notch)
  const folded = rotorFrequencies(ctx.rotor, ctx.speeds)
    .filter((f) => f.hz > trackerRate / 2)
    .map((f) => ({ ...f, at: foldFrequency(f.hz, trackerRate) }))
    .filter((f) => f.at >= Math.max(ctx.settings.dynNotch.minHz, 10) && f.at <= dynMax);
  if (folded.length) {
    header.push(
      `rotor frequencies that fold into the tracker's ${Math.max(ctx.settings.dynNotch.minHz, 10)}–${fmt(dynMax, 0)} Hz search range: ${ 
        folded.map((f) => `${f.label} ${fmt(f.hz)} Hz → seen at ${fmt(f.at)} Hz`).join("; ") 
        } (only matters if they reach the tracker - the RPM filter and lowpass run before it)`,
    );
  }
  if (ctx.validation?.axes) {
    const below = ctx.validation.axes.map((m, a) => {
      const errs = m.bands.filter((b) => b.toHz <= rates.logRateHz * 0.2).map((b) => Math.abs(b.differenceDb));
      return `${AXES[a]} ${fmt(errs.length ? errs.reduce((x, y) => x + y, 0) / errs.length : NaN)} dB`;
    });
    header.push(`simulation accuracy (log's own settings vs logged filtered gyro, mean |error| up to ${fmt(rates.logRateHz * 0.2, 0)} Hz): ${below.join(", ")}`);
  }
  header.push("Simulation results above ~40% of the log Nyquist frequency are less reliable: vibration above Nyquist is folded into the log at the wrong frequency.");

  return [header.join("\n"), rotorSection(ctx), settingsSection(ctx.settings), noiseSection(ctx)].join("\n\n");
}

/**
 * What Imagine says a config does, for sending back after it is applied.
 * ctx: { name, data, range, rates, imagined, delays, rotor, speeds }
 */
export function buildResultSummary(ctx) {
  const { data, range, rates, imagined, delays } = ctx;
  const sources = rotorFrequencies(ctx.rotor, ctx.speeds);
  const out = [`## Imagine result for "${ctx.name}"`];
  const c = imagined.chain || {};
  const active = [
    c.rpm && `RPM notches (${c.rpmBankCount})`,
    c.lpf2 && "LPF2",
    c.lpf1 && (c.dynLpf ? "LPF1 (dynamic)" : "LPF1"),
    c.notch2 && "notch 2",
    c.notch1 && "notch 1",
    c.dynNotch && "dynamic notch",
  ].filter(Boolean);
  out.push(`active filters: ${active.join(" → ") || "none"}`);
  if (c.dynNotchDisabledReason) out.push(`dynamic notch disabled: ${c.dynNotchDisabledReason}`);
  if (c.rpmSkipped?.length) {
    out.push(`RPM notches that couldn't be placed: ${c.rpmSkipped.map((s) => `${AXES[s.axis]} ${rpmSourceName(s.source)} (${s.reason})`).join("; ")}`);
  }
  out.push("Per axis: each peak's level after the imagined filters, relative to unfiltered, next to what the flown filters achieved.");
  for (let a = 0; a < 3; a++) {
    const n = analyseAxisNoise(data.raw[a], range.start, range.end, rates.logRateHz, sources);
    const im = welchPsd(imagined.filtered[a], range.start, range.end, rates.logRateHz, PSD_SEGMENT);
    const logged = data.logged ? welchPsd(data.logged[a], range.start, range.end, rates.logRateHz, PSD_SEGMENT) : null;
    out.push(`### ${AXES[a]}`);
    out.push(
      `peaks (Hz | source | imagined | flown): ${ 
        n.peaks
          .map((p) => {
            const g = gainAt(n.psd, im, p.hz);
            const l = logged ? gainAt(n.psd, logged, p.hz) : null;
            return `${fmt(p.hz)} ${p.source.split(" (")[0]} ${fmt(g, 0)} dB / ${l == null ? "–" : `${fmt(l, 0)} dB`}`;
          })
          .join("; ")}`,
    );
    out.push(
      `band rms deg/s (unfiltered → imagined${  logged ? " | flown" : ""  }): ${ 
        n.bands
          .map((b) => `${b.lo}–${b.hi} ${fmt(b.rms, 2)}→${fmt(bandRms(im, b.lo, b.hi), 2)}${logged ? ` | ${fmt(bandRms(logged, b.lo, b.hi), 2)}` : ""}`)
          .join("; ")}`,
    );
    const d = delays?.axes?.[a];
    if (d) {
      out.push(
        `filter delay ms (log settings → this config): ${ 
          delays.frequencies.map((f, i) => `${f} Hz ${fmt(d.log[i].delayMs, 2)}→${fmt(d.imagined[i].delayMs, 2)}`).join(", ")}`,
      );
    }
    if (imagined.dynNotchCenters && imagined.dynNotchCount) {
      const k = imagined.dynNotchCount;
      const med = [];
      for (let p = 0; p < k; p++) {
        const v = [];
        for (let i = range.start; i < range.end; i += 4) v.push(imagined.dynNotchCenters[i * 3 * k + a * k + p]);
        med.push(fmt(median(v), 0));
      }
      out.push(`dynamic notch median positions (Hz): ${med.join(", ")}`);
    }
  }
  return out.join("\n");
}
