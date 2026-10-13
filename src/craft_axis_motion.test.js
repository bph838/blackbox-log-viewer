import { describe, it, expect } from "vitest";
import { createAxisMotion, hasAxisMotion } from "./craft_axis_motion.js";
import { FlightLogParser } from "./flightlog_parser.js";

const TIME = FlightLogParser.prototype.FLIGHT_LOG_FIELD_INDEX_TIME;
const FIELDS = { "gyroADC[0]": 2, "gyroADC[1]": 3, "gyroADC[2]": 4 };

// A log sampled every 1 ms for `seconds`, with yaw rate rate(t) deg/s (t in seconds).
function makeLog(seconds, rate) {
  const frames = [];
  for (let us = 0; us <= seconds * 1e6; us += 1000) {
    const frame = [0, 0, 0, 0, 0];
    frame[TIME] = us;
    frame[FIELDS["gyroADC[2]"]] = rate(us / 1e6);
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

  it("is zero at the reference time", () => {
    const motion = createAxisMotion(makeLog(10, () => 90));
    expect(motion.at(4e6, "yaw", 4e6)).toBeCloseTo(0, 6);
  });

  it("measures the turn since the reference time", () => {
    // 90 deg/s for 2 s, then holds: a 180 degree pirouette.
    const motion = createAxisMotion(makeLog(10, (t) => (t >= 1 && t < 3 ? 90 : 0)));
    expect(motion.at(2e6, "yaw", 0.5e6)).toBeCloseTo(90, 0);
    expect(motion.at(6e6, "yaw", 0.5e6)).toBeCloseTo(180, 0);
    expect(motion.at(0.5e6, "yaw", 6e6)).toBeCloseTo(-180, 0);
  });

  it("is zero on axes that don't move", () => {
    const motion = createAxisMotion(makeLog(2, (t) => 100 * Math.sin(t)));
    expect(motion.at(1e6, "pitch", 0)).toBe(0);
  });
});
