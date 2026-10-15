import { describe, expect, test } from "vitest";
import { rpmNotchMarkers } from "./rpm_overlay.js";
import { notchFilterGetQ } from "./filters/filters.js";

const bank = (values) => [...values, ...new Array(16 - values.length).fill(0)];
const settings = (rpm) => ({
  rpm: {
    enabled: true,
    minHz: 33,
    preset: 0,
    source: [bank([11, 11, 11, 12, 21]), bank([]), bank([])],
    center: [bank([0, -133, 133, 0, 0]), bank([]), bank([])],
    q: [bank([15, 15, 15, 20, 40]), bank([]), bank([])],
    ...rpm,
  },
});

describe("RPM notch chart markers", () => {
  const speeds = { head: 1802, tail: 1802 * 4.5 };
  const range = { head: [1750, 1850], tail: [1750 * 4.5, 1850 * 4.5] };

  test("one marker per notch, placed and shaped like the filter", () => {
    const m = rpmNotchMarkers({ settings: settings({ minHz: 20 }), axis: 0, speeds, range, rotor: {}, filterRateHz: 2000 });
    expect(m.map((x) => x.name)).toEqual(["Main rotor ×1", "Main rotor ×1", "Main rotor ×1", "Main rotor ×2", "Tail rotor ×1"]);
    expect(m[0].hz).toBeCloseTo(1802 / 60, 6);
    expect(m[1].hz).toBeCloseTo((1802 / 60) * (1 - 0.0133), 6); // triple notch side
    expect(m[3].hz).toBeCloseTo((2 * 1802) / 60, 6);
    expect(m[4].hz).toBeCloseTo((1802 * 4.5) / 60, 6);
    // the triangle's cutoff gives back the notch's Q
    expect(notchFilterGetQ(m[3].hz, m[3].cutoffHz)).toBeCloseTo(2, 9);
    // headspeed spread
    expect(m[3].spread[0]).toBeCloseTo((2 * 1750) / 60, 6);
    expect(m[3].spread[1]).toBeCloseTo((2 * 1850) / 60, 6);
  });

  test("fading near the RPM minimum frequency, clamping, and off states", () => {
    // main rotor x1 at 30 Hz is below the 33 Hz minimum: clamped to 33 Hz and fully faded out
    const m = rpmNotchMarkers({ settings: settings(), axis: 0, speeds, rotor: {}, filterRateHz: 2000 });
    expect(m[0].hz).toBe(33);
    expect(m[0].fader).toBe(0);
    expect(m[3].fader).toBe(1);
    // partly faded in between min and 1.25 x min
    const partial = rpmNotchMarkers({ settings: settings({ minHz: 28 }), axis: 0, speeds, rotor: {}, filterRateHz: 2000 });
    expect(partial[0].fader).toBeGreaterThan(0);
    expect(partial[0].fader).toBeLessThan(1);
    expect(rpmNotchMarkers({ settings: settings({ enabled: false }), axis: 0, speeds, rotor: {}, filterRateHz: 2000 })).toEqual([]);
    // tail notches need a tail speed
    expect(rpmNotchMarkers({ settings: settings(), axis: 0, speeds: { head: 1802, tail: null }, rotor: {}, filterRateHz: 2000 }).map((x) => x.name)).not.toContain("Tail rotor ×1");
  });
});
