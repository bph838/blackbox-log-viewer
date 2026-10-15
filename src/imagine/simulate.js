// Runs the ported Rotorflight gyro filter chain over logged unfiltered gyro.
//
// 1. Upsample gyroRAW from the log rate to the firmware filter rate (band-limited).
// 2. Run the filter chain at the filter rate, with the update task at the PID rate, exactly as
//    the firmware schedules them.
// 3. Point-sample the result back at the logged instants, like the blackbox recorder does.

import { GyroFilterChain } from "./filters/gyro_chain.js";
import { upsample, upsampleLinear, decimate } from "./filters/resample.js";

/**
 * @param {object} input
 *   raw: [Float64Array x3]   logged gyroRAW per axis, deg/s
 *   headspeed: Float64Array  main rotor RPM per log sample (zeros if not logged)
 *   tailspeed: Float64Array|null tail rotor RPM per log sample
 *   rates: {logRateHz, filterRateHz, pidRateHz}
 *   settings: Imagine settings
 *   rotor: rotor info for the RPM filter / dynamic LPF
 *   record: {dynNotch:boolean} record tracked dynamic notch centres at each log sample
 * @returns {{filtered: Float64Array[], dynNotchCenters: Float32Array|null, dynNotchCount:number,
 *            chain: object, elapsedMs: number}}
 */
export function simulateGyroFilters(input) {
  const started = performance.now();
  const { raw, rates, settings, rotor } = input;
  const count = raw[0].length;
  const ratio = rates.filterRateHz / rates.logRateHz;

  const up = raw.map((axis) => upsample(axis, ratio));
  const upLength = up[0].length;
  const head = upsampleLinear(input.headspeed ?? new Float64Array(count), ratio);
  const tail = input.tailspeed ? upsampleLinear(input.tailspeed, ratio) : null;

  const chain = new GyroFilterChain(settings, rates, rotor);
  const out = [new Float64Array(upLength), new Float64Array(upLength), new Float64Array(upLength)];

  const dn = chain.dynNotch;
  const recordDyn = !!(input.record?.dynNotch && dn);
  const dynCount = dn ? dn.count : 0;
  const dynCenters = recordDyn ? new Float32Array(count * 3 * dynCount) : null;
  const ratioInt = Math.round(ratio);
  const integerRatio = Math.abs(ratio - ratioInt) < 1e-9;

  const filterPeriodUs = 1e6 / rates.filterRateHz;
  const pidPerFilter = rates.pidRateHz / rates.filterRateHz;
  let pidAccumulator = 0;

  for (let m = 0; m < upLength; m++) {
    // Filter task
    out[0][m] = chain.filterAxis(0, up[0][m]);
    out[1][m] = chain.filterAxis(1, up[1][m]);
    out[2][m] = chain.filterAxis(2, up[2][m]);

    // PID loop sub-tasks (filter update) - pidRate is normally equal to or a multiple of the
    // filter rate; when it is lower, run the update only on the matching filter loops.
    pidAccumulator += pidPerFilter;
    const headRpm = head[m];
    const tailRpm = tail ? tail[m] : 0;
    while (pidAccumulator >= 1 - 1e-9) {
      chain.updateTask(m * filterPeriodUs, headRpm, tailRpm);
      pidAccumulator -= 1;
    }

    if (recordDyn && integerRatio && m % ratioInt === 0) {
      const k = m / ratioInt;
      const base = k * 3 * dynCount;
      for (let axis = 0; axis < 3; axis++) {
        const freqs = dn.centerFreq[axis];
        for (let p = 0; p < dynCount; p++) {
          dynCenters[base + axis * dynCount + p] = freqs[p];
        }
      }
    }
  }

  const filtered = out.map((axis) => decimate(axis, ratio, count));

  return {
    filtered,
    dynNotchCenters: dynCenters,
    dynNotchCount: dynCount,
    chain: chain.describe(),
    elapsedMs: performance.now() - started,
  };
}
