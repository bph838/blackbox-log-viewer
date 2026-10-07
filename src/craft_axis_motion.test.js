import { describe, it, expect } from "vitest";
import { createAxisMotion, hasAxisMotion } from "./craft_axis_motion.js";
import { FlightLogParser } from "./flightlog_parser.js";

const TIME = FlightLogParser.prototype.FLIGHT_LOG_FIELD_INDEX_TIME;
const FIELDS = { "gyroADC[0]": 2, "gyroADC[1]": 3, "gyroADC[2]": 4 };

// A log sampled every 1 ms for `seconds`, with roll rate rate(t) deg/s (t in seconds).
function makeLog(seconds, rate) {
  const frames = [];
  for (let us = 0; us <= seconds * 1e6; us += 1000) {
    const frame = [0, 0, 0, 0, 0];
    frame[TIME] = us;
    frame[FIELDS["gyroADC[0]"]] = rate(us / 1e6);
    frames.push(frame);
  }
  // Split in two chunks sharing a boundary frame, like the real log's chunks.
  const mid = frames.length >> 1;
  const chunks = [{ frames: frames.slice(0, mid + 1) }, { frames: frames.slice(mid) }];
  return {
    getMinTime: () => 0,
    getMaxTime: () => seconds * 1e6,
    getMainFieldIndexByName: (name) => FIELDS[name],
    getChunksInTimeRange: () => chunks,
  };
}

describe("createAxisMotion", () => {
  it("needs all three gyro axes", () => {
    expect(hasAxisMotion(makeLog(1, () => 0))).toBe(true);
    expect(hasAxisMotion({ getMainFieldIndexByName: () => undefined })).toBe(false);
  });

  it("shows a fast wobble at its full size", () => {
    // 10 Hz roll wobble of +-5 degrees: angle = 5 sin(2 pi 10 t).
    const f = 10;
    const log = makeLog(10, (t) => 5 * 2 * Math.PI * f * Math.cos(2 * Math.PI * f * t));
    const motion = createAxisMotion(log);
    expect(motion.at(5.025e6, "roll", 1)).toBeCloseTo(5, 1); // a peak
    expect(motion.at(5.075e6, "roll", 1)).toBeCloseTo(-5, 1); // a trough
  });

  it("leaves out a slow change like rolling inverted and holding it", () => {
    // Rolls 180 degrees over the first second, then holds.
    const log = makeLog(10, (t) => (t < 1 ? 180 : 0));
    const motion = createAxisMotion(log);
    expect(Math.abs(motion.at(6e6, "roll", 1))).toBeLessThan(1e-6);
  });

  it("is zero on axes that don't move", () => {
    const motion = createAxisMotion(makeLog(2, (t) => 100 * Math.sin(t)));
    expect(motion.at(1e6, "pitch", 1)).toBe(0);
  });
});
