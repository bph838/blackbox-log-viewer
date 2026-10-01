import { describe, it, expect, beforeEach } from "vitest";
import {
  clampToTrim,
  resolveIsolatedRange,
  setIsolateInTime,
  setIsolateOutTime,
  clearIsolation,
  getIsolatedRange,
} from "./isolation.js";
import { usePlaybackStore } from "./stores/playback.js";
import pinia from "./pinia_instance.js";

describe("clampToTrim", () => {
  it("leaves a time inside the trim range untouched", () => {
    expect(clampToTrim(5e6, 2e6, 8e6)).toBe(5e6);
  });

  it("clamps to the trim bounds", () => {
    expect(clampToTrim(1e6, 2e6, 8e6)).toBe(2e6);
    expect(clampToTrim(9e6, 2e6, 8e6)).toBe(8e6);
  });

  it("treats false/null trim bounds as unbounded", () => {
    expect(clampToTrim(1e6, false, null)).toBe(1e6);
  });
});

describe("resolveIsolatedRange", () => {
  const base = { trimIn: null, trimOut: null, minTime: 0, maxTime: 10e6 };

  it("returns null when no isolate point is set", () => {
    expect(resolveIsolatedRange({ ...base, isolateIn: null, isolateOut: null })).toBeNull();
  });

  it("extends a missing end to the trim range / log bounds", () => {
    expect(resolveIsolatedRange({ ...base, isolateIn: 3e6, isolateOut: null })).toEqual({ start: 3e6, end: 10e6 });
    expect(resolveIsolatedRange({ ...base, trimOut: 7e6, isolateIn: 3e6, isolateOut: null })).toEqual({ start: 3e6, end: 7e6 });
    expect(resolveIsolatedRange({ ...base, trimIn: 1e6, isolateIn: null, isolateOut: 4e6 })).toEqual({ start: 1e6, end: 4e6 });
  });

  it("constrains the block to the trim range", () => {
    expect(
      resolveIsolatedRange({ ...base, trimIn: 2e6, trimOut: 8e6, isolateIn: 1e6, isolateOut: 9e6 }),
    ).toEqual({ start: 2e6, end: 8e6 });
  });

  it("returns null when the block falls entirely outside the trim range", () => {
    expect(
      resolveIsolatedRange({ ...base, trimIn: 5e6, trimOut: 8e6, isolateIn: 1e6, isolateOut: 4e6 }),
    ).toBeNull();
  });
});

describe("setIsolateInTime / setIsolateOutTime", () => {
  let playbackStore;
  const flightLog = { getMinTime: () => 0, getMaxTime: () => 10e6 };

  beforeEach(() => {
    playbackStore = usePlaybackStore(pinia);
    playbackStore.videoExportInTime = null;
    playbackStore.videoExportOutTime = null;
    clearIsolation();
  });

  it("stores the isolated block", () => {
    setIsolateInTime(3e6);
    setIsolateOutTime(6e6);
    expect(getIsolatedRange(flightLog)).toEqual({ start: 3e6, end: 6e6 });
  });

  it("clamps new points into the trimmed range", () => {
    playbackStore.videoExportInTime = 2e6;
    playbackStore.videoExportOutTime = 8e6;
    setIsolateInTime(1e6);
    setIsolateOutTime(9e6);
    expect(playbackStore.isolateInTime).toBe(2e6);
    expect(playbackStore.isolateOutTime).toBe(8e6);
  });

  it("drops the opposite point when the new point crosses it", () => {
    setIsolateInTime(3e6);
    setIsolateOutTime(6e6);
    setIsolateInTime(7e6);
    expect(playbackStore.isolateInTime).toBe(7e6);
    expect(playbackStore.isolateOutTime).toBeNull();
  });

  it("clears a point when set to null", () => {
    setIsolateInTime(3e6);
    setIsolateInTime(null);
    expect(playbackStore.isolateInTime).toBeNull();
    expect(getIsolatedRange(flightLog)).toBeNull();
  });
});
