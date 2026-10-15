// Builds the data for the shared GraphSpectrumPlot.
//
// "linear" is the Analyser's Frequency view: the unfiltered gyro as the bar spectrum, with the
// imagined and logged filtered gyro (and optionally the unfiltered gyro) as overlay lines.
// "db" uses the Analyser's power spectral density view, where every series is a line on a dB axis,
// which makes the attenuation of each filter easy to read.

import { amplitudeSpectrum, welchPsd } from "./analysis.js";

const AXIS_NAMES = ["Roll", "Pitch", "Yaw"];

// Drawn in this order. The logged line is wider and drawn before the imagined one, so when the
// imagined settings reproduce the log the orange line still shows on top of a blue edge.
export const CURVE_STYLE = Object.freeze({
  unfiltered: { name: "Unfiltered", color: "White", lineWidth: 1 },
  logged: { name: "Logged filtered", color: "#4dabf7", lineWidth: 3 },
  imagined: { name: "Imagined", color: "#ff9f40", lineWidth: 1.5 },
});

const SCALE_FROM_HZ = 10; // ignore stick movement when choosing the vertical scale
const TARGET_HEIGHT = 90; // the plot's full height is 100 at zoom 1
const OVERLAY_POINTS = 4096; // overlay lines are reduced to about this many points
const OVERLAY_SMOOTHING = 3; // moving average width (points) for the overlay lines
const PSD_SEGMENT = 1024;
const PSD_FLOOR_DB = -80;

// Peak envelope: the largest magnitude in each group of bins, so narrow peaks keep their height.
function envelopePoints(magnitudes, binHz, scale) {
  const group = Math.max(1, Math.round(magnitudes.length / OVERLAY_POINTS));
  const points = [];
  for (let i = 0; i < magnitudes.length; i += group) {
    let peak = 0;
    const end = Math.min(magnitudes.length, i + group);
    for (let k = i; k < end; k++) if (magnitudes[k] > peak) peak = magnitudes[k];
    points.push({ x: ((i + end - 1) / 2) * binHz, y: peak * scale });
  }
  return points;
}

function series(data, imagined, axis, show) {
  const list = [];
  if (show.unfiltered) list.push({ style: CURVE_STYLE.unfiltered, samples: data.raw[axis] });
  if (show.logged && data.logged) list.push({ style: CURVE_STYLE.logged, samples: data.logged[axis] });
  if (show.imagined && imagined) list.push({ style: CURVE_STYLE.imagined, samples: imagined.filtered[axis] });
  return list;
}

// The Analyser's default curve for a gyro field maps the field's whole-log min..max onto -1..1
// (graph_config.js getCurveForMinMaxFields, grapher.js), and lookupRaw() divides by half that range.
// A workspace can override the range, so this matches the Analyser's default only.
function analyserInputRange(samples) {
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < samples.length; i++) {
    if (samples[i] < min) min = samples[i];
    if (samples[i] > max) max = samples[i];
  }
  const half = (max - min) / 2;
  return { half: half > 0 ? half : 1, offset: -(max + min) / 2 };
}

function buildLinear({ data, imagined, axis, range, rateHz, show, analyserStyle }) {
  const { start, end } = range;
  // Imagine style: Hann window, average removed, tallest peak above 10 Hz at 90% height.
  // Analyser style: the Analyser's own window setting, no average removal, absolute FFT magnitude
  // of the curve-normalised samples, so large peaks clip just like in the main app.
  const curve = analyserStyle ? analyserInputRange(data.raw[axis]) : null;
  const spectrumOptions = analyserStyle
    ? { window: !!analyserStyle.hanning, removeMean: false, raw: true, offset: curve.offset }
    : {};
  const raw = amplitudeSpectrum(data.raw[axis], start, end, 2048, spectrumOptions);
  const bins = raw.binCount;
  const binHz = rateHz / 2 / bins;

  let peak = 0;
  const firstScaleBin = Math.ceil(SCALE_FROM_HZ / binHz);
  const firstNoiseBin = Math.min(bins - 1, Math.ceil(100 / binHz)); // as the Analyser: ignore < 100 Hz
  let maxNoiseIdx = firstNoiseBin;
  for (let i = firstScaleBin; i < bins; i++) {
    if (raw.magnitudes[i] > peak) peak = raw.magnitudes[i];
    if (i >= firstNoiseBin && raw.magnitudes[i] > raw.magnitudes[maxNoiseIdx]) maxNoiseIdx = i;
  }
  let scale = peak > 0 ? TARGET_HEIGHT / peak : 1;
  if (analyserStyle) scale = 1 / curve.half;

  const scaled = new Float64Array(bins);
  for (let i = 0; i < bins; i++) scaled[i] = raw.magnitudes[i] * scale;

  const fftData = {
    fieldIndex: axis,
    fieldName: `Unfiltered Gyro [${AXIS_NAMES[axis].toLowerCase()}]`,
    fftLength: bins,
    fftOutput: scaled,
    maxNoiseFrequency: maxNoiseIdx * binHz,
    blackBoxRate: rateHz,
  };

  const curves = [];
  const colors = [];
  for (const s of series(data, imagined, axis, show)) {
    const spec = s.samples === data.raw[axis] ? raw : amplitudeSpectrum(s.samples, start, end, 2048, spectrumOptions);
    curves.push({
      name: s.style.name,
      points: envelopePoints(spec.magnitudes, binHz, scale),
      smoothPoints: OVERLAY_SMOOTHING,
      lineWidth: s.style.lineWidth,
    });
    colors.push(s.style.color);
  }
  return { fftData, curves, colors };
}

function toDb(psd) {
  const out = new Float64Array(psd.length);
  for (let i = 0; i < psd.length; i++) out[i] = psd[i] > 0 ? Math.max(PSD_FLOOR_DB, 10 * Math.log10(psd[i])) : PSD_FLOOR_DB;
  return out;
}

function buildDb({ data, imagined, axis, range, rateHz, show }) {
  const { start, end } = range;
  const rawPsd = welchPsd(data.raw[axis], start, end, rateHz, PSD_SEGMENT);
  const rawDb = toDb(rawPsd.psd);
  const firstNoiseBin = Math.min(rawDb.length - 1, Math.ceil(100 / rawPsd.binHz));
  let maxNoiseIdx = firstNoiseBin;
  for (let i = firstNoiseBin; i < rawDb.length; i++) if (rawDb[i] > rawDb[maxNoiseIdx]) maxNoiseIdx = i;

  const curves = [];
  const colors = [];
  const list = series(data, imagined, axis, { ...show, unfiltered: true });
  let minimum = Infinity;
  let maximum = -Infinity;
  for (const s of list) {
    const db = s.samples === data.raw[axis] ? rawDb : toDb(welchPsd(s.samples, start, end, rateHz, PSD_SEGMENT).psd);
    const points = [];
    for (let i = 1; i < db.length; i++) {
      points.push({ x: i * rawPsd.binHz, y: db[i] });
      if (db[i] < minimum) minimum = db[i];
      if (db[i] > maximum) maximum = db[i];
    }
    curves.push({ name: s.style.name, points, lineWidth: s.style.lineWidth });
    colors.push(s.style.color);
  }

  const fftData = {
    fieldIndex: axis,
    fieldName: `Gyro [${AXIS_NAMES[axis].toLowerCase()}] PSD`,
    fftLength: rawDb.length,
    fftOutput: rawDb,
    blackBoxRate: rateHz,
    minimum,
    maximum,
    maxNoiseFrequency: maxNoiseIdx * rawPsd.binHz,
  };
  return { fftData, curves, colors };
}

/**
 * @param {object} p
 *   data, imagined, axis, range {start, end}, rateHz,
 *   show {unfiltered, imagined, logged}, mode "linear" | "db",
 *   analyserStyle null, or {hanning} to draw the Linear view like the main Analyser
 * @returns {{fftData, curves, colors}}
 */
export function buildSpectrumView(p) {
  return p.mode === "db" ? buildDb(p) : buildLinear(p);
}

/** sysConfig-shaped object so the plot can draw the filter cutoff markers for these settings. */
export function markerSysConfig(settings) {
  const dyn = settings.lpf1.type && settings.lpf1.dynMinHz > 0;
  return {
    gyro_soft_type: settings.lpf1.type,
    gyro_lowpass_hz: settings.lpf1.type ? settings.lpf1.staticHz : 0,
    gyro_lowpass_dyn_hz: dyn ? [settings.lpf1.dynMinHz, settings.lpf1.dynMaxHz] : [0, 0],
    gyro_lowpass_dyn_expo: 0,
    gyro_soft2_type: settings.lpf2.type,
    gyro_lowpass2_hz: settings.lpf2.type ? settings.lpf2.staticHz : 0,
    gyro_notch_hz: [settings.notch1.hz, settings.notch2.hz],
    gyro_notch_cutoff: [settings.notch1.cutoff, settings.notch2.cutoff],
  };
}
