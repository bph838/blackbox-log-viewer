// Fast scoring of one filter setup against the noise model.
//
// The filtered noise of each bucket is estimated in the frequency domain: the bucket's averaged
// gyro spectrum times |H(f)|² of every filter stage, where H comes from the same ported filter
// objects the time-domain simulation runs (filters.js, rpm_filter.js, dyn_notch.js). Moving filters
// are frozen at each bucket's rotor speed. The dynamic notches are placed on the largest peaks
// left after the other filters, which is what the firmware tracker looks for.
//
// Delay is the phase delay of the whole chain, averaged over the flight band (5 Hz steps up to the
// noise boundary), over the buckets and over the three axes.
//
// Stage responses are cached by their parameters, so scoring a setup is mostly array multiplies.

import { createLowpassFilter, createNotchFilter, BIQUAD, Biquad } from "../filters/filters.js";
import { RpmFilter } from "../filters/rpm_filter.js";
import { DynNotch } from "../filters/dyn_notch.js";
import { staticNotchParams, isDynLpfEnabled } from "../filters/gyro_chain.js";
import { constrain, transition } from "../filters/fw_math.js";
import { combineAxes, bucketSpectra } from "./noise_model.js";
import { simulateGyroFilters } from "../simulate.js";

const DYN_NOTCH_Q_ADVANCE = 0.2;

// Settings with every filter off except the RPM notches
function rpmOnly(rpm) {
  return {
    lpf1: { type: 0, staticHz: 0, dynMinHz: 0, dynMaxHz: 0 },
    lpf2: { type: 0, staticHz: 0 },
    notch1: { hz: 0, cutoff: 0 },
    notch2: { hz: 0, cutoff: 0 },
    dynNotch: { enabled: false, count: 0, q: 20, minHz: 20, maxHz: 200 },
    rpm,
  };
}

/** Flight band frequencies the delay is averaged over. */
export function delayFrequencies(boundaryHz) {
  const out = [];
  for (let f = 5; f <= boundaryHz + 1e-9; f += 5) out.push(f);
  return out.length ? out : [5];
}

export class Evaluator {
  /**
   * @param {object} model   from buildNoiseModel
   * @param {object} rates   {filterRateHz, pidRateHz}
   * @param {object} rotor   rotor info (gear ratios, governor) as for the simulation
   * @param {number} boundaryHz  noise is counted from here to the log Nyquist frequency
   */
  constructor(model, rates, rotor, boundaryHz) {
    this.model = model;
    this.rates = rates;
    this.rotor = rotor;
    this.boundaryHz = boundaryHz;
    this.fs = rates.filterRateHz;
    this.delayHz = delayFrequencies(boundaryHz);
    this.cache = new Map();

    const nyquist = model.logRateHz / 2;
    this.firstBin = Math.max(0, Math.ceil(boundaryHz / model.binHz - 1e-9));
    this.lastBin = Math.min(model.bins - 1, Math.floor(nyquist / model.binHz + 1e-9));
    this.freqs = new Float64Array(model.bins);
    for (let k = 0; k < model.bins; k++) this.freqs[k] = k * model.binHz;

    this.mag = new Float64Array(model.bins);
    this.gain = new Float64Array(this.delayHz.length);
    this.after = new Float64Array(model.bins);
    this.phase = new Float64Array(this.delayHz.length);
  }

  _responseOf(responseAt) {
    const mag2 = new Float64Array(this.model.bins);
    for (let k = 0; k < this.model.bins; k++) {
      const h = responseAt(this.freqs[k]);
      mag2[k] = h.re * h.re + h.im * h.im;
    }
    const phase = new Float64Array(this.delayHz.length);
    const gainDb = new Float64Array(this.delayHz.length);
    this.delayHz.forEach((f, i) => {
      const h = responseAt(f);
      phase[i] = Math.atan2(h.im, h.re);
      gainDb[i] = 10 * Math.log10(Math.max(1e-30, h.re * h.re + h.im * h.im));
    });
    return { mag2, phase, gainDb };
  }

  // {mag2: |H|² per bin, phase (radians) and gainDb at each flight band frequency} for one filter
  // object, cached
  _stage(key, make) {
    let s = this.cache.get(key);
    if (!s) {
      const filter = make();
      s = this._responseOf((f) => filter.response(f, this.fs));
      this.cache.set(key, s);
    }
    return s;
  }

  _lowpass(type, cutoffHz) {
    if (!type || !(cutoffHz > 0)) return null;
    return this._stage(`lpf|${type}|${cutoffHz}`, () => createLowpassFilter(type, cutoffHz, this.fs, false));
  }

  _notch(hz, cutoff) {
    const p = staticNotchParams(hz, cutoff, this.fs);
    if (!(p.q > 0)) return null;
    return this._stage(`notch|${p.hz}|${p.q}`, () => createNotchFilter(p.hz, p.q, this.fs));
  }

  _dynNotch(centerHz, q) {
    const c = Math.round(centerHz * 4) / 4;
    return this._stage(`dyn|${c}|${q}`, () => new Biquad(c, this.fs, q, BIQUAD.NOTCH));
  }

  // Combined RPM notch response per axis at the given rotor speeds
  _rpmAt(filter, headRpm, tailRpm) {
    return filter.banks.map((banks) => {
      const mag2 = new Float64Array(this.model.bins).fill(1);
      const phase = new Float64Array(this.delayHz.length);
      const gainDb = new Float64Array(this.delayHz.length);
      for (const bank of banks) {
        const rpm = bank.signal === "head" ? headRpm : tailRpm;
        const freq = rpm * bank.multiplier;
        const center = constrain(freq, filter.notchMinHz, filter.notchMaxHz);
        const fader = transition(freq, filter.notchMinHz, filter.notchFadeHz, 0, 1);
        bank.notch.setCoefficients(center, this.fs, bank.notchQ, BIQUAD.NOTCH);
        const notch = bank.notch;
        const st = this._responseOf((f) => {
          const h = notch.response(f, this.fs);
          return { re: 1 - fader + fader * h.re, im: fader * h.im };
        });
        for (let k = 0; k < mag2.length; k++) mag2[k] *= st.mag2[k];
        for (let i = 0; i < phase.length; i++) {
          phase[i] += st.phase[i];
          gainDb[i] += st.gainDb[i];
        }
      }
      return { mag2, phase, gainDb };
    });
  }

  // RPM notch phase and gain per axis at one bucket's rotor speeds (for the flight band)
  _rpmBand(rpmSettings, bucketIndex) {
    const key = `rpmphase|${bucketIndex}|${JSON.stringify(rpmSettings)}`;
    let s = this.cache.get(key);
    if (!s) {
      const filter = new RpmFilter(rpmSettings, this.fs, this.rotor);
      const bucket = this.model.buckets[bucketIndex];
      s = this._rpmAt(filter, bucket.headRpm, bucket.tailRpm).map((r) => ({ phase: r.phase, gainDb: r.gainDb }));
      this.cache.set(key, s);
    }
    return s;
  }

  /**
   * Gyro spectrum per bucket and axis after the RPM notches. The RPM filter is first in the chain
   * and follows the rotor sample by sample, and its narrow notches remove rotor tones completely,
   * which a spectrum product can't reproduce (the window spreads a tone wider than the notch). So
   * the RPM stage alone is run through the time-domain simulation, once per RPM setup, and the
   * filters after it are applied to the resulting spectra.
   */
  _afterRpm(rpmSettings) {
    const model = this.model;
    if (!rpmSettings.enabled) return model.buckets.map((b) => b.psd);
    const key = `rpmpsd|${JSON.stringify(rpmSettings)}`;
    let s = this.cache.get(key);
    if (s) return s;
    const filter = new RpmFilter(rpmSettings, this.fs, this.rotor);
    if (!filter.totalBankCount) return model.buckets.map((b) => b.psd);
    const sim = simulateGyroFilters({
      raw: model.raw,
      headspeed: model.headspeed,
      tailspeed: model.tailspeed,
      rates: { logRateHz: model.logRateHz, filterRateHz: this.fs, pidRateHz: this.rates.pidRateHz },
      settings: rpmOnly(rpmSettings),
      rotor: this.rotor,
    });
    s = bucketSpectra(model, sim.filtered);
    this.cache.set(key, s);
    return s;
  }

  _dynNotchConfig(settings) {
    const key = `dncfg|${JSON.stringify(settings.dynNotch)}`;
    let c = this.cache.get(key);
    if (c === undefined) {
      c = null;
      if (settings.dynNotch.enabled) {
        const dn = new DynNotch(settings.dynNotch, this.fs, this.rates.pidRateHz);
        if (dn.isActive()) {
          c = { count: dn.count, q: dn.q, minHz: dn.minHz, maxHz: dn.maxHz, initial: Array.from(dn.centerFreq[0]) };
        }
      }
      this.cache.set(key, c);
    }
    return c;
  }

  // Firmware-style peak pick: the largest local maxima, and a peak's neighbour can't be a peak
  _placeDynNotches(spectrum, cfg) {
    const binHz = this.model.binHz;
    const lo = Math.max(1, Math.ceil(cfg.minHz / binHz));
    const hi = Math.min(this.model.bins - 2, Math.floor(cfg.maxHz / binHz));
    const peaks = [];
    for (let k = lo; k <= hi; k++) {
      if (spectrum[k] > spectrum[k - 1] && spectrum[k] > spectrum[k + 1]) {
        peaks.push(k);
        k++;
      }
    }
    peaks.sort((a, b) => spectrum[b] - spectrum[a]);
    const centers = [];
    for (let p = 0; p < cfg.count; p++) {
      const k = peaks[p];
      if (k === undefined) {
        centers.push(cfg.initial[p]);
        continue;
      }
      const y0 = spectrum[k - 1];
      const y1 = spectrum[k];
      const y2 = spectrum[k + 1];
      const denom = 2 * (y0 - 2 * y1 + y2);
      const offset = denom !== 0 ? (y0 - y2) / denom : 0;
      centers.push(constrain((k + offset) * binHz, cfg.minHz, cfg.maxHz));
    }
    return centers;
  }

  _headSpeedRatio(headRpm) {
    const r = this.rotor;
    if (r.governorActive && r.fullHeadSpeed > 0 && headRpm > 0.1 * r.fullHeadSpeed) return headRpm / r.fullHeadSpeed;
    return 1.0;
  }

  /**
   * @returns {{noise:number[], noiseRms:number, delayMs:number, delayAxes:number[], bandLossDb:number}}
   *   noise: estimated filtered gyro RMS (deg/s) per axis from the boundary to the log Nyquist
   *   delayMs: mean phase delay over the flight band and the three axes
   *   bandLossDb: the most the chain attenuates any flight band frequency (dB, any axis or bucket)
   */
  evaluate(settings) {
    const model = this.model;
    const bins = model.bins;
    const mag = this.mag;
    const phase = this.phase;
    const gain = this.gain;
    const D = this.delayHz.length;

    const lpf2 = this._lowpass(settings.lpf2.type, settings.lpf2.staticHz);
    const dynLpf = isDynLpfEnabled(settings);
    const lpf1Static = dynLpf ? null : this._lowpass(settings.lpf1.type, settings.lpf1.staticHz);
    const n1 = this._notch(settings.notch1.hz, settings.notch1.cutoff);
    const n2 = this._notch(settings.notch2.hz, settings.notch2.cutoff);
    const dn = this._dynNotchConfig(settings);
    const useRpm = settings.rpm.enabled;
    const afterRpm = this._afterRpm(settings.rpm);

    const noiseSq = [0, 0, 0];
    const delaySum = [0, 0, 0];
    let bandLossDb = 0;

    model.buckets.forEach((bucket, b) => {
      let lpf1 = lpf1Static;
      if (dynLpf) {
        const ratio = this._headSpeedRatio(bucket.headRpm);
        const cutoff = constrain(ratio * settings.lpf1.staticHz, settings.lpf1.dynMinHz, settings.lpf1.dynMaxHz);
        lpf1 = this._lowpass(settings.lpf1.type, Math.round(cutoff * 10) / 10);
      }
      const rpmBand = useRpm ? this._rpmBand(settings.rpm, b) : null;
      const stages = [lpf2, lpf1, n2, n1].filter(Boolean);

      for (let a = 0; a < 3; a++) {
        mag.fill(1);
        phase.fill(0);
        gain.fill(0);
        const add = (st) => {
          for (let i = 0; i < D; i++) {
            phase[i] += st.phase[i];
            gain[i] += st.gainDb[i];
          }
        };
        if (rpmBand) add(rpmBand[a]);
        for (const st of stages) {
          const m = st.mag2;
          for (let k = 0; k < bins; k++) mag[k] *= m[k];
          add(st);
        }
        const psd = afterRpm[b][a];
        if (dn) {
          // the tracker sees the gyro after the other filters
          const after = this.after;
          for (let k = 0; k < bins; k++) after[k] = psd[k] * mag[k];
          const centers = this._placeDynNotches(after, dn);
          centers.forEach((c, p) => {
            const st = this._dynNotch(c, dn.q + p * DYN_NOTCH_Q_ADVANCE);
            for (let k = 0; k < bins; k++) mag[k] *= st.mag2[k];
            add(st);
          });
        }
        let sum = 0;
        for (let k = this.firstBin; k <= this.lastBin; k++) sum += psd[k] * mag[k];
        noiseSq[a] += sum * model.binHz * bucket.weight;
        let delay = 0;
        for (let i = 0; i < D; i++) delay += -phase[i] / (2 * Math.PI * this.delayHz[i]);
        delaySum[a] += (delay / D) * 1000 * bucket.weight;
        for (let i = 0; i < D; i++) bandLossDb = Math.max(bandLossDb, -gain[i]);
      }
    });

    const noise = noiseSq.map(Math.sqrt);
    return {
      noise,
      noiseRms: combineAxes(noise),
      delayAxes: delaySum,
      delayMs: (delaySum[0] + delaySum[1] + delaySum[2]) / 3,
      bandLossDb,
    };
  }

  /** Unfiltered noise per axis (no filters). */
  unfiltered() {
    const model = this.model;
    const noise = [0, 1, 2].map((a) => {
      let total = 0;
      for (const bucket of model.buckets) {
        let sum = 0;
        for (let k = this.firstBin; k <= this.lastBin; k++) sum += bucket.psd[a][k];
        total += sum * model.binHz * bucket.weight;
      }
      return Math.sqrt(total);
    });
    return { noise, noiseRms: combineAxes(noise) };
  }
}
