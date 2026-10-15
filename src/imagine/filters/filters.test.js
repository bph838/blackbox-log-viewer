import { describe, expect, test } from "vitest";
import { sincosApprox, tanApprox, transition } from "./fw_math.js";
import {
  Biquad,
  BIQUAD,
  createLowpassFilter,
  createNotchFilter,
  FirstOrderLPF,
  LPF_TYPE,
  notchFilterGetQ,
  pt1FilterGain,
  Pt1Filter,
} from "./filters.js";
import { DynNotch, lrintf, Sdft } from "./dyn_notch.js";
import { RpmFilter, resolveRpmBanks, RPM_FILTER_PRESETS } from "./rpm_filter.js";
import { decimate, upsample } from "./resample.js";
import { GyroFilterChain, staticNotchParams } from "./gyro_chain.js";
import { simulateGyroFilters } from "../simulate.js";

const FS = 2000;

function db(x) {
  return 20 * Math.log10(x);
}

function mag(h) {
  return Math.hypot(h.re, h.im);
}

// Measure the steady state gain of a filter for a sine wave, in the time domain.
function measuredGain(filter, freq, fs = FS, seconds = 3) {
  const n = Math.round(fs * seconds);
  let inSq = 0;
  let outSq = 0;
  for (let i = 0; i < n; i++) {
    const x = Math.sin((2 * Math.PI * freq * i) / fs);
    const y = filter.apply(x);
    if (i > n / 2) {
      inSq += x * x;
      outSq += y * y;
    }
  }
  return Math.sqrt(outSq / inSq);
}

const offSettings = {
  lpf1: { type: 0, staticHz: 0, dynMinHz: 0, dynMaxHz: 0 },
  lpf2: { type: 0, staticHz: 0 },
  notch1: { hz: 0, cutoff: 0 },
  notch2: { hz: 0, cutoff: 0 },
  dynNotch: { enabled: false, count: 0, q: 20, minHz: 20, maxHz: 200 },
  rpm: { enabled: false, minHz: 20, preset: 0, source: [[], [], []], center: [[], [], []], q: [[], [], []] },
};

describe("firmware maths", () => {
  test("sincos/tan approximations track Math within the polynomial error", () => {
    for (let x = -3; x <= 3; x += 0.01) {
      const { sin, cos } = sincosApprox(x);
      expect(Math.abs(sin - Math.sin(x))).toBeLessThan(2e-4);
      expect(Math.abs(cos - Math.cos(x))).toBeLessThan(2e-4);
    }
    for (let x = -1.2; x <= 1.2; x += 0.01) {
      expect(Math.abs(tanApprox(x) - Math.tan(x)) / Math.max(1, Math.abs(Math.tan(x)))).toBeLessThan(1e-3);
    }
  });

  test("transition clamps and interpolates", () => {
    expect(transition(5, 10, 20, 0, 1)).toBe(0);
    expect(transition(25, 10, 20, 0, 1)).toBe(1);
    expect(transition(15, 10, 20, 0, 1)).toBeCloseTo(0.5);
  });

  test("lrintf rounds half to even", () => {
    expect(lrintf(2.5)).toBe(2);
    expect(lrintf(3.5)).toBe(4);
    expect(lrintf(-2.5)).toBe(-2);
    expect(lrintf(2.4)).toBe(2);
  });
});

describe("lowpass filters", () => {
  test("PT1 gain follows the firmware formula", () => {
    const fc = 100;
    expect(pt1FilterGain(fc, FS)).toBeCloseTo(fc / (fc + FS / (2 * Math.PI)), 10);
    // cutoff limited to 95% of Nyquist
    expect(pt1FilterGain(5000, FS)).toBeCloseTo(pt1FilterGain(0.475 * FS, FS), 10);
    expect(pt1FilterGain(0, FS)).toBe(1);
  });

  test("first order LPF is -3 dB at its (pre-warped) cutoff", () => {
    const f = new FirstOrderLPF(90, FS);
    expect(db(mag(f.response(90, FS)))).toBeCloseTo(-3.01, 1);
  });

  test("Butterworth biquad is -3 dB at the cutoff and Bessel/PT types are defined", () => {
    const butter = createLowpassFilter(LPF_TYPE.BUTTER, 100, FS);
    expect(db(mag(butter.response(100, FS)))).toBeCloseTo(-3.01, 1);
    for (const type of [LPF_TYPE.PT1, LPF_TYPE.PT2, LPF_TYPE.PT3, LPF_TYPE.BESSEL, LPF_TYPE.SECOND_ORDER, LPF_TYPE.DAMPED]) {
      const f = createLowpassFilter(type, 100, FS);
      const g = db(mag(f.response(100, FS)));
      expect(g).toBeLessThan(-1);
      expect(g).toBeGreaterThan(-6);
    }
  });

  test("time domain sine gain matches the computed response", () => {
    for (const type of [LPF_TYPE.FIRST_ORDER, LPF_TYPE.PT1, LPF_TYPE.PT2, LPF_TYPE.PT3, LPF_TYPE.BUTTER, LPF_TYPE.BESSEL, LPF_TYPE.DAMPED]) {
      for (const freq of [20, 80, 200]) {
        const a = createLowpassFilter(type, 90, FS);
        const b = createLowpassFilter(type, 90, FS);
        expect(measuredGain(a, freq)).toBeCloseTo(mag(b.response(freq, FS)), 2);
      }
    }
  });

  test("NONE is a pass-through", () => {
    const f = createLowpassFilter(LPF_TYPE.NONE, 100, FS);
    expect(f.apply(1.234)).toBe(1.234);
  });

  test("PT1 step response settles to the input", () => {
    const f = new Pt1Filter(50, FS);
    let y = 0;
    for (let i = 0; i < 2000; i++) y = f.apply(1);
    expect(y).toBeCloseTo(1, 6);
  });
});

describe("biquad and notch", () => {
  test("DF1 and TF2 give the same output", () => {
    const a = new Biquad(120, FS, 3, BIQUAD.NOTCH, true);
    const b = new Biquad(120, FS, 3, BIQUAD.NOTCH, false);
    for (let i = 0; i < 500; i++) {
      const x = Math.sin(i * 0.37) + 0.3 * Math.cos(i * 1.7);
      expect(a.apply(x)).toBeCloseTo(b.apply(x), 9);
    }
  });

  test("notch Q from centre and cutoff, and a deep null at the centre", () => {
    expect(notchFilterGetQ(260, 160)).toBeCloseTo((260 * 160) / (260 * 260 - 160 * 160), 10);
    expect(notchFilterGetQ(100, 120)).toBe(0);
    const n = createNotchFilter(150, 5, FS);
    expect(mag(n.response(150, FS))).toBeLessThan(0.01);
    expect(mag(n.response(20, FS))).toBeGreaterThan(0.98);
  });

  test("static notch above Nyquist is moved to Nyquist or disabled (gyro_init.c)", () => {
    expect(staticNotchParams(1200, 800, FS).hz).toBe(1000);
    expect(staticNotchParams(1200, 1100, FS).hz).toBe(0);
    expect(staticNotchParams(0, 0, FS).q).toBe(0);
  });
});

describe("dynamic notch", () => {
  test("SDFT finds a pure tone in the right bin", () => {
    const sdft = new Sdft(1, 35, 1);
    const fs = 720; // 10 Hz per bin
    for (let i = 0; i < 500; i++) sdft.push(Math.sin((2 * Math.PI * 100 * i) / fs));
    const out = new Float64Array(36);
    sdft.winSq(out);
    let best = 1;
    for (let b = 1; b < 35; b++) if (out[b] > out[best]) best = b;
    expect(best).toBe(10);
  });

  test("tracks and removes a tone", () => {
    const dn = new DynNotch({ count: 2, q: 40, minHz: 30, maxHz: 200 }, FS, FS);
    expect(dn.isActive()).toBe(true);
    const tone = 87;
    let inSq = 0;
    let outSq = 0;
    const n = FS * 4;
    for (let i = 0; i < n; i++) {
      const x = 10 * Math.sin((2 * Math.PI * tone * i) / FS);
      const y = [0, 1, 2].map((axis) => dn.filter(axis, x))[0];
      dn.update();
      if (i > n / 2) {
        inSq += x * x;
        outSq += y * y;
      }
    }
    const nearest = Math.min(...Array.from(dn.centerFreq[0]).map((f) => Math.abs(f - tone)));
    expect(nearest).toBeLessThan(2);
    expect(db(Math.sqrt(outSq / inSq))).toBeLessThan(-20);
  });

  test("is disabled below a 1 kHz PID loop", () => {
    const dn = new DynNotch({ count: 4, q: 25, minHz: 20, maxHz: 120 }, 500, 500);
    expect(dn.isActive()).toBe(false);
    expect(dn.disabledReason).toMatch(/below 1000 Hz/);
  });
});

describe("RPM filter", () => {
  const rotor = { mainGearRatio: 1 / 10, tailGearRatio: null, motorisedTail: false, hasTailSpeed: true };
  const config = {
    minHz: 20,
    preset: 0,
    source: [[11, 21], [11], [11]],
    center: [[0, 0], [0], [0]],
    q: [[100, 50], [100], [100]],
  };

  test("places main and tail rotor notches from rotor speeds", () => {
    const rpm = new RpmFilter(config, FS, rotor);
    expect(rpm.totalBankCount).toBe(4);
    for (let i = 0; i < 10; i++) rpm.update(2000, 9000);
    expect(rpm.banks[0][0].center).toBeCloseTo(2000 / 60, 6);
    expect(rpm.banks[0][1].center).toBeCloseTo(9000 / 60, 6);
    expect(rpm.banks[0][0].fader).toBe(1);
  });

  test("removes the rotor tone and fades out below min Hz", () => {
    const rpm = new RpmFilter(config, FS, rotor);
    const f0 = 2000 / 60;
    let inSq = 0;
    let outSq = 0;
    const n = FS * 3;
    for (let i = 0; i < n; i++) {
      rpm.update(2000, 9000);
      const x = Math.sin((2 * Math.PI * f0 * i) / FS);
      const y = rpm.filter(1, x);
      if (i > n / 2) {
        inSq += x * x;
        outSq += y * y;
      }
    }
    expect(db(Math.sqrt(outSq / inSq))).toBeLessThan(-30);

    const slow = new RpmFilter(config, FS, rotor);
    for (let i = 0; i < 10; i++) slow.update(600, 2700); // 10 Hz < min 20 Hz
    expect(slow.banks[0][0].fader).toBe(0);
  });

  test("tail notches are skipped without a tail speed, presets resolve", () => {
    const rpm = new RpmFilter(config, FS, { ...rotor, hasTailSpeed: false });
    expect(rpm.totalBankCount).toBe(3);
    expect(rpm.skipped[0].reason).toMatch(/tail/);
    const banks = resolveRpmBanks({ preset: 2 });
    expect(banks.source[0].slice(0, 7)).toEqual(RPM_FILTER_PRESETS[1].source[0].slice(0, 7));
  });
});

describe("resampling and simulation", () => {
  test("upsampling passes through the logged samples and reconstructs a band-limited sine", () => {
    const fsLog = 500;
    const n = 2000;
    const x = new Float64Array(n);
    for (let i = 0; i < n; i++) x[i] = Math.sin((2 * Math.PI * 60 * i) / fsLog);
    const up = upsample(x, 4);
    for (let i = 0; i < n; i++) expect(up[i * 4]).toBe(x[i]);
    let maxErr = 0;
    for (let m = 400; m < up.length - 400; m++) {
      maxErr = Math.max(maxErr, Math.abs(up[m] - Math.sin((2 * Math.PI * 60 * m) / (fsLog * 4))));
    }
    expect(maxErr).toBeLessThan(0.01);
    expect(Array.from(decimate(up, 4, n))).toEqual(Array.from(x));
  });

  test("with every filter off the simulation returns the input", () => {
    const n = 1000;
    const raw = [0, 1, 2].map((a) => Float64Array.from({ length: n }, (_, i) => Math.sin(i * 0.1 * (a + 1)) * 50));
    const res = simulateGyroFilters({
      raw,
      headspeed: new Float64Array(n),
      tailspeed: null,
      rates: { logRateHz: 500, filterRateHz: 2000, pidRateHz: 2000 },
      settings: offSettings,
      rotor: {},
    });
    for (let a = 0; a < 3; a++) {
      for (let i = 0; i < n; i++) expect(res.filtered[a][i]).toBeCloseTo(raw[a][i], 9);
    }
  });

  test("filter order matches the firmware: RPM, LPF2, LPF1, notch 2, notch 1, dynamic notch", () => {
    const chain = new GyroFilterChain(
      {
        ...offSettings,
        lpf1: { type: LPF_TYPE.PT1, staticHz: 100, dynMinHz: 0, dynMaxHz: 0 },
        lpf2: { type: LPF_TYPE.PT1, staticHz: 300, dynMinHz: 0 },
      },
      { filterRateHz: FS, pidRateHz: FS },
      {},
    );
    const calls = [];
    chain.lpf2[0].apply = (x) => (calls.push("lpf2"), x);
    chain.lpf1[0].apply = (x) => (calls.push("lpf1"), x);
    chain.notch2[0].apply = (x) => (calls.push("notch2"), x);
    chain.notch1[0].apply = (x) => (calls.push("notch1"), x);
    chain.filterAxis(0, 1);
    expect(calls).toEqual(["lpf2", "lpf1", "notch2", "notch1"]);
  });
});
