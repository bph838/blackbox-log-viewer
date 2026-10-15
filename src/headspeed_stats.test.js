import { describe, it, expect } from "vitest";
import { HeadspeedStats } from "./headspeed_stats.js";
import { FlightLogParser } from "./flightlog_parser.js";

const TIME = FlightLogParser.prototype.FLIGHT_LOG_FIELD_INDEX_TIME;
const HS = 5;

function fakeLog(speeds, { hasHeadspeed = true } = {}) {
  const frames = speeds.map((s, i) => {
    const f = [];
    f[TIME] = i * 1000000;
    f[HS] = s;
    return f;
  });
  return {
    getMainFieldIndexByName: (name) => (hasHeadspeed && name === "headspeed" ? HS : undefined),
    getMinTime: () => 0,
    getMaxTime: () => (speeds.length - 1) * 1000000,
    getChunksInTimeRange: () => [{ frames: frames.slice(0, 2) }, { frames: frames.slice(2) }],
  };
}

describe("HeadspeedStats.compute", () => {
  it("returns null when there is no headspeed field", () => {
    expect(HeadspeedStats.compute(fakeLog([2000], { hasHeadspeed: false }))).toBeNull();
  });

  it("returns null when the rotor never spools up", () => {
    expect(HeadspeedStats.compute(fakeLog([0, 100, 0]))).toBeNull();
  });

  it("ignores samples below the spool-up threshold", () => {
    const stats = HeadspeedStats.compute(fakeLog([0, 2000, 2200, 1800, 0]));
    expect(stats.average).toBe(2000);
    expect(stats.min).toBe(1800);
    expect(stats.max).toBe(2200);
    expect(stats.minTime).toBe(3000000);
    expect(stats.maxTime).toBe(2000000);
    expect(stats.sampleCount).toBe(3);
    expect(stats.totalSamples).toBe(5);
    expect(stats.durationSeconds).toBe(2);
  });

  it("only counts frames inside startTime..endTime", () => {
    const stats = HeadspeedStats.compute(fakeLog([3000, 2000, 2200, 1800, 3000]), {
      startTime: 1000000,
      endTime: 2000000,
    });
    expect(stats.average).toBe(2100);
    expect(stats.min).toBe(2000);
    expect(stats.max).toBe(2200);
    expect(stats.totalSamples).toBe(2);
  });
});
