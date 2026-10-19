// The filter search: find the setups with the least gyro noise for each amount of filter delay.
//
// 1. Score the log's own settings and a few thousand random setups with the fast estimate.
// 2. Refine: mutate the setups on the best trade-off line (the Pareto front: nothing else has both
//    less noise and less delay) and keep going while the line improves and time is left.
// 3. Verify: run a spread of the front, plus the log's settings, through the full time-domain
//    simulation and measure their noise the same way. The final front uses verified noise only.
// 4. Calibrate: the estimate is exact for the static filters and close for the RPM notches, but
//    optimistic for the dynamic notch (the real tracker hops between peaks and lags). Each
//    dynamic notch count gets a correction factor from the verified setups, then the front is
//    refined and verified once more with the corrected estimates.
//    More setups can be verified later (FilterSearch.verify), e.g. near the noise the user accepts.
//
// Setups that attenuate the flight band (5 Hz up to the boundary) by more than maxBandLossDb are
// scored but never put on the front: they would take out real flight motion, not just noise.

import { simulateGyroFilters } from "../simulate.js";
import { Evaluator } from "./evaluate.js";
import { buildNoiseModel, measuredNoise, combineAxes } from "./noise_model.js";
import { buildSearchSpace, candidateSettings, genomeKey } from "./search_space.js";

export const DEFAULT_SEARCH = Object.freeze({
  randomCount: 3000,
  budgetMs: 4000,
  mutationsPerPoint: 12,
  verifyCount: 20,
  calibrateVerifyCount: 12,
  maxBandLossDb: 3,
  seed: 1,
});

// Small seeded generator, so a search on the same log and options gives the same answer
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Indexes of the Pareto front (least delay and least noise), sorted by delay.
 * @param {Array<{delayMs:number}>} points
 * @param {(p)=>number} noiseOf
 * @param {(p)=>boolean} include  points left out of the front
 */
export function paretoFront(points, noiseOf = (p) => p.noiseRms, include = () => true) {
  const order = [];
  points.forEach((p, i) => {
    if (include(p)) order.push(i);
  });
  order.sort((a, b) => points[a].delayMs - points[b].delayMs || noiseOf(points[a]) - noiseOf(points[b]));
  const front = [];
  let best = Infinity;
  for (const i of order) {
    const n = noiseOf(points[i]);
    if (n < best - 1e-12) {
      front.push(i);
      best = n;
    }
  }
  return front;
}

/** Up to `count` front members spread evenly along the delay range (both ends always kept). */
export function spreadAlong(front, points, count) {
  if (front.length <= count) return front.slice();
  const lo = points[front[0]].delayMs;
  const hi = points[front[front.length - 1]].delayMs;
  const picked = new Set([front[0], front[front.length - 1]]);
  for (let i = 1; i < count - 1; i++) {
    const target = lo + ((hi - lo) * i) / (count - 1);
    let bestIdx = -1;
    let bestDist = Infinity;
    for (const idx of front) {
      if (picked.has(idx)) continue;
      const d = Math.abs(points[idx].delayMs - target);
      if (d < bestDist) {
        bestDist = d;
        bestIdx = idx;
      }
    }
    if (bestIdx >= 0) picked.add(bestIdx);
  }
  return front.filter((i) => picked.has(i));
}

function mutate(genome, space, rand) {
  const g = genome.slice();
  const free = space.dims.map((d, i) => (d.options.length > 1 ? i : -1)).filter((i) => i >= 0);
  if (!free.length) return g;
  const changes = rand() < 0.7 ? 1 : 2;
  for (let c = 0; c < changes; c++) {
    const d = free[Math.floor(rand() * free.length)];
    const options = space.dims[d].options;
    const current = options[g[d]];
    if (current.order !== undefined && rand() < 0.6) {
      // nudge a lowpass cutoff along its own type
      const step = (rand() < 0.5 ? -1 : 1) * (1 + Math.floor(rand() * 3));
      const target = g[d] + step;
      if (target >= 0 && target < options.length && options[target].type === current.type) {
        g[d] = target;
        continue;
      }
    }
    g[d] = Math.floor(rand() * options.length);
  }
  return g;
}

// Area under the front's staircase up to refDelay: smaller means a better front
function frontArea(front, points, refDelay) {
  if (!front.length) return Infinity;
  let area = 0;
  for (let i = 0; i < front.length; i++) {
    const p = points[front[i]];
    if (p.delayMs >= refDelay) break;
    const nextDelay = i + 1 < front.length ? Math.min(refDelay, points[front[i + 1]].delayMs) : refDelay;
    area += (nextDelay - p.delayMs) * p.noiseRms;
  }
  return area;
}

export class FilterSearch {
  /**
   * @param {object} input
   *   raw, headspeed, tailspeed, rates, rotor, settings (the log's), start, end, settleSamples
   *   boundaryHz, vary, cliTypes
   *   search: overrides of DEFAULT_SEARCH
   */
  constructor(input) {
    this.input = input;
    this.opts = { ...DEFAULT_SEARCH, ...(input.search ?? {}) };
    this.base = input.settings;
    this.model = buildNoiseModel({
      raw: input.raw,
      headspeed: input.headspeed,
      tailspeed: input.tailspeed,
      logRateHz: input.rates.logRateHz,
      start: input.start,
      end: input.end,
      settleSamples: input.settleSamples,
    });
    this.evaluator = new Evaluator(this.model, input.rates, input.rotor, input.boundaryHz);
    this.space = buildSearchSpace({
      base: this.base,
      model: this.model,
      rates: input.rates,
      boundaryHz: input.boundaryHz,
      vary: input.vary,
      cliTypes: input.cliTypes,
    });
    this.points = [];
    this.seen = new Map();
  }

  feasible(p) {
    return p.bandLossDb <= this.opts.maxBandLossDb;
  }

  _score(genome) {
    const key = genomeKey(genome);
    if (this.seen.has(key)) return this.seen.get(key);
    const settings = candidateSettings(this.space, this.base, genome);
    const r = this.evaluator.evaluate(settings);
    const group = settings.dynNotch.enabled ? settings.dynNotch.count : 0;
    const p = {
      genome,
      group,
      noise: r.noise,
      rawNoiseRms: r.noiseRms,
      noiseRms: r.noiseRms * (this.factors?.[group] ?? 1),
      delayMs: r.delayMs,
      delayAxes: r.delayAxes,
      bandLossDb: r.bandLossDb,
      verified: null,
    };
    this.seen.set(key, this.points.length);
    this.points.push(p);
    return this.points.length - 1;
  }

  /** Steps 1-4. Returns the result summary (see result()). */
  run(onProgress = () => {}) {
    const started = performance.now();
    const { opts, space, points } = this;
    const rand = mulberry32(opts.seed);
    this.rand = rand;
    const feasible = (p) => this.feasible(p);

    this.logIndex = this._score(space.dims.map(() => 0));

    for (let i = 0; i < opts.randomCount; i++) {
      this._score(space.dims.map((d) => Math.floor(rand() * d.options.length)));
      if (i % 500 === 0) onProgress({ phase: "search", done: i, total: opts.randomCount, evaluated: points.length });
    }

    let refDelay = 0;
    for (const p of points) if (feasible(p)) refDelay = Math.max(refDelay, p.delayMs);
    this.refDelay = refDelay;
    this._refine(started + opts.budgetMs, onProgress);
    this.searchMs = performance.now() - started;

    const toVerify = spreadAlong(paretoFront(points, undefined, feasible), points, opts.verifyCount);
    if (!toVerify.includes(this.logIndex)) toVerify.push(this.logIndex);
    this.verify(toVerify, onProgress);

    if (this.calibrate()) {
      this._refine(performance.now() + opts.budgetMs / 2, onProgress);
      const front = paretoFront(points, undefined, feasible);
      this.verify(spreadAlong(front, points, opts.calibrateVerifyCount), onProgress);
    }
    this.elapsedMs = performance.now() - started;
    return this.result();
  }

  /**
   * Correction factor per dynamic notch count: median verified / estimated noise over the verified
   * setups of that count (falling back to all dynamic notch setups, then 1). Returns true when a
   * factor changed enough to be worth another refine pass.
   */
  calibrate() {
    const ratios = new Map();
    for (const p of this.points) {
      if (!p.verified || !(p.rawNoiseRms > 0)) continue;
      if (!ratios.has(p.group)) ratios.set(p.group, []);
      ratios.get(p.group).push(p.verified.noiseRms / p.rawNoiseRms);
    }
    const median = (v) => {
      const s = [...v].sort((a, b) => a - b);
      return s[Math.floor(s.length / 2)];
    };
    const anyDyn = [...ratios.entries()].filter(([g]) => g > 0).flatMap(([, v]) => v);
    const fallback = anyDyn.length >= 2 ? median(anyDyn) : 1;
    const factors = {};
    let changed = false;
    for (let g = 0; g <= 8; g++) {
      const v = ratios.get(g);
      let f = v && v.length >= 2 ? median(v) : g > 0 ? fallback : 1;
      if (g === 0) f = 1; // static filters and RPM notches are estimated directly
      factors[g] = f;
      if (Math.abs(f - 1) > 0.03) changed = true;
    }
    this.factors = factors;
    for (const p of this.points) p.noiseRms = p.rawNoiseRms * factors[p.group];
    return changed;
  }

  _refine(deadline, onProgress) {
    const { opts, space, points, rand } = this;
    const feasible = (p) => this.feasible(p);
    const refDelay = this.refDelay;
    let stale = 0;
    let rounds = 0;
    while (performance.now() < deadline && stale < 4) {
      const before = points.length;
      const front = paretoFront(points, undefined, feasible);
      const area = frontArea(front, points, refDelay);
      for (const idx of front) {
        for (let m = 0; m < opts.mutationsPerPoint; m++) this._score(mutate(points[idx].genome, space, rand));
      }
      rounds++;
      const after = frontArea(paretoFront(points, undefined, feasible), points, refDelay);
      stale = after < area - 1e-9 && points.length > before ? 0 : stale + 1;
      onProgress({ phase: "refine", done: rounds, total: 0, evaluated: points.length });
    }
  }

  /** Runs the full simulation for the given point indexes (skipping ones already verified). */
  verify(indexes, onProgress = () => {}) {
    const todo = indexes.filter((i) => this.points[i] && !this.points[i].verified);
    const input = this.input;
    todo.forEach((idx, i) => {
      onProgress({ phase: "verify", done: i, total: todo.length, evaluated: this.points.length });
      const sim = simulateGyroFilters({
        raw: input.raw,
        headspeed: input.headspeed,
        tailspeed: input.tailspeed,
        rates: input.rates,
        settings: candidateSettings(this.space, this.base, this.points[idx].genome),
        rotor: input.rotor,
      });
      const noise = measuredNoise(this.model, sim.filtered, input.boundaryHz);
      this.points[idx].verified = { noise, noiseRms: combineAxes(noise) };
    });
    return todo.length;
  }

  /**
   * Verifies up to `count` more estimated-front setups whose noise is closest to `noiseRms`
   * (deg/s), on both sides of it.
   */
  verifyNear(noiseRms, count = 8, onProgress) {
    const front = paretoFront(this.points, undefined, (p) => this.feasible(p));
    const candidates = front.filter((i) => !this.points[i].verified);
    candidates.sort((a, b) => Math.abs(Math.log(this.points[a].noiseRms / noiseRms)) - Math.abs(Math.log(this.points[b].noiseRms / noiseRms)));
    this.verify(candidates.slice(0, count), onProgress);
    return this.result();
  }

  describe(idx) {
    const p = this.points[idx];
    return {
      index: idx,
      settings: candidateSettings(this.space, this.base, p.genome),
      choices: this.space.dims.map((d, i) => ({ id: d.id, label: d.label, option: d.options[p.genome[i]].label, changed: p.genome[i] !== 0 })),
      delayMs: p.delayMs,
      delayAxes: p.delayAxes,
      bandLossDb: p.bandLossDb,
      estimatedNoiseRms: p.rawNoiseRms,
      noise: p.verified.noise,
      noiseRms: p.verified.noiseRms,
    };
  }

  result() {
    const points = this.points;
    const verifiedIdx = [];
    points.forEach((p, i) => {
      if (p.verified) verifiedIdx.push(i);
    });
    const verifiedPoints = verifiedIdx.map((i) => points[i]);
    const front = paretoFront(
      verifiedPoints,
      (p) => p.verified.noiseRms,
      (p) => this.feasible(p),
    ).map((i) => verifiedIdx[i]);
    const estimatedFront = paretoFront(points, undefined, (p) => this.feasible(p));

    return {
      elapsedMs: this.elapsedMs ?? 0,
      searchMs: this.searchMs ?? 0,
      boundaryHz: this.input.boundaryHz,
      maxBandLossDb: this.opts.maxBandLossDb,
      dynNotchFactors: this.factors ?? null,
      delayHz: this.evaluator.delayHz,
      bucketCount: this.model.buckets.length,
      segmentCount: this.model.segments.length,
      notchPeaks: this.space.peaks,
      searchedDims: this.space.dims.filter((d) => d.options.length > 1).map((d) => d.id),
      unfiltered: this.evaluator.unfiltered(),
      evaluated: points.length,
      // every scored setup (estimated), for the chart's background
      cloud: {
        delayMs: Float32Array.from(points, (p) => p.delayMs),
        noiseRms: Float32Array.from(points, (p) => p.noiseRms),
        feasible: Uint8Array.from(points, (p) => (this.feasible(p) ? 1 : 0)),
      },
      estimatedFront: estimatedFront.map((i) => ({ index: i, delayMs: points[i].delayMs, noiseRms: points[i].noiseRms, verified: !!points[i].verified })),
      logIndex: this.logIndex,
      verified: verifiedIdx.map((i) => this.describe(i)),
      front,
    };
  }
}

/** One-shot search (tests, and anything that doesn't need verifyNear later). */
export function runFilterSearch(input, onProgress) {
  return new FilterSearch(input).run(onProgress);
}
