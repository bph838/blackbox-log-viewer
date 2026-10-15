// Spectra and validation metrics for Imagine. Uses the app's shared FFT implementation.

import { FFTComplex } from "../fft_complex.js";

const fftCache = new Map();

function getFft(n) {
  let fft = fftCache.get(n);
  if (!fft) {
    fft = new FFTComplex(n, false);
    fftCache.set(n, fft);
  }
  return fft;
}

export function nextPow2(n) {
  return 2 ** Math.ceil(Math.log2(Math.max(2, n)));
}

function hann(n) {
  const w = new Float64Array(n);
  if (n === 1) {
    w[0] = 1;
    return w;
  }
  for (let i = 0; i < n; i++) w[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (n - 1)));
  return w;
}

/**
 * Single FFT amplitude spectrum over the whole range (like the Analyser "Frequency" view).
 *
 * Default: Hann window, average removed, amplitudes in deg/s (coherent gain corrected).
 * Analyser style ({window: <Analyser Hanning setting>, removeMean: false, raw: true}) returns the
 * plain FFT magnitude, exactly as GraphSpectrumCalc does.
 */
export function amplitudeSpectrum(samples, start, end, minLength = 2048, options = {}) {
  const { window = true, removeMean = true, raw = false, offset = 0 } = options;
  const count = Math.max(0, end - start);
  const n = nextPow2(Math.max(count, minLength));
  const input = new Float64Array(n);
  const w = window ? hann(count) : new Float64Array(count).fill(1);
  let wsum = 0;
  // value subtracted from every sample: the average, or minus the Analyser curve offset
  let mean = -offset;
  if (removeMean) {
    mean = 0;
    for (let i = 0; i < count; i++) mean += samples[start + i];
    mean = count ? mean / count : 0;
  }
  for (let i = 0; i < count; i++) {
    input[i] = (samples[start + i] - mean) * w[i];
    wsum += w[i];
  }
  const output = new Float64Array(2 * n);
  getFft(n).simple(output, input, "real");
  const half = n / 2;
  const mags = new Float64Array(half);
  let scale = wsum > 0 ? 2 / wsum : 0;
  if (raw) scale = 1;
  for (let i = 0; i < half; i++) {
    mags[i] = Math.hypot(output[2 * i], output[2 * i + 1]) * scale;
  }
  return { magnitudes: mags, binCount: half };
}

/**
 * Welch power spectral density (one sided), deg²/s² per Hz.
 */
export function welchPsd(samples, start, end, rateHz, segment = 1024) {
  const count = end - start;
  const seg = Math.min(segment, nextPow2(Math.max(16, count)) / 2 || 16);
  const step = seg / 2;
  const w = hann(seg);
  let wss = 0;
  for (let i = 0; i < seg; i++) wss += w[i] * w[i];
  const fft = getFft(seg);
  const input = new Float64Array(seg);
  const output = new Float64Array(2 * seg);
  const bins = seg / 2 + 1;
  const psd = new Float64Array(bins);
  let segments = 0;

  for (let s = start; s + seg <= end; s += step) {
    let mean = 0;
    for (let i = 0; i < seg; i++) mean += samples[s + i];
    mean /= seg;
    for (let i = 0; i < seg; i++) input[i] = (samples[s + i] - mean) * w[i];
    fft.simple(output, input, "real");
    for (let k = 0; k < bins; k++) {
      const re = output[2 * k];
      const im = output[2 * k + 1];
      psd[k] += re * re + im * im;
    }
    segments++;
  }

  const norm = segments > 0 ? 1 / (segments * rateHz * wss) : 0;
  for (let k = 0; k < bins; k++) {
    psd[k] *= norm * (k === 0 || k === bins - 1 ? 1 : 2);
  }
  return { psd, binHz: rateHz / seg, segments };
}

/** RMS (deg/s) of the PSD between two frequencies. */
export function bandRms(psdResult, fromHz, toHz) {
  const { psd, binHz } = psdResult;
  let sum = 0;
  for (let k = 0; k < psd.length; k++) {
    const f = k * binHz;
    if (f >= fromHz && f < toHz) sum += psd[k] * binHz;
  }
  return Math.sqrt(sum);
}

export const VALIDATION_BANDS = Object.freeze([
  [5, 20],
  [20, 50],
  [50, 100],
  [100, 150],
  [150, 200],
  [200, 250],
]);

function db(ratio) {
  return ratio > 0 ? 20 * Math.log10(ratio) : -Infinity;
}

/**
 * Compares simulated filtered gyro with the logged filtered gyro for one axis.
 * Skips the first `settleSamples` so filter start-up transients don't count.
 */
export function compareAxis({ unfiltered, simulated, logged, start, end, rateHz }) {
  const nyquist = rateHz / 2;
  const n = end - start;
  const diff = new Float64Array(simulated.length);
  let sumSq = 0;
  let sumLog = 0;
  let sumSim = 0;
  let sumLogSq = 0;
  let sumSimSq = 0;
  let sumCross = 0;
  for (let i = start; i < end; i++) {
    const d = simulated[i] - logged[i];
    diff[i] = d;
    sumSq += d * d;
    sumLog += logged[i];
    sumSim += simulated[i];
  }
  const meanLog = sumLog / n;
  const meanSim = sumSim / n;
  for (let i = start; i < end; i++) {
    const a = logged[i] - meanLog;
    const b = simulated[i] - meanSim;
    sumLogSq += a * a;
    sumSimSq += b * b;
    sumCross += a * b;
  }

  const psdLog = welchPsd(logged, start, end, rateHz);
  const psdSim = welchPsd(simulated, start, end, rateHz);
  const psdRaw = welchPsd(unfiltered, start, end, rateHz);
  const psdDiff = welchPsd(diff, start, end, rateHz);

  const bands = VALIDATION_BANDS.filter(([lo]) => lo < nyquist).map(([lo, hi]) => {
    const top = Math.min(hi, nyquist);
    const raw = bandRms(psdRaw, lo, top);
    const log = bandRms(psdLog, lo, top);
    const sim = bandRms(psdSim, lo, top);
    return {
      fromHz: lo,
      toHz: top,
      unfilteredRms: raw,
      loggedRms: log,
      simulatedRms: sim,
      loggedReductionDb: db(log / raw),
      simulatedReductionDb: db(sim / raw),
      differenceDb: db(sim / log),
    };
  });

  const noiseFrom = 20;
  const loggedNoiseRms = bandRms(psdLog, noiseFrom, nyquist + 1);
  const residualNoiseRms = bandRms(psdDiff, noiseFrom, nyquist + 1);

  return {
    samples: n,
    rmsError: Math.sqrt(sumSq / n),
    loggedRms: Math.sqrt(sumLogSq / n),
    correlation: sumCross / Math.sqrt(sumLogSq * sumSimSq || 1),
    loggedNoiseRms,
    residualNoiseRms,
    // share of the logged >20 Hz noise the simulation fails to reproduce
    noiseResidualRatio: loggedNoiseRms > 0 ? residualNoiseRms / loggedNoiseRms : 0,
    bands,
  };
}

/**
 * When the log was recorded with debug_mode = DYN_NOTCH_FREQ the firmware logs the dynamic notch
 * centres (x10) of the debug axis. Compare them with the simulated tracker.
 */
export function compareDynNotchTracking({ debug, centers, count, start, end }) {
  if (!debug || !centers || !count) return null;
  const axis = debug.axis;
  if (axis < 0 || axis > 2) return null;
  const notches = Math.min(count, 8);
  const perNotch = [];
  for (let p = 0; p < notches; p++) {
    const errors = [];
    for (let i = start; i < end; i++) {
      const logged = debug.values[p][i] / 10;
      const sim = centers[i * 3 * count + axis * count + p];
      if (logged > 0) errors.push(Math.abs(sim - logged));
    }
    errors.sort((a, b) => a - b);
    perNotch.push({
      notch: p + 1,
      medianErrorHz: errors.length ? errors[Math.floor(errors.length / 2)] : null,
      p90ErrorHz: errors.length ? errors[Math.floor(errors.length * 0.9)] : null,
    });
  }
  return { axis, perNotch };
}

export function median(values) {
  const v = Array.from(values).filter((x) => Number.isFinite(x));
  if (!v.length) return 0;
  v.sort((a, b) => a - b);
  return v[Math.floor(v.length / 2)];
}
