// Port of the Rotorflight dynamic notch filter (src/main/flight/dyn_notch_filter.c) and the
// sliding DFT it uses for peak tracking (src/main/common/sdft.c).
//
// Firmware behaviour reproduced here:
//  - dynNotchFilter() runs every filter loop: it accumulates the (already statically filtered)
//    gyro value for analysis, then applies the notches in DF1 form.
//  - dynNotchUpdate() runs every PID loop: averaged samples are pushed into a 72 point SDFT in
//    batches, and a 4 step state machine (window, detect peaks, calc frequencies, update filters)
//    processes one axis at a time.
//  - The dynamic notch is disabled when dynNotchUpdate() would run below 1 kHz.
//
// Reference: rotorflight-firmware RF-4.6.x @ 53fd0637 (release/4.6.0 + 1).

import { Biquad, BIQUAD } from "./filters.js";
import { constrain } from "./fw_math.js";

export const SDFT_SAMPLE_SIZE = 72;
export const SDFT_BIN_COUNT = SDFT_SAMPLE_SIZE / 2;
export const DYN_NOTCH_COUNT_MAX = 8;
const SDFT_R = 0.9999;
const DYN_NOTCH_UPDATE_MIN_HZ = 1000;
const DYN_NOTCH_Q_ADVANCE = 0.2;
const XYZ_AXIS_COUNT = 3;
const STEP_COUNT = 4;
const DYN_NOTCH_CALC_TICKS = XYZ_AXIS_COUNT * STEP_COUNT;

const STEP_WINDOW = 0;
const STEP_DETECT_PEAKS = 1;
const STEP_CALC_FREQUENCIES = 2;
const STEP_UPDATE_FILTERS = 3;

// C lrintf() with the default round-to-nearest-even mode
export function lrintf(x) {
  const r = Math.round(x);
  if (Math.abs(x % 1) === 0.5 && r % 2 !== 0) {
    return r - 1;
  }
  return r;
}

const rPowerN = Math.pow(SDFT_R, SDFT_SAMPLE_SIZE);
const twiddleRe = new Float64Array(SDFT_BIN_COUNT);
const twiddleIm = new Float64Array(SDFT_BIN_COUNT);
for (let i = 0; i < SDFT_BIN_COUNT; i++) {
  const phi = ((2 * Math.PI) / SDFT_SAMPLE_SIZE) * i;
  twiddleRe[i] = SDFT_R * Math.cos(phi);
  twiddleIm[i] = SDFT_R * Math.sin(phi);
}

export class Sdft {
  constructor(startBin, endBin, numBatches) {
    this.idx = 0;
    this.startBin = constrain(startBin, 0, SDFT_BIN_COUNT - 1);
    this.endBin = constrain(endBin, this.startBin, SDFT_BIN_COUNT - 1);
    this.numBatches = Math.max(numBatches, 1);
    this.batchSize = Math.trunc((this.endBin - this.startBin + 1) / this.numBatches);
    this.samples = new Float64Array(SDFT_SAMPLE_SIZE);
    this.re = new Float64Array(SDFT_BIN_COUNT);
    this.im = new Float64Array(SDFT_BIN_COUNT);
  }

  _rotate(i, delta) {
    // data[i] = twiddle[i] * (data[i] + delta)
    const a = this.re[i] + delta;
    const b = this.im[i];
    this.re[i] = twiddleRe[i] * a - twiddleIm[i] * b;
    this.im[i] = twiddleRe[i] * b + twiddleIm[i] * a;
  }

  _updateEdges(value, batchIdx) {
    if (this.startBin > 0 && batchIdx === 0) {
      this._rotate(this.startBin - 1, value);
    }
    if (this.endBin < SDFT_BIN_COUNT - 1 && batchIdx === this.numBatches - 1) {
      this._rotate(this.endBin + 1, value);
    }
  }

  push(sample) {
    const delta = sample - rPowerN * this.samples[this.idx];
    this.samples[this.idx] = sample;
    this.idx = (this.idx + 1) % SDFT_SAMPLE_SIZE;
    for (let i = this.startBin; i <= this.endBin; i++) {
      this._rotate(i, delta);
    }
    this._updateEdges(delta, 0);
  }

  pushBatch(sample, batchIdx) {
    const batchStart = this.batchSize * batchIdx + this.startBin;
    let batchEnd = batchStart;
    const delta = sample - rPowerN * this.samples[this.idx];

    if (batchIdx === this.numBatches - 1) {
      this.samples[this.idx] = sample;
      this.idx = (this.idx + 1) % SDFT_SAMPLE_SIZE;
      batchEnd += this.endBin - batchStart + 1;
    } else {
      batchEnd += this.batchSize;
    }

    for (let i = batchStart; i < batchEnd; i++) {
      this._rotate(i, delta);
    }
    this._updateEdges(delta, batchIdx);
  }

  // Squared magnitude with a Hann window applied in the frequency domain
  winSq(output) {
    const re = this.re;
    const im = this.im;
    const s = this.startBin;
    const e = this.endBin;
    let vr, vi;

    if (s === 0) {
      vr = re[s] - re[s + 1];
      vi = im[s] - im[s + 1];
    } else {
      vr = re[s] - 0.5 * (re[s - 1] + re[s + 1]);
      vi = im[s] - 0.5 * (im[s - 1] + im[s + 1]);
    }
    output[s] = vr * vr + vi * vi;

    for (let i = s + 1; i < e; i++) {
      vr = re[i] - 0.5 * (re[i - 1] + re[i + 1]);
      vi = im[i] - 0.5 * (im[i - 1] + im[i + 1]);
      output[i] = vr * vr + vi * vi;
    }

    if (e === SDFT_BIN_COUNT - 1) {
      vr = re[e] - re[e - 1];
      vi = im[e] - im[e - 1];
    } else {
      vr = re[e] - 0.5 * (re[e - 1] + re[e + 1]);
      vi = im[e] - 0.5 * (im[e - 1] + im[e + 1]);
    }
    output[e] = vr * vr + vi * vi;
  }
}

/**
 * @param {{count:number, q:number, minHz:number, maxHz:number}} config CLI units: q is x10
 * @param {number} filterRateHz rate of filter() calls (gyro.filterRateHz)
 * @param {number} updateRateHz rate of update() calls (gyro.targetRateHz, the PID rate)
 */
export class DynNotch {
  constructor(config, filterRateHz, updateRateHz) {
    const updateNyquistHz = updateRateHz / 2;

    this.filterRateHz = filterRateHz;
    this.q = config.q / 10;
    this.minHz = Math.max(config.minHz, 10);
    this.maxHz = Math.max(this.minHz, config.maxHz);
    this.maxHz = Math.min(this.maxHz, updateNyquistHz);
    this.count = Math.min(config.count, DYN_NOTCH_COUNT_MAX);
    this.disabledReason = null;

    if (updateRateHz < DYN_NOTCH_UPDATE_MIN_HZ) {
      this.count = 0;
      this.disabledReason = `PID loop ${Math.round(updateRateHz)} Hz is below ${DYN_NOTCH_UPDATE_MIN_HZ} Hz`;
    }

    this.sampleCount = Math.max(1, Math.floor(updateNyquistHz / this.maxHz));
    this.sampleCountRcp = 1 / (this.sampleCount * (filterRateHz / updateRateHz));
    this.sdftSampleRateHz = updateRateHz / this.sampleCount;
    this.sdftResolutionHz = this.sdftSampleRateHz / SDFT_SAMPLE_SIZE;
    this.sdftStartBin = Math.max(2, lrintf(this.minHz / this.sdftResolutionHz));
    this.sdftEndBin = Math.min(SDFT_BIN_COUNT - 1, lrintf(this.maxHz / this.sdftResolutionHz));

    this.sdft = [];
    for (let axis = 0; axis < XYZ_AXIS_COUNT; axis++) {
      this.sdft.push(new Sdft(this.sdftStartBin, this.sdftEndBin, this.sampleCount));
    }

    this.centerFreq = [];
    this.notch = [];
    for (let axis = 0; axis < XYZ_AXIS_COUNT; axis++) {
      const freqs = new Float64Array(this.count);
      const notches = [];
      for (let p = 0; p < this.count; p++) {
        freqs[p] = ((p + 0.5) * (this.maxHz - this.minHz)) / this.count + this.minHz;
        notches.push(new Biquad(freqs[p], filterRateHz, this.q + p * DYN_NOTCH_Q_ADVANCE, BIQUAD.NOTCH, true));
      }
      this.centerFreq.push(freqs);
      this.notch.push(notches);
    }

    this.sampleIndex = 0;
    this.sampleAccumulator = new Float64Array(XYZ_AXIS_COUNT);
    this.sampleAvg = new Float64Array(XYZ_AXIS_COUNT);
    this.state = { tick: 0, step: 0, axis: 0 };
    this.peakBin = new Int32Array(DYN_NOTCH_COUNT_MAX);
    this.peakValue = new Float64Array(DYN_NOTCH_COUNT_MAX);
    this.sdftData = new Float64Array(SDFT_BIN_COUNT);
  }

  isActive() {
    return this.count > 0;
  }

  // dynNotchFilter(): called every filter loop for each axis
  filter(axis, value) {
    this.sampleAccumulator[axis] += value;
    const notches = this.notch[axis];
    for (let p = 0; p < this.count; p++) {
      value = notches[p].applyDF1(value);
    }
    return value;
  }

  // dynNotchUpdate(): called every PID loop
  update() {
    if (this.sampleIndex === this.sampleCount) {
      this.sampleIndex = 0;
      for (let axis = 0; axis < XYZ_AXIS_COUNT; axis++) {
        this.sampleAvg[axis] = this.sampleAccumulator[axis] * this.sampleCountRcp;
        this.sampleAccumulator[axis] = 0;
      }
      this.state.tick = DYN_NOTCH_CALC_TICKS;
    }

    for (let axis = 0; axis < XYZ_AXIS_COUNT; axis++) {
      this.sdft[axis].pushBatch(this.sampleAvg[axis], this.sampleIndex);
    }

    this.sampleIndex++;

    if (this.state.tick > 0) {
      this._process();
      this.state.tick--;
    }
  }

  _process() {
    const state = this.state;
    const count = this.count;
    const data = this.sdftData;
    const peakBin = this.peakBin;
    const peakValue = this.peakValue;

    switch (state.step) {
      case STEP_WINDOW:
        this.sdft[state.axis].winSq(data);
        break;

      case STEP_DETECT_PEAKS: {
        for (let p = 0; p < count; p++) {
          peakBin[p] = 0;
          peakValue[p] = 0;
        }
        for (let bin = this.sdftStartBin + 1; bin < this.sdftEndBin; bin++) {
          if (data[bin] > data[bin - 1] && data[bin] > data[bin + 1]) {
            for (let p = 0; p < count; p++) {
              if (data[bin] > peakValue[p]) {
                for (let k = count - 1; k > p; k--) {
                  peakBin[k] = peakBin[k - 1];
                  peakValue[k] = peakValue[k - 1];
                }
                peakBin[p] = bin;
                peakValue[p] = data[bin];
                break;
              }
            }
            bin++; // next bin can't be a peak
          }
        }
        break;
      }

      case STEP_CALC_FREQUENCIES: {
        const freqs = this.centerFreq[state.axis];
        for (let p = 0; p < count; p++) {
          if (peakBin[p] !== 0 && peakValue[p] > 0) {
            let meanBin = peakBin[p];
            const y0 = data[peakBin[p] - 1];
            const y1 = data[peakBin[p]];
            const y2 = data[peakBin[p] + 1];
            const denom = 2 * (y0 - 2 * y1 + y2);
            if (denom !== 0) {
              meanBin += (y0 - y2) / denom;
            }
            freqs[p] = constrain(meanBin * this.sdftResolutionHz, this.minHz, this.maxHz);
          }
        }
        break;
      }

      case STEP_UPDATE_FILTERS: {
        const freqs = this.centerFreq[state.axis];
        const notches = this.notch[state.axis];
        for (let p = 0; p < count; p++) {
          if (peakBin[p] !== 0 && peakValue[p] > 0) {
            notches[p].setCoefficients(freqs[p], this.filterRateHz, this.q + p * DYN_NOTCH_Q_ADVANCE, BIQUAD.NOTCH);
          }
        }
        state.axis = (state.axis + 1) % XYZ_AXIS_COUNT;
        break;
      }
    }

    state.step = (state.step + 1) % STEP_COUNT;
  }
}
