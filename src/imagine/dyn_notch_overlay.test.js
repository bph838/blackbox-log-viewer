import { describe, expect, test } from "vitest";
import { dynNotchStats, notchLowerCutoff } from "./dyn_notch_overlay.js";
import { notchFilterGetQ } from "./filters/filters.js";

describe("dynamic notch overlay", () => {
  test("lower cutoff is the inverse of the firmware's notch Q", () => {
    for (const [f0, q] of [[80, 2.5], [150, 4.5], [33, 1.2]]) {
      const f1 = notchLowerCutoff(f0, q);
      expect(f1).toBeLessThan(f0);
      expect(notchFilterGetQ(f0, f1)).toBeCloseTo(q, 9);
    }
  });

  test("medians and histogram per axis", () => {
    const count = 2;
    const n = 5;
    const centers = new Float32Array(n * 3 * count);
    for (let i = 0; i < n; i++) {
      centers[i * 3 * count + 1 * count + 0] = 40 + i; // pitch notch 1: 40..44
      centers[i * 3 * count + 1 * count + 1] = 100; // pitch notch 2: 100
    }
    const stats = dynNotchStats(centers, count, 1, 0, n, 250);
    expect(stats.medians).toEqual([42, 100]);
    expect(stats.histogram[100]).toBe(5);
    expect(stats.maxBin).toBe(5);
  });
});
