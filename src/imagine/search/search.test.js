import { describe, expect, test } from "vitest";
import { simulateGyroFilters } from "../simulate.js";
import { cloneSettings } from "../header_settings.js";
import { FILTER_PARAMS } from "../ai/filter_tool.js";
import { parseRpmLayout } from "../rpm_notch_layout.js";
import { buildNoiseModel, measuredNoise, combineAxes } from "./noise_model.js";
import { Evaluator, delayFrequencies } from "./evaluate.js";
import { buildSearchSpace, candidateSettings, notchCutoffForQ, scaleRpmQ, lowpassCutoffs } from "./search_space.js";
import { FilterSearch, paretoFront, spreadAlong, mulberry32 } from "./search.js";
import { recommend } from "./search_store.js";
import { notchFilterGetQ } from "../filters/filters.js";

const RATES = { logRateHz: 500, filterRateHz: 2000, pidRateHz: 2000 };
const ROTOR = { mainGearRatio: null, tailGearRatio: null, tailPerHead: 4.5, motorisedTail: false, hasTailSpeed: true, governorActive: false, fullHeadSpeed: 0 };
const bank = (v) => [...v, ...new Array(16 - v.length).fill(0)];

function baseSettings() {
  return {
    lpf1: { type: 1, staticHz: 80, dynMinHz: 0, dynMaxHz: 0 },
    lpf2: { type: 0, staticHz: 0 },
    notch1: { hz: 0, cutoff: 0 },
    notch2: { hz: 0, cutoff: 0 },
    dynNotch: { enabled: false, count: 2, q: 30, minHz: 30, maxHz: 200 },
    rpm: {
      enabled: true,
      minHz: 20,
      preset: 0,
      source: [bank([11, 12, 21]), bank([11, 12, 21]), bank([11, 12])],
      center: [bank([]), bank([]), bank([])],
      q: [bank([50, 40, 40]), bank([50, 40, 40]), bank([50, 40])],
    },
  };
}

// 24 s of flight: slow stick motion, rotor harmonics following a changing headspeed, a fixed 150 Hz
// vibration and broadband noise.
function syntheticFlight(seconds = 24) {
  const n = seconds * RATES.logRateHz;
  const rand = mulberry32(7);
  const headspeed = new Float64Array(n);
  const tailspeed = new Float64Array(n);
  const raw = [new Float64Array(n), new Float64Array(n), new Float64Array(n)];
  const phase = [0, 0, 0];
  for (let i = 0; i < n; i++) {
    const t = i / RATES.logRateHz;
    headspeed[i] = 1900 + 100 * Math.sin((2 * Math.PI * t) / 9);
    tailspeed[i] = headspeed[i] * ROTOR.tailPerHead;
    const f1 = headspeed[i] / 60;
    phase[0] += (2 * Math.PI * f1) / RATES.logRateHz;
    phase[1] += (2 * Math.PI * 2 * f1) / RATES.logRateHz;
    phase[2] += (2 * Math.PI * f1 * ROTOR.tailPerHead) / RATES.logRateHz;
    for (let a = 0; a < 3; a++) {
      const motion = 40 * Math.sin(2 * Math.PI * (2 + a) * t);
      const rotor = 6 * Math.sin(phase[0] + a) + 4 * Math.sin(phase[1]) + 2 * Math.sin(phase[2] - a);
      const vib = 3 * Math.sin(2 * Math.PI * 150 * t + a);
      raw[a][i] = motion + rotor + vib + 2 * (rand() - 0.5);
    }
  }
  return { raw, headspeed, tailspeed, count: n };
}

const flight = syntheticFlight();
const model = buildNoiseModel({ ...flight, logRateHz: RATES.logRateHz, start: 0, end: flight.count, settleSamples: 500 });

function simulatedNoise(settings) {
  const sim = simulateGyroFilters({ raw: flight.raw, headspeed: flight.headspeed, tailspeed: flight.tailspeed, rates: RATES, settings, rotor: ROTOR });
  return combineAxes(measuredNoise(model, sim.filtered, 20));
}

describe("noise model and fast estimate", () => {
  const ev = new Evaluator(model, RATES, ROTOR, 20);

  test("groups the flight by headspeed", () => {
    expect(model.buckets.length).toBeGreaterThan(1);
    const weights = model.buckets.reduce((s, b) => s + b.weight, 0);
    expect(weights).toBeCloseTo(1, 9);
    for (let i = 1; i < model.buckets.length; i++) expect(model.buckets[i].headRpm).toBeGreaterThan(model.buckets[i - 1].headRpm);
  });

  test("no filters: the estimate is the measured unfiltered noise", () => {
    const s = baseSettings();
    s.lpf1.type = 0;
    s.rpm.enabled = false;
    expect(ev.evaluate(s).noiseRms).toBeCloseTo(combineAxes(measuredNoise(model, flight.raw, 20)), 6);
    expect(ev.evaluate(s).delayMs).toBeCloseTo(0, 9);
    expect(ev.unfiltered().noiseRms).toBeCloseTo(ev.evaluate(s).noiseRms, 9);
  });

  test.each([
    ["first order lowpass", (s) => (s.rpm.enabled = false)],
    ["PT2 + butterworth", (s) => ((s.rpm.enabled = false), (s.lpf1 = { type: 4, staticHz: 90, dynMinHz: 0, dynMaxHz: 0 }), (s.lpf2 = { type: 7, staticHz: 140 }))],
    ["static notch on the vibration", (s) => ((s.rpm.enabled = false), (s.notch1 = { hz: 150, cutoff: 120 }))],
  ])("static filters match the full simulation: %s", (name, change) => {
    const s = baseSettings();
    change(s);
    const est = ev.evaluate(s).noiseRms;
    expect(Math.abs(est / simulatedNoise(s) - 1)).toBeLessThan(0.03);
  });

  test("RPM notches following the rotor match the full simulation closely", () => {
    const s = baseSettings();
    const est = ev.evaluate(s).noiseRms;
    expect(Math.abs(est / simulatedNoise(s) - 1)).toBeLessThan(0.02);
  });

  test("more filtering, more delay; flight band loss is reported", () => {
    const light = baseSettings();
    const heavy = baseSettings();
    heavy.lpf1 = { type: 5, staticHz: 40, dynMinHz: 0, dynMaxHz: 0 };
    const a = ev.evaluate(light);
    const b = ev.evaluate(heavy);
    expect(b.delayMs).toBeGreaterThan(a.delayMs);
    expect(b.noiseRms).toBeLessThan(a.noiseRms);
    expect(b.bandLossDb).toBeGreaterThan(a.bandLossDb);
    expect(delayFrequencies(20)).toEqual([5, 10, 15, 20]);
  });
});

describe("search space", () => {
  const base = baseSettings();
  const space = buildSearchSpace({ base, model, rates: RATES, boundaryHz: 20, vary: {}, cliTypes: true });

  test("option 0 everywhere is the log's own settings", () => {
    expect(candidateSettings(space, base, space.dims.map(() => 0))).toEqual(base);
  });

  test("every option stays inside the Rotorflight CLI limits", () => {
    const scalars = Object.entries(FILTER_PARAMS).filter(([, d]) => d.kind === "scalar");
    space.dims.forEach((dim, d) => {
      dim.options.forEach((_, o) => {
        const genome = space.dims.map(() => 0);
        genome[d] = o;
        const s = candidateSettings(space, base, genome);
        for (const [name, def] of scalars) {
          const v = def.get(s);
          expect(v, `${dim.id} option ${o}: ${name}`).toBeGreaterThanOrEqual(def.min);
          expect(v, `${dim.id} option ${o}: ${name}`).toBeLessThanOrEqual(def.max);
        }
        for (const axis of [0, 1, 2]) {
          for (const q of s.rpm.q[axis]) expect(q === 0 || (q >= 10 && q <= 250)).toBe(true);
        }
      });
    });
  });

  test("finds the vibration and keeps notches out of the flight band", () => {
    expect(space.peaks.some((f) => Math.abs(f - 150) <= 2)).toBe(true);
    for (const o of space.dims.find((d) => d.id === "notch1").options) {
      const s = cloneSettings(base);
      o.apply(s);
      if (s.notch1.hz) expect(s.notch1.cutoff).toBeGreaterThan(20);
    }
  });

  test("locked filters are not searched", () => {
    const locked = buildSearchSpace({ base, model, rates: RATES, boundaryHz: 20, vary: { lpf2: false, rpm: false }, cliTypes: false });
    expect(locked.dims.find((d) => d.id === "lpf2").options.length).toBe(1);
    expect(locked.dims.find((d) => d.id === "rpm").options.length).toBe(1);
    expect(locked.dims.find((d) => d.id === "lpf1").options.length).toBe(2 + 2 * lowpassCutoffs(20, 2000).length);
  });

  test("notch cutoff for a Q, and RPM Q scaling keeps a Configurator layout", () => {
    for (const [hz, q] of [[150, 2], [66, 3.5], [203, 6]]) {
      expect(notchFilterGetQ(hz, notchCutoffForQ(hz, q))).toBeCloseTo(q, 0);
    }
    const scaled = scaleRpmQ(base.rpm, 1.6);
    expect(scaled.q[0].slice(0, 3)).toEqual([80, 64, 64]);
    expect(parseRpmLayout(scaled)).not.toBeNull();
  });
});

describe("search", () => {
  test("Pareto front, spread and recommendation", () => {
    const pts = [
      { delayMs: 1, noiseRms: 5 },
      { delayMs: 2, noiseRms: 6 },
      { delayMs: 3, noiseRms: 3 },
      { delayMs: 4, noiseRms: 3 },
      { delayMs: 5, noiseRms: 1 },
    ];
    expect(paretoFront(pts)).toEqual([0, 2, 4]);
    expect(paretoFront(pts, undefined, (p) => p.delayMs !== 3)).toEqual([0, 3, 4]);
    expect(spreadAlong([0, 2, 4], pts, 2)).toEqual([0, 4]);
    const front = [0, 2, 4].map((i) => ({ ...pts[i], index: i }));
    expect(recommend(front, 3.5).index).toBe(2);
    expect(recommend(front, 0.5).index).toBe(4); // nothing that quiet: the quietest
  });

  test("finds setups at least as good as the log's, all verified by full simulation", () => {
    const search = new FilterSearch({
      ...flight,
      rates: RATES,
      rotor: ROTOR,
      settings: baseSettings(),
      start: 0,
      end: flight.count,
      settleSamples: 500,
      boundaryHz: 20,
      search: { randomCount: 400, budgetMs: 400, verifyCount: 8, calibrateVerifyCount: 4 },
    });
    const r = search.run();
    const log = r.verified.find((v) => v.index === r.logIndex);
    expect(log).toBeTruthy();
    expect(r.front.length).toBeGreaterThan(1);

    const front = r.front.map((i) => r.verified.find((v) => v.index === i));
    for (let i = 1; i < front.length; i++) {
      expect(front[i].delayMs).toBeGreaterThan(front[i - 1].delayMs);
      expect(front[i].noiseRms).toBeLessThan(front[i - 1].noiseRms);
    }
    for (const p of front) expect(p.bandLossDb).toBeLessThanOrEqual(r.maxBandLossDb);

    // the log is on the front or beaten by something with no more noise and no more delay
    const beaten = front.some((p) => p.delayMs <= log.delayMs + 1e-9 && p.noiseRms <= log.noiseRms + 1e-9);
    expect(beaten).toBe(true);

    // the verified noise really is the full simulation's
    const best = front[front.length - 1];
    expect(best.noiseRms).toBeCloseTo(simulatedNoise(best.settings), 9);

    // verifying more near a noise level adds verified setups
    const before = r.verified.length;
    const more = search.verifyNear(log.noiseRms, 3);
    expect(more.verified.length).toBeGreaterThanOrEqual(before);
  }, 60000);
});
