// Band-limited resampling between the blackbox log rate and the firmware filter rate.
//
// The firmware filters run at gyro.filterRateHz (typically 2 kHz) but the log only holds every
// Nth sample. To run the filters with their real coefficients we interpolate the logged gyro up to
// the filter rate with a Lanczos windowed sinc. The interpolated signal passes exactly through the
// logged samples and has no content above the log Nyquist frequency - anything that was above it
// in flight is already aliased into the log and cannot be recovered.

const DEFAULT_HALF_WIDTH = 16; // sinc lobes on each side
const PHASES = 512; // fractional positions with a precomputed kernel

function sinc(x) {
  if (x === 0) return 1;
  const px = Math.PI * x;
  return Math.sin(px) / px;
}

function buildKernels(halfWidth) {
  const taps = 2 * halfWidth;
  const kernels = new Array(PHASES + 1);
  for (let p = 0; p <= PHASES; p++) {
    const frac = p / PHASES;
    const k = new Float64Array(taps);
    let sum = 0;
    for (let t = 0; t < taps; t++) {
      // input sample offset relative to floor(position)
      const d = t - halfWidth + 1 - frac;
      const w = Math.abs(d) < halfWidth ? sinc(d) * sinc(d / halfWidth) : 0;
      k[t] = w;
      sum += w;
    }
    // unity DC gain
    for (let t = 0; t < taps; t++) k[t] /= sum;
    kernels[p] = k;
  }
  return kernels;
}

const kernelCache = new Map();

function getKernels(halfWidth) {
  let k = kernelCache.get(halfWidth);
  if (!k) {
    k = buildKernels(halfWidth);
    kernelCache.set(halfWidth, k);
  }
  return k;
}

/**
 * Interpolate `input` (sampled at 1 unit) at fractional position `pos`.
 */
function sampleAt(input, pos, kernels, halfWidth) {
  const n = input.length;
  const base = Math.floor(pos);
  const frac = pos - base;
  const phase = Math.round(frac * PHASES);
  // phase === PHASES is the next integer sample
  const kernel = kernels[phase];
  const first = base - halfWidth + 1;
  let acc = 0;
  for (let t = 0; t < kernel.length; t++) {
    let i = first + t;
    if (i < 0) i = 0;
    else if (i >= n) i = n - 1;
    acc += kernel[t] * input[i];
  }
  return acc;
}

/**
 * Upsample by `ratio` (output rate / input rate, >= 1, need not be an integer).
 * Output sample m sits at input position m / ratio, so output[round(k * ratio)] lines up with
 * input[k] whenever ratio is an integer.
 */
export function upsample(input, ratio, halfWidth = DEFAULT_HALF_WIDTH) {
  const n = input.length;
  if (n === 0) return new Float64Array(0);
  const outLength = Math.floor((n - 1) * ratio) + 1;
  const out = new Float64Array(outLength);
  const kernels = getKernels(halfWidth);
  const isInteger = Math.abs(ratio - Math.round(ratio)) < 1e-9;
  const r = Math.round(ratio);

  for (let m = 0; m < outLength; m++) {
    if (isInteger && m % r === 0) {
      out[m] = input[m / r];
    } else {
      out[m] = sampleAt(input, m / ratio, kernels, halfWidth);
    }
  }
  return out;
}

/** Linear interpolation of a slowly varying signal (e.g. headspeed) onto the upsampled grid. */
export function upsampleLinear(input, ratio) {
  const n = input.length;
  if (n === 0) return new Float64Array(0);
  const outLength = Math.floor((n - 1) * ratio) + 1;
  const out = new Float64Array(outLength);
  for (let m = 0; m < outLength; m++) {
    const pos = m / ratio;
    const i = Math.floor(pos);
    const f = pos - i;
    const a = input[i];
    const b = i + 1 < n ? input[i + 1] : a;
    out[m] = a + (b - a) * f;
  }
  return out;
}

/**
 * Point-sample the high rate signal back at the logged instants, exactly like the blackbox
 * recorder does (no anti-alias filtering). `count` is the original log sample count.
 */
export function decimate(input, ratio, count) {
  const out = new Float64Array(count);
  const isInteger = Math.abs(ratio - Math.round(ratio)) < 1e-9;
  const r = Math.round(ratio);
  for (let k = 0; k < count; k++) {
    if (isInteger) {
      out[k] = input[Math.min(k * r, input.length - 1)];
    } else {
      const pos = k * ratio;
      const i = Math.floor(pos);
      const f = pos - i;
      const a = input[Math.min(i, input.length - 1)];
      const b = input[Math.min(i + 1, input.length - 1)];
      out[k] = a + (b - a) * f;
    }
  }
  return out;
}
