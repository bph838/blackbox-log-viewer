// The movement of a craft on one axis (roll, pitch or yaw), for the craft model's isolated-axis
// view: the gyro rate on that axis integrated into an angle, relative to the angle at a reference
// moment (when the axis was picked). The model starts from a neutral pose at that moment and turns
// only on that axis as the log plays.

import { FlightLogParser } from "./flightlog_parser.js";

export const AXIS_GYRO_FIELDS = { roll: "gyroADC[0]", pitch: "gyroADC[1]", yaw: "gyroADC[2]" };

// Gyro samples are integrated at the full logged rate, but only kept every SAMPLE_INTERVAL_US -
// plenty for drawing the model, and keeps a long log's tables small.
const SAMPLE_INTERVAL_US = 4000;

/**
 * Whether the log has the gyro fields needed to show each axis's movement.
 */
export function hasAxisMotion(flightLog) {
  return Object.values(AXIS_GYRO_FIELDS).every(
    (name) => typeof flightLog.getMainFieldIndexByName(name) === "number",
  );
}

/**
 * Index of the last entry in sorted `times` at or before `t` (0 if `t` is before the first).
 */
function indexAtOrBefore(times, t) {
  let lo = 0;
  let hi = times.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (times[mid] <= t) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

function interpolate(times, values, t) {
  const n = times.length;
  if (t <= times[0]) return values[0];
  if (t >= times[n - 1]) return values[n - 1];
  const i = indexAtOrBefore(times, t);
  const f = (t - times[i]) / (times[i + 1] - times[i]);
  return values[i] + (values[i + 1] - values[i]) * f;
}

/**
 * Integrates one axis's gyro rate (deg/s) over the whole log. Returns { times, angle }: the angle
 * (degrees) turned since the start of the log at each time.
 */
function integrateAxis(flightLog, fieldIndex) {
  const timeIndex = FlightLogParser.prototype.FLIGHT_LOG_FIELD_INDEX_TIME;
  const times = [];
  const angle = [];

  let lastTime = null;
  let lastRate = 0;
  let currentAngle = 0;

  for (const chunk of flightLog.getChunksInTimeRange(flightLog.getMinTime(), flightLog.getMaxTime())) {
    for (const frame of chunk.frames || []) {
      const time = frame[timeIndex];
      const rate = frame[fieldIndex] || 0;

      if (lastTime === null) {
        lastTime = time;
        lastRate = rate;
        times.push(time);
        angle.push(0);
        continue;
      }
      if (time <= lastTime) continue; // Chunks can repeat their boundary frame.

      currentAngle += ((lastRate + rate) / 2) * ((time - lastTime) / 1e6);
      lastTime = time;
      lastRate = rate;

      if (time - times[times.length - 1] >= SAMPLE_INTERVAL_US) {
        times.push(time);
        angle.push(currentAngle);
      }
    }
  }

  return { times: Float64Array.from(times), angle: Float64Array.from(angle) };
}

/**
 * Builds each axis's table the first time it's asked for. at(time, axis, referenceTime) is how far
 * (degrees) the craft has turned on that axis between referenceTime and `time` (microseconds, log
 * time) - negative when `time` is before the reference, or the turn was the other way.
 */
export function createAxisMotion(flightLog) {
  const tables = {};

  function table(axis) {
    if (!tables[axis]) {
      const fieldIndex = flightLog.getMainFieldIndexByName(AXIS_GYRO_FIELDS[axis]);
      tables[axis] = typeof fieldIndex === "number" ? integrateAxis(flightLog, fieldIndex) : null;
    }
    return tables[axis];
  }

  return {
    at(time, axis, referenceTime) {
      const t = table(axis);
      if (!t || t.times.length < 2) return 0;
      return interpolate(t.times, t.angle, time) - interpolate(t.times, t.angle, referenceTime);
    },
  };
}
