// Pulls the series Imagine needs out of a parsed FlightLog (shared parser from the main app).

import { DEBUG_MODE } from "../flightlog_fielddefs.js";

/**
 * @param {FlightLog} flightLog with the wanted sub-log already opened
 * @returns {object} time (us), raw[3] (gyroRAW, deg/s), logged[3] (gyroADC, deg/s or null),
 *   headspeed, tailspeed, flags and the measured log rate.
 */
export function extractLogData(flightLog) {
  const names = flightLog.getMainFieldNames();
  const index = (name) => {
    const i = names.indexOf(name);
    return i >= 0 ? i : -1;
  };

  const timeIdx = index("time");
  const rawIdx = [0, 1, 2].map((a) => index(`gyroRAW[${a}]`));
  const loggedIdx = [0, 1, 2].map((a) => index(`gyroADC[${a}]`));
  const headIdx = index("headspeed");
  const tailIdx = index("tailspeed");
  const sysConfig = flightLog.getSysConfig();
  const debugModeName = DEBUG_MODE[sysConfig.debug_mode] ?? null;
  const debugIdx = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => index(`debug[${i}]`));

  if (rawIdx.some((i) => i < 0)) {
    throw new Error("This log has no unfiltered gyro (gyroRAW). Enable the GYRAW blackbox field to use Imagine.");
  }

  const chunks = flightLog.getChunksInTimeRange(flightLog.getMinTime(), flightLog.getMaxTime());
  let count = 0;
  for (const chunk of chunks) count += chunk.frames.length;

  const time = new Float64Array(count);
  const raw = [new Float64Array(count), new Float64Array(count), new Float64Array(count)];
  const hasLogged = loggedIdx.every((i) => i >= 0);
  const logged = hasLogged ? [new Float64Array(count), new Float64Array(count), new Float64Array(count)] : null;
  const headspeed = new Float64Array(count);
  const tailspeed = tailIdx >= 0 ? new Float64Array(count) : null;
  const wantDebug = debugModeName === "DYN_NOTCH_FREQ" && debugIdx.every((i) => i >= 0);
  const debug = wantDebug ? debugIdx.map(() => new Float64Array(count)) : null;

  let k = 0;
  for (const chunk of chunks) {
    for (const frame of chunk.frames) {
      time[k] = frame[timeIdx];
      for (let a = 0; a < 3; a++) {
        raw[a][k] = frame[rawIdx[a]];
        if (logged) logged[a][k] = frame[loggedIdx[a]];
      }
      if (headIdx >= 0) headspeed[k] = frame[headIdx] || 0;
      if (tailspeed) tailspeed[k] = frame[tailIdx] || 0;
      if (debug) {
        for (let d = 0; d < 8; d++) debug[d][k] = frame[debugIdx[d]];
      }
      k++;
    }
  }

  // Measured rate and the largest gap between frames
  let maxGapUs = 0;
  for (let i = 1; i < count; i++) {
    maxGapUs = Math.max(maxGapUs, time[i] - time[i - 1]);
  }
  const measuredLogRateHz = count > 1 ? ((count - 1) * 1e6) / (time[count - 1] - time[0]) : 0;

  return {
    count,
    time,
    raw,
    logged,
    headspeed,
    tailspeed,
    hasHeadspeed: headIdx >= 0,
    hasTailspeed: tailIdx >= 0,
    // A second motor output means a motorised tail (helicopters have one main motor)
    motorisedTail: index("motor[1]") >= 0,
    debugModeName,
    dynNotchDebug: debug ? { axis: Number(sysConfig.debug_axis ?? 0), values: debug } : null,
    measuredLogRateHz,
    maxGapUs,
  };
}

/** Index range [start, end) of samples whose time lies within [inUs, outUs]. */
export function sampleRange(time, inUs, outUs) {
  const n = time.length;
  let start = 0;
  let end = n;
  if (inUs != null && inUs !== false) {
    while (start < n && time[start] < inUs) start++;
  }
  if (outUs != null && outUs !== false) {
    end = start;
    while (end < n && time[end] <= outUs) end++;
  }
  return { start, end };
}
