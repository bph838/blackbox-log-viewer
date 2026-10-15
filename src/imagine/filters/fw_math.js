// Port of the Rotorflight fast trig approximations (src/main/common/maths.c).
// The firmware builds the "minimum degree" polynomials (the `#if 0` Taylor variants are unused),
// and every filter coefficient is computed through them, so we use the same ones here.
//
// Reference: rotorflight-firmware RF-4.6.x @ 53fd0637 (release/4.6.0 + 1).

export const M_PIf = Math.PI;
export const M_PI2f = Math.PI / 2;
export const M_2PIf = 2 * Math.PI;
export const M_1_2PIf = 1 / (2 * Math.PI);
export const M_2_PIf = 2 / Math.PI;

function sinPoly(r) {
  const c1 = 1.570788468983057;
  const c3 = -0.645711990181946;
  const c5 = 0.077667393626301;
  const r2 = r * r;
  return r * (c1 + r2 * (c3 + r2 * c5));
}

function cosPoly(r) {
  const c2 = -1.233697953970536;
  const c4 = 0.253606361920527;
  const c6 = -0.020426250304794;
  const r2 = r * r;
  return 1 + r2 * (c2 + r2 * (c4 + r2 * c6));
}

// C roundf() rounds half away from zero; Math.round() rounds half up.
function roundf(x) {
  return x < 0 ? -Math.round(-x) : Math.round(x);
}

export function sincosApprox(rad) {
  const x = rad * M_2_PIf;
  const q = roundf(x);
  const r = x - q;
  const i = q | 0;
  const s = sinPoly(r);
  const c = cosPoly(r);
  const sin = i & 1 ? c : s;
  const cos = i & 1 ? -s : c;
  return i & 2 ? { sin: -sin, cos: -cos } : { sin, cos };
}

export function tanApprox(rad) {
  const x = rad * M_2_PIf;
  const q = roundf(x);
  const r = x - q;
  const i = q | 0;
  const s = sinPoly(r);
  const c = cosPoly(r);
  return i & 1 ? -c / s : s / c;
}

export function constrain(value, min, max) {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

// maths.h transition(): linear map of src from [srcMin, srcMax] onto [dstMin, dstMax], clamped.
export function transition(src, srcMin, srcMax, dstMin, dstMax) {
  if (src > srcMax) return dstMax;
  if (src < srcMin) return dstMin;
  return ((src - srcMin) * (dstMax - dstMin)) / (srcMax - srcMin) + dstMin;
}
