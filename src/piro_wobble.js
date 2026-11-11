// Piro section (P key): a stretch of the log where the pilot levelled the heli (e.g. a moment in
// angle mode) and then pirouetted it in place, so only the tail goes round. On a perfectly set-up
// heli the rotor disc stays level throughout; any wobble or progression of roll/pitch shows up as
// the mast leaning away from vertical. The 3D heli shows that lean while playback is inside the
// section - see craft_3d_heli.js.

import { FlightLogParser } from "./flightlog_parser.js";

// Trace samples are kept no closer together than this - plenty to draw a smooth path.
const TRACE_INTERVAL_US = 10000;

/**
 * The section after pressing P at `time`: the first press starts a section, the second ends it
 * (in either order), pressing again at the start time cancels it, and a press on a finished
 * section starts a new one there.
 *
 * @param {{start: number|null, end: number|null}} section
 * @param {number} time - log time, microseconds
 * @returns {{start: number|null, end: number|null}}
 */
export function nextPiroSection(section, time) {
  const { start, end } = section ?? {};
  if (start == null || end != null) return { start: time, end: null };
  if (time === start) return { start: null, end: null };
  return { start: Math.min(start, time), end: Math.max(start, time) };
}

/**
 * Whether `time` is inside the section. An open section (no end yet) runs on from its start.
 */
export function isInPiroSection(section, time) {
  if (section?.start == null) return false;
  return time >= section.start && (section.end == null || time <= section.end);
}

/**
 * The lean of the mast seen from above, in the craft view's world frame (the same rotations the 3D
 * heli applies: wrapper yaw, then the model's pitch and roll in three.js "XYZ" order).
 *
 * Returns { x, y, degrees }: x is to the viewer's right and y away from the viewer, each in degrees
 * of lean along that direction, so the point sits `degrees` from the centre.
 *
 * @param {number} rollRad - model.rotation.z
 * @param {number} pitchRad - model.rotation.x
 * @param {number} yawRad - wrapper rotation.y (including the facing offset)
 */
export function mastLean(rollRad, pitchRad, yawRad) {
  const sx = Math.sin(pitchRad), cx = Math.cos(pitchRad);
  const sz = Math.sin(rollRad), cz = Math.cos(rollRad);
  const sy = Math.sin(yawRad), cy = Math.cos(yawRad);
  // Body up (0,1,0) rotated by Rx(pitch)·Rz(roll), then Ry(yaw).
  const ux = -sz * cy + cz * sx * sy;
  const uy = cz * cx;
  const uz = sz * sy + cz * sx * cy;
  const horizontal = Math.hypot(ux, uz);
  const degrees = (Math.acos(Math.min(1, Math.max(-1, uy))) * 180) / Math.PI;
  if (horizontal < 1e-9) return { x: 0, y: 0, degrees };
  return { x: (ux / horizontal) * degrees, y: (-uz / horizontal) * degrees, degrees };
}

/**
 * The model rotations the 3D heli uses for a logged attitude (decidegrees).
 */
export function attitudeToModelRotation(rollDeci, pitchDeci, yawDeci, facingOffset = 0) {
  return {
    roll: (-rollDeci / 1800) * Math.PI,
    pitch: (-pitchDeci / 1800) * Math.PI,
    yaw: (-yawDeci / 1800) * Math.PI + facingOffset,
  };
}

/**
 * The mast lean through a section, from the logged attitude: { times, x, y } (Float64Arrays).
 */
export function buildPiroTrace(flightLog, start, end, facingOffset = 0) {
  const timeIndex = FlightLogParser.prototype.FLIGHT_LOG_FIELD_INDEX_TIME;
  const rollIndex = flightLog.getMainFieldIndexByName("attitude[0]");
  const pitchIndex = flightLog.getMainFieldIndexByName("attitude[1]");
  const yawIndex = flightLog.getMainFieldIndexByName("attitude[2]");
  const times = [], xs = [], ys = [];
  if ([rollIndex, pitchIndex, yawIndex].some((i) => typeof i !== "number")) {
    return { times: Float64Array.from(times), x: Float64Array.from(xs), y: Float64Array.from(ys) };
  }

  let last = -Infinity;
  for (const chunk of flightLog.getChunksInTimeRange(start, end)) {
    for (const frame of chunk.frames || []) {
      const time = frame[timeIndex];
      if (time < start || time > end || time - last < TRACE_INTERVAL_US) continue;
      last = time;
      const r = attitudeToModelRotation(frame[rollIndex], frame[pitchIndex], frame[yawIndex], facingOffset);
      const lean = mastLean(r.roll, r.pitch, r.yaw);
      times.push(time);
      xs.push(lean.x);
      ys.push(lean.y);
    }
  }
  return { times: Float64Array.from(times), x: Float64Array.from(xs), y: Float64Array.from(ys) };
}

/**
 * Number of trace samples at or before `time` (binary search).
 */
export function traceCountAt(times, time) {
  let lo = 0, hi = times.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid] <= time) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
