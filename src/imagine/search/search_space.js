// What the filter search may change, as a list of dimensions. Each dimension is a list of options;
// option 0 is always "as in the log", so the log's own settings are the all-zero candidate and
// every candidate is the log's settings with some filters changed. A locked dimension only has
// option 0.
//
// Values stay inside the Rotorflight CLI limits (see ai/filter_tool.js FILTER_PARAMS).

import { cloneSettings } from "../header_settings.js";
import { LPF_TYPE, notchFilterGetQ } from "../filters/filters.js";
import { resolveRpmBanks } from "../filters/rpm_filter.js";
import { generateRpmLayout, parseRpmLayout, MIN_Q, MAX_Q } from "../rpm_notch_layout.js";

export const DIMENSIONS = Object.freeze(["lpf1", "lpf2", "notch1", "notch2", "dynNotch", "rpm"]);

export const DIMENSION_LABELS = Object.freeze({
  lpf1: "Lowpass 1",
  lpf2: "Lowpass 2",
  notch1: "Notch 1",
  notch2: "Notch 2",
  dynNotch: "Dynamic notch",
  rpm: "RPM notch Q",
});

// Distinct lowpass shapes. ORDER1 is the same filter as FIRST_ORDER and BESSEL as SECOND_ORDER.
export const CONFIGURATOR_LPF_TYPES = Object.freeze([LPF_TYPE.FIRST_ORDER, LPF_TYPE.SECOND_ORDER]);
export const CLI_LPF_TYPES = Object.freeze([LPF_TYPE.PT1, LPF_TYPE.PT2, LPF_TYPE.PT3, LPF_TYPE.BUTTER, LPF_TYPE.DAMPED]);

export const NOTCH_QS = Object.freeze([1, 2, 3.5, 6]);
export const DYN_NOTCH_COUNTS = Object.freeze([1, 2, 3, 4]);
export const DYN_NOTCH_QS = Object.freeze([20, 30, 45, 70]); // CLI x10
export const RPM_Q_SCALES = Object.freeze([0.6, 0.8, 1.25, 1.6]);

/** Lowpass cutoffs to try: 5 Hz steps to 100 Hz, 10 Hz to 250 Hz, 25 Hz to 500 Hz. */
export function lowpassCutoffs(boundaryHz, filterRateHz) {
  const top = Math.min(500, Math.floor(0.45 * filterRateHz));
  const out = [];
  for (let f = Math.max(20, Math.ceil(boundaryHz / 5) * 5); f <= top; ) {
    out.push(f);
    f += f < 100 ? 5 : f < 250 ? 10 : 25;
  }
  return out;
}

/** gyro_notchN_cutoff (integer Hz) that gives the wanted Q at a centre frequency. */
export function notchCutoffForQ(centerHz, q) {
  const cutoff = Math.round((centerHz * (Math.sqrt(1 + 4 * q * q) - 1)) / (2 * q));
  return Math.max(1, Math.min(centerHz - 1, cutoff));
}

/**
 * The largest peaks of the unfiltered spectrum (all axes and buckets together) above the flight
 * band, as candidate static notch centres.
 */
export function noisePeaks(model, boundaryHz, count = 6) {
  const total = new Float64Array(model.bins);
  for (const b of model.buckets) {
    for (let a = 0; a < 3; a++) for (let k = 0; k < model.bins; k++) total[k] += b.psd[a][k] * b.weight;
  }
  const lo = Math.max(1, Math.ceil((1.5 * boundaryHz) / model.binHz));
  const hi = Math.min(model.bins - 2, Math.floor((0.95 * model.logRateHz) / 2 / model.binHz));
  const peaks = [];
  for (let k = lo; k <= hi; k++) {
    if (total[k] > total[k - 1] && total[k] >= total[k + 1]) peaks.push(k);
  }
  peaks.sort((a, b) => total[b] - total[a]);
  const out = [];
  for (const k of peaks) {
    const hz = Math.round(k * model.binHz);
    if (out.every((f) => Math.abs(f - hz) > Math.max(4, 0.06 * hz))) out.push(hz);
    if (out.length >= count) break;
  }
  return out.sort((a, b) => a - b);
}

// RPM notch banks with every Q scaled. Configurator layouts are rebuilt through the Configurator
// rows, so double/triple notch spacing follows the new Q as it would in the Configurator.
export function scaleRpmQ(rpm, scale) {
  const banks = rpm.preset > 0 ? resolveRpmBanks(rpm) : { source: rpm.source, center: rpm.center, q: rpm.q };
  const layout = parseRpmLayout(banks);
  let out;
  if (layout) {
    const scaled = layout.map((bank) => {
      const copy = {};
      for (const [source, row] of Object.entries(bank)) {
        copy[source] = { ...row, q: Math.round(Math.min(MAX_Q, Math.max(MIN_Q, row.q * scale)) * 10) / 10 };
      }
      return copy;
    });
    out = generateRpmLayout(scaled);
  } else {
    out = {
      source: banks.source.map((a) => a.slice()),
      center: banks.center.map((a) => a.slice()),
      q: banks.q.map((a) => a.map((q) => (q ? Math.round(Math.min(250, Math.max(10, q * scale))) : 0))),
    };
  }
  return { ...rpm, preset: 0, source: out.source, center: out.center, q: out.q };
}

/**
 * @param {object} p
 *   base         the log's settings
 *   model        noise model (for the notch candidates)
 *   rates        {filterRateHz, pidRateHz}
 *   boundaryHz   flight band edge: no lowpass cutoff, notch or dynamic notch below it
 *   vary         {lpf1:true, ...} which dimensions the search may change
 *   cliTypes     include the lowpass types only the CLI offers
 * @returns {{dims: Array<{id, label, options: Array<{label, apply(settings), order?:number}>}>}}
 */
export function buildSearchSpace({ base, model, rates, boundaryHz, vary, cliTypes = true }) {
  const keep = { label: "as logged", apply: () => {} };
  const dims = [];
  const types = cliTypes ? [...CONFIGURATOR_LPF_TYPES, ...CLI_LPF_TYPES] : [...CONFIGURATOR_LPF_TYPES];
  const cutoffs = lowpassCutoffs(boundaryHz, rates.filterRateHz);
  const peaks = noisePeaks(model, boundaryHz);

  const lowpassOptions = (key) => {
    const opts = [keep, { label: "off", apply: (s) => (s[key] = blankLowpass(key)) }];
    for (const type of types) {
      cutoffs.forEach((hz, i) => {
        opts.push({ label: `${type}@${hz}`, type, order: i, apply: (s) => (s[key] = lowpass(key, type, hz)) });
      });
    }
    return opts;
  };

  const notchOptions = (key) => {
    const opts = [keep, { label: "off", apply: (s) => (s[key] = { hz: 0, cutoff: 0 }) }];
    for (const hz of peaks) {
      for (const q of NOTCH_QS) {
        const cutoff = notchCutoffForQ(hz, q);
        if (cutoff <= boundaryHz) continue; // the notch would reach into the flight band
        opts.push({ label: `${hz}/${cutoff}`, apply: (s) => (s[key] = { hz, cutoff }) });
      }
    }
    return opts;
  };

  const dynOptions = () => {
    const opts = [keep];
    if (rates.pidRateHz < 1000) return opts; // the firmware turns the dynamic notch off
    opts.push({ label: "off", apply: (s) => (s.dynNotch = { ...s.dynNotch, enabled: false }) });
    const minHz = Math.min(200, Math.max(10, base.dynNotch.minHz || 20, Math.ceil(boundaryHz)));
    const maxHz = Math.min(500, Math.max(100, base.dynNotch.maxHz || 200, minHz));
    for (const count of DYN_NOTCH_COUNTS) {
      for (const q of DYN_NOTCH_QS) {
        opts.push({
          label: `${count}xQ${q / 10}`,
          apply: (s) => (s.dynNotch = { enabled: true, count, q, minHz, maxHz }),
        });
      }
    }
    return opts;
  };

  const rpmOptions = () => {
    const opts = [keep];
    if (!base.rpm.enabled) return opts;
    for (const scale of RPM_Q_SCALES) {
      const scaled = scaleRpmQ(base.rpm, scale);
      opts.push({ label: `Q×${scale}`, apply: (s) => (s.rpm = cloneSettings(scaled)) });
    }
    return opts;
  };

  const builders = {
    lpf1: () => lowpassOptions("lpf1"),
    lpf2: () => lowpassOptions("lpf2"),
    notch1: () => notchOptions("notch1"),
    notch2: () => notchOptions("notch2"),
    dynNotch: dynOptions,
    rpm: rpmOptions,
  };

  for (const id of DIMENSIONS) {
    dims.push({ id, label: DIMENSION_LABELS[id], options: vary?.[id] === false ? [keep] : builders[id]() });
  }
  return { dims, peaks, cutoffs };
}

function blankLowpass(key) {
  return key === "lpf1" ? { type: LPF_TYPE.NONE, staticHz: 0, dynMinHz: 0, dynMaxHz: 0 } : { type: LPF_TYPE.NONE, staticHz: 0 };
}

function lowpass(key, type, hz) {
  return key === "lpf1" ? { type, staticHz: hz, dynMinHz: 0, dynMaxHz: 0 } : { type, staticHz: hz };
}

/** Settings for a candidate (array of option indexes, one per dimension). */
export function candidateSettings(space, base, genome) {
  const s = cloneSettings(base);
  space.dims.forEach((dim, i) => dim.options[genome[i]].apply(s));
  return s;
}

export function genomeKey(genome) {
  return genome.join(",");
}

const LPF_NAMES = { 1: "1st order", 2: "2nd order", 3: "PT1", 4: "PT2", 5: "PT3", 6: "1st order", 7: "Butterworth", 8: "2nd order", 9: "Damped" };

/**
 * Short plain-language summary of how a setup differs from the base settings, one line per filter,
 * e.g. ["LPF1 off", "Notch 1 at 203 Hz, Q 2.0", "Dynamic notch 1 × Q 2.0, 30–160 Hz"].
 */
export function describeSetup(settings, base) {
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const out = [];
  for (const [key, name] of [
    ["lpf1", "LPF1"],
    ["lpf2", "LPF2"],
  ]) {
    if (same(settings[key], base[key])) continue;
    const f = settings[key];
    if (!f.type || !(f.staticHz > 0)) out.push(`${name} off`);
    else if (key === "lpf1" && f.dynMinHz > 0) out.push(`${name} ${LPF_NAMES[f.type] ?? f.type} dynamic ${f.dynMinHz}–${f.dynMaxHz} Hz`);
    else out.push(`${name} ${LPF_NAMES[f.type] ?? f.type} ${f.staticHz} Hz`);
  }
  for (const [key, name] of [
    ["notch1", "Notch 1"],
    ["notch2", "Notch 2"],
  ]) {
    if (same(settings[key], base[key])) continue;
    const n = settings[key];
    const q = notchFilterGetQ(n.hz, n.cutoff);
    out.push(q > 0 ? `${name} at ${n.hz} Hz, Q ${q.toFixed(1)}` : `${name} off`);
  }
  if (!same(settings.dynNotch, base.dynNotch)) {
    const d = settings.dynNotch;
    out.push(d.enabled ? `Dynamic notch ${d.count} × Q ${(d.q / 10).toFixed(1)}, ${d.minHz}–${d.maxHz} Hz` : "Dynamic notch off");
  }
  if (!same(settings.rpm, base.rpm)) {
    if (!settings.rpm.enabled) {
      out.push("RPM filter off");
    } else {
      const ratios = [];
      settings.rpm.q.forEach((axis, a) =>
        axis.forEach((q, i) => {
          const b = (base.rpm.preset > 0 ? resolveRpmBanks(base.rpm) : base.rpm).q[a][i];
          if (q && b) ratios.push(q / b);
        }),
      );
      ratios.sort((x, y) => x - y);
      const r = ratios[Math.floor(ratios.length / 2)];
      out.push(r ? `RPM notch Q × ${r.toFixed(2).replace(/0$/, "")}` : "RPM notches changed");
    }
  }
  return out;
}
