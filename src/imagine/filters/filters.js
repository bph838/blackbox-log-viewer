// Port of the Rotorflight filter library (src/main/common/filter.c, filter.h) used by the gyro
// pipeline: PT1/PT2/PT3, first order LPF, biquad (LPF/notch) and the generic lowpass factory.
//
// Each filter object exposes:
//   apply(x)              - process one sample, exactly like the firmware apply function
//   update(cutoff, rate)  - recompute coefficients (no-op where the firmware uses nilFilterUpdate)
//   response(f, rate)     - complex frequency response {re, im} of the current coefficients
//
// Reference: rotorflight-firmware RF-4.6.x @ 53fd0637 (release/4.6.0 + 1).

import { M_1_2PIf, M_2PIf, M_PIf, sincosApprox, tanApprox } from "./fw_math.js";

export const BUTTER_Q = 0.707106781;
export const BESSEL_Q = 0.577350269;
export const DAMPED_Q = 0.5;
export const BUTTER_C = 1.0;
export const BESSEL_C = 1.272019649;
export const DAMPED_C = 1.553773974;
export const BESSEL_4A_Q = 0.805538282;
export const BESSEL_4B_Q = 0.521934582;
export const BESSEL_4A_C = 1.603357516;
export const BESSEL_4B_C = 1.43017156;

// Lowpass filter types - index order matches the firmware enum and the CLI lookup table.
export const LPF_TYPE = Object.freeze({
  NONE: 0,
  FIRST_ORDER: 1,
  SECOND_ORDER: 2,
  PT1: 3,
  PT2: 4,
  PT3: 5,
  ORDER1: 6,
  BUTTER: 7,
  BESSEL: 8,
  DAMPED: 9,
});

export const LPF_TYPE_NAMES = Object.freeze([
  "NONE",
  "FIRST_ORDER",
  "SECOND_ORDER",
  "PT1",
  "PT2",
  "PT3",
  "ORDER1",
  "BUTTER",
  "BESSEL",
  "DAMPED",
]);

export const BIQUAD = Object.freeze({ NULL: 0, LPF: 1, HPF: 2, BPF: 3, NOTCH: 4 });

// 95% of Nyquist
export function limitCutoff(cutoff, sampleRate) {
  return Math.min(cutoff, 0.475 * sampleRate);
}

// ---- complex helpers for frequency responses ----

function cmul(a, b) {
  return { re: a.re * b.re - a.im * b.im, im: a.re * b.im + a.im * b.re };
}

function cdiv(a, b) {
  const d = b.re * b.re + b.im * b.im;
  return { re: (a.re * b.re + a.im * b.im) / d, im: (a.im * b.re - a.re * b.im) / d };
}

const ONE = Object.freeze({ re: 1, im: 0 });

// Evaluate (b0 + b1 z^-1 + b2 z^-2) / (1 + a1 z^-1 + a2 z^-2) at z = e^{j w}
function iirResponse(b, a, freq, sampleRate) {
  const w = (2 * Math.PI * freq) / sampleRate;
  const z1 = { re: Math.cos(w), im: -Math.sin(w) };
  const z2 = { re: Math.cos(2 * w), im: -Math.sin(2 * w) };
  const num = {
    re: b[0] + b[1] * z1.re + (b[2] ?? 0) * z2.re,
    im: b[1] * z1.im + (b[2] ?? 0) * z2.im,
  };
  const den = {
    re: 1 + a[0] * z1.re + (a[1] ?? 0) * z2.re,
    im: a[0] * z1.im + (a[1] ?? 0) * z2.im,
  };
  return cdiv(num, den);
}

export function multiplyResponses(responses) {
  return responses.reduce((acc, h) => cmul(acc, h), ONE);
}

// ---- NIL ----

export class NilFilter {
  constructor() {
    this.y1 = 0;
  }
  apply(input) {
    this.y1 = input;
    return input;
  }
  update() {}
  response() {
    return { ...ONE };
  }
}

// ---- PTn ----

export function pt1FilterGain(cutoff, sampleRate) {
  if (cutoff > 0 && sampleRate > 0) {
    cutoff = limitCutoff(cutoff, sampleRate);
    const gamma = M_1_2PIf * sampleRate;
    const alpha = cutoff / (cutoff + gamma);
    return Math.min(alpha, 1.0);
  }
  return 1.0;
}

export function pt2FilterGain(cutoff, sampleRate) {
  return pt1FilterGain(cutoff * 1.553773974, sampleRate);
}

export function pt3FilterGain(cutoff, sampleRate) {
  return pt1FilterGain(cutoff * 1.961459177, sampleRate);
}

class PtFilter {
  constructor(order, gainFn, cutoff, sampleRate) {
    this.order = order;
    this.gainFn = gainFn;
    this.y = new Float64Array(order);
    this.gain = gainFn(cutoff, sampleRate);
  }
  apply(input) {
    const g = this.gain;
    const y = this.y;
    // firmware order: the stage nearest the input is updated first (y3 -> y2 -> y1)
    let x = input;
    for (let i = this.order - 1; i >= 0; i--) {
      y[i] += (x - y[i]) * g;
      x = y[i];
    }
    return x;
  }
  update(cutoff, sampleRate) {
    this.gain = this.gainFn(cutoff, sampleRate);
  }
  response(freq, sampleRate) {
    const g = this.gain;
    const stage = iirResponse([g, 0], [-(1 - g)], freq, sampleRate);
    let h = { ...ONE };
    for (let i = 0; i < this.order; i++) h = cmul(h, stage);
    return h;
  }
}

export class Pt1Filter extends PtFilter {
  constructor(cutoff, sampleRate) {
    super(1, pt1FilterGain, cutoff, sampleRate);
  }
}
export class Pt2Filter extends PtFilter {
  constructor(cutoff, sampleRate) {
    super(2, pt2FilterGain, cutoff, sampleRate);
  }
}
export class Pt3Filter extends PtFilter {
  constructor(cutoff, sampleRate) {
    super(3, pt3FilterGain, cutoff, sampleRate);
  }
}

// ---- First order (bilinear) LPF ----

export class FirstOrderLPF {
  constructor(cutoff, sampleRate, updatable = false) {
    this.x1 = 0;
    this.y1 = 0;
    this.updatable = updatable;
    this.setCoefficients(cutoff, sampleRate);
  }
  setCoefficients(cutoff, sampleRate) {
    if (cutoff > 0 && sampleRate > 0) {
      cutoff = limitCutoff(cutoff, sampleRate);
      const W = tanApprox((M_PIf * cutoff) / sampleRate);
      this.a1 = (W - 1) / (W + 1);
      this.b0 = W / (W + 1);
      this.b1 = this.b0;
    } else {
      this.b0 = 1;
      this.b1 = 0;
      this.a1 = 0;
    }
  }
  apply(input) {
    const output = this.b0 * input + this.b1 * this.x1 - this.a1 * this.y1;
    this.x1 = input;
    this.y1 = output;
    return output;
  }
  update(cutoff, sampleRate) {
    // Without LPF_UPDATE the firmware installs nilFilterUpdate - coefficients stay fixed.
    if (this.updatable) this.setCoefficients(cutoff, sampleRate);
  }
  response(freq, sampleRate) {
    return iirResponse([this.b0, this.b1], [this.a1], freq, sampleRate);
  }
}

// ---- Biquad ----

export class Biquad {
  constructor(cutoff, sampleRate, Q, filterType, useDF1 = false) {
    this.x1 = this.x2 = 0;
    this.y1 = this.y2 = 0;
    this.useDF1 = useDF1;
    this.setCoefficients(cutoff, sampleRate, Q, filterType);
  }

  setCoefficients(cutoff, sampleRate, Q, filterType) {
    if (cutoff > 0 && sampleRate > 0 && Q > 0 && filterType > BIQUAD.NULL && filterType <= BIQUAD.NOTCH) {
      cutoff = limitCutoff(cutoff, sampleRate);

      const omega = (M_2PIf * cutoff) / sampleRate;
      const { sin: sinom, cos: cosom } = sincosApprox(omega);
      const alpha = sinom / (2 * Q);
      let b0, b1, b2, a1, a2;

      switch (filterType) {
        case BIQUAD.LPF:
          b1 = 1 - cosom;
          b0 = b1 / 2;
          b2 = b0;
          a1 = -2 * cosom;
          a2 = 1 - alpha;
          break;
        case BIQUAD.HPF:
          b0 = (1 + cosom) / 2;
          b1 = -1 - cosom;
          b2 = b0;
          a1 = -2 * cosom;
          a2 = 1 - alpha;
          break;
        case BIQUAD.BPF:
          b0 = alpha;
          b1 = 0;
          b2 = -alpha;
          a1 = -2 * cosom;
          a2 = 1 - alpha;
          break;
        case BIQUAD.NOTCH:
        default:
          b0 = 1;
          b1 = -2 * cosom;
          b2 = 1;
          a1 = b1;
          a2 = 1 - alpha;
          break;
      }

      const a0 = 1 + alpha;
      this.b0 = b0 / a0;
      this.b1 = b1 / a0;
      this.b2 = b2 / a0;
      this.a1 = a1 / a0;
      this.a2 = a2 / a0;
    } else {
      this.b0 = 1;
      this.b1 = 0;
      this.b2 = 0;
      this.a1 = 0;
      this.a2 = 0;
    }
  }

  // biquadFilterApplyDF1 - used where coefficients change at runtime
  applyDF1(input) {
    const output = this.b0 * input + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
    this.x2 = this.x1;
    this.x1 = input;
    this.y2 = this.y1;
    this.y1 = output;
    return output;
  }

  // biquadFilterApplyTF2 - transposed direct form II, used for static filters
  applyTF2(input) {
    const output = this.b0 * input + this.x1;
    this.x1 = this.b1 * input - this.a1 * output + this.x2;
    this.x2 = this.b2 * input - this.a2 * output;
    this.y1 = output;
    return output;
  }

  apply(input) {
    return this.useDF1 ? this.applyDF1(input) : this.applyTF2(input);
  }

  // Static notches use nilFilterUpdate; runtime updates go through setCoefficients().
  update() {}

  response(freq, sampleRate) {
    return iirResponse([this.b0, this.b1, this.b2], [this.a1, this.a2], freq, sampleRate);
  }
}

// Biquad LPF variants with a fixed Q and a cutoff correction (filter.c biquadXxxLPFInit/Update)
class BiquadLPF extends Biquad {
  constructor(C, Q, cutoff, sampleRate, updatable) {
    super(C * cutoff, sampleRate, Q, BIQUAD.LPF, updatable);
    this.C = C;
    this.Q = Q;
    this.updatable = updatable;
  }
  update(cutoff, sampleRate) {
    if (this.updatable) this.setCoefficients(this.C * cutoff, sampleRate, this.Q, BIQUAD.LPF);
  }
}

// ---- Factory: lowpassFilterInit() ----

/**
 * @param {number} type LPF_TYPE value
 * @param {number} cutoff Hz
 * @param {number} sampleRate Hz
 * @param {boolean} updatable firmware LPF_UPDATE flag (dynamic LPF)
 */
export function createLowpassFilter(type, cutoff, sampleRate, updatable = false) {
  switch (type) {
    case LPF_TYPE.PT1:
      return new Pt1Filter(cutoff, sampleRate);
    case LPF_TYPE.PT2:
      return new Pt2Filter(cutoff, sampleRate);
    case LPF_TYPE.PT3:
      return new Pt3Filter(cutoff, sampleRate);
    case LPF_TYPE.FIRST_ORDER:
    case LPF_TYPE.ORDER1:
      return new FirstOrderLPF(cutoff, sampleRate, updatable);
    case LPF_TYPE.BUTTER:
      return new BiquadLPF(BUTTER_C, BUTTER_Q, cutoff, sampleRate, updatable);
    case LPF_TYPE.SECOND_ORDER:
    case LPF_TYPE.BESSEL:
      return new BiquadLPF(BESSEL_C, BESSEL_Q, cutoff, sampleRate, updatable);
    case LPF_TYPE.DAMPED:
      return new BiquadLPF(DAMPED_C, DAMPED_Q, cutoff, sampleRate, updatable);
    default:
      return new NilFilter();
  }
}

// ---- Notch ----

// Q = f0 / (f2 - f1) ; f2 = f0^2 / f1
export function notchFilterGetQ(centerFreq, cutoffFreq) {
  if (centerFreq > 0 && cutoffFreq > 0 && cutoffFreq < centerFreq) {
    return (centerFreq * cutoffFreq) / (centerFreq * centerFreq - cutoffFreq * cutoffFreq);
  }
  return 0;
}

// notchFilterInit(): a biquad notch; an invalid centre/Q leaves the pass-through coefficients.
export function createNotchFilter(centerHz, Q, sampleRate, updatable = false) {
  return new Biquad(centerHz, sampleRate, Q, BIQUAD.NOTCH, updatable);
}
