// The craft's noise, as the filter search sees it.
//
// The analysed range is cut into overlapping segments (about one second each). Each segment gets a
// Hann windowed power spectrum per axis and its mean rotor speeds. Segments are grouped by
// headspeed into a few buckets, and each bucket keeps its averaged spectrum and operating point.
// RPM notches and the dynamic LPF move with headspeed, so the search scores each bucket at its own
// rotor speed and weights the buckets by how much of the flight they cover.

import { FFTComplex } from "../../fft_complex.js";

export const SPINNING_RPM = 100;
const MAX_BUCKETS = 5;
const SEGMENTS_PER_BUCKET = 8;

function nextPow2(n) {
  return 2 ** Math.ceil(Math.log2(Math.max(2, n)));
}

function hann(n) {
  const w = new Float64Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (n - 1)));
  return w;
}

/** Segment length (samples) for a log rate: about one second, a power of two, at least 128. */
export function segmentLength(logRateHz) {
  return Math.max(128, nextPow2(logRateHz));
}

/**
 * Segment start indices covering [start, end) with 50% overlap.
 */
export function segmentStarts(start, end, length) {
  const starts = [];
  for (let s = start; s + length <= end; s += length / 2) starts.push(s);
  return starts;
}

/**
 * One-sided power spectral density (deg²/s² per Hz) of one segment, added into `out`.
 * Same scaling as analysis.js welchPsd, so band RMS values compare one to one.
 */
export class SegmentSpectrum {
  constructor(length, rateHz) {
    this.length = length;
    this.rateHz = rateHz;
    this.bins = length / 2 + 1;
    this.binHz = rateHz / length;
    this.window = hann(length);
    let wss = 0;
    for (let i = 0; i < length; i++) wss += this.window[i] * this.window[i];
    this.norm = 1 / (rateHz * wss);
    this.fft = new FFTComplex(length, false);
    this.input = new Float64Array(length);
    this.output = new Float64Array(2 * length);
  }

  accumulate(samples, start, out, weight = 1) {
    const n = this.length;
    let mean = 0;
    for (let i = 0; i < n; i++) mean += samples[start + i];
    mean /= n;
    for (let i = 0; i < n; i++) this.input[i] = (samples[start + i] - mean) * this.window[i];
    this.fft.simple(this.output, this.input, "real");
    const last = this.bins - 1;
    for (let k = 0; k <= last; k++) {
      const re = this.output[2 * k];
      const im = this.output[2 * k + 1];
      out[k] += (re * re + im * im) * this.norm * (k === 0 || k === last ? 1 : 2) * weight;
    }
  }
}

function meanOf(values, start, length) {
  let sum = 0;
  for (let i = 0; i < length; i++) sum += values[start + i];
  return sum / length;
}

/**
 * @param {object} p
 *   raw [Float64Array x3]  logged unfiltered gyro
 *   headspeed Float64Array main rotor RPM per sample (zeros when not logged)
 *   tailspeed Float64Array|null tail rotor RPM per sample (measured or headspeed × tail ratio)
 *   logRateHz
 *   start, end            analysed sample range
 *   settleSamples         samples skipped at the start of the log (filter start-up)
 * @returns {{binHz:number, bins:number, length:number, segments:Array, buckets:Array}}
 *   buckets: [{weight, headRpm, tailRpm, segmentCount, psd:[Float64Array x3]}]
 *   segments: [{start, headRpm, tailRpm, bucket}] (the RPM notches are scored per segment, and
 *             full simulations are measured over the same segments)
 *   raw, headspeed, tailspeed: the inputs, kept for the RPM notch pass (see Evaluator._afterRpm)
 */
export function buildNoiseModel({ raw, headspeed, tailspeed, logRateHz, start, end, settleSamples = 0 }) {
  let length = segmentLength(logRateHz);
  const from = Math.max(start, settleSamples);
  while (length > 128 && end - from < 2 * length) length /= 2;
  const starts = segmentStarts(from, end, length);
  if (!starts.length) throw new Error("The analysed range is too short for the filter search.");

  let segments = starts.map((s) => ({
    start: s,
    headRpm: headspeed ? meanOf(headspeed, s, length) : 0,
    tailRpm: tailspeed ? meanOf(tailspeed, s, length) : 0,
    bucket: 0,
  }));

  // Only the part of the flight where the rotor is turning, when the log says so
  const spinning = segments.filter((seg) => seg.headRpm > SPINNING_RPM);
  if (spinning.length >= 4) segments = spinning;

  const bucketCount = Math.max(1, Math.min(MAX_BUCKETS, Math.floor(segments.length / SEGMENTS_PER_BUCKET)));
  const order = [...segments].sort((a, b) => a.headRpm - b.headRpm);
  order.forEach((seg, i) => {
    seg.bucket = Math.min(bucketCount - 1, Math.floor((i * bucketCount) / order.length));
  });

  const buckets = Array.from({ length: bucketCount }, () => ({ weight: 0, headRpm: 0, tailRpm: 0, segmentCount: 0, psd: null }));
  for (const seg of segments) {
    const b = buckets[seg.bucket];
    b.segmentCount++;
    b.headRpm += seg.headRpm;
    b.tailRpm += seg.tailRpm;
  }
  for (const b of buckets) {
    const n = Math.max(1, b.segmentCount);
    b.headRpm /= n;
    b.tailRpm /= n;
    b.weight = b.segmentCount / segments.length;
  }

  const bins = length / 2 + 1;
  const model = { binHz: logRateHz / length, bins, length, logRateHz, segments, buckets, raw, headspeed, tailspeed };
  bucketSpectra(model, raw).forEach((psd, i) => {
    buckets[i].psd = psd;
  });
  return model;
}

/** Averaged spectrum per bucket and axis of three traces, over the model's segments. */
export function bucketSpectra(model, traces) {
  const spectrum = new SegmentSpectrum(model.length, model.logRateHz);
  const out = model.buckets.map(() => [0, 1, 2].map(() => new Float64Array(model.bins)));
  for (const seg of model.segments) {
    const n = Math.max(1, model.buckets[seg.bucket].segmentCount);
    for (let a = 0; a < 3; a++) spectrum.accumulate(traces[a], seg.start, out[seg.bucket][a], 1 / n);
  }
  return out;
}

/**
 * Band RMS (deg/s) per axis of a gyro trace over the model's segments, weighted like the buckets.
 * Used to score a full time-domain simulation the same way the fast estimate is scored.
 */
export function measuredNoise(model, traces, fromHz) {
  const spectrum = new SegmentSpectrum(model.length, model.logRateHz);
  const nyquist = model.logRateHz / 2;
  return [0, 1, 2].map((a) => {
    const psd = new Float64Array(model.bins);
    for (const seg of model.segments) spectrum.accumulate(traces[a], seg.start, psd, 1 / model.segments.length);
    let sum = 0;
    for (let k = 0; k < model.bins; k++) {
      const f = k * model.binHz;
      if (f >= fromHz && f <= nyquist) sum += psd[k] * model.binHz;
    }
    return Math.sqrt(sum);
  });
}

/** RMS of the three axes. */
export function combineAxes(values) {
  return Math.sqrt((values[0] ** 2 + values[1] ** 2 + values[2] ** 2) / 3);
}
