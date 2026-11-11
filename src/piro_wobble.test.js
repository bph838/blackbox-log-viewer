import { describe, it, expect } from "vitest";
import * as THREE from "three";
import { nextPiroSection, isInPiroSection, mastLean, traceCountAt } from "./piro_wobble.js";

describe("nextPiroSection", () => {
  it("starts, ends, and restarts", () => {
    let s = nextPiroSection({ start: null, end: null }, 100);
    expect(s).toEqual({ start: 100, end: null });
    s = nextPiroSection(s, 500);
    expect(s).toEqual({ start: 100, end: 500 });
    s = nextPiroSection(s, 800);
    expect(s).toEqual({ start: 800, end: null });
  });

  it("orders an end marked before the start", () => {
    expect(nextPiroSection({ start: 500, end: null }, 100)).toEqual({ start: 100, end: 500 });
  });

  it("cancels when pressed again at the start", () => {
    expect(nextPiroSection({ start: 500, end: null }, 500)).toEqual({ start: null, end: null });
  });
});

describe("isInPiroSection", () => {
  it("covers closed and open sections", () => {
    expect(isInPiroSection({ start: 10, end: 20 }, 15)).toBe(true);
    expect(isInPiroSection({ start: 10, end: 20 }, 25)).toBe(false);
    expect(isInPiroSection({ start: 10, end: null }, 9999)).toBe(true);
    expect(isInPiroSection({ start: null, end: null }, 15)).toBe(false);
  });
});

describe("mastLean", () => {
  it("is zero when level, whatever the yaw", () => {
    const lean = mastLean(0, 0, 1.3);
    expect(lean.degrees).toBeCloseTo(0);
    expect(lean.x).toBeCloseTo(0);
    expect(lean.y).toBeCloseTo(0);
  });

  it("matches the three.js model rotations", () => {
    const wrapper = new THREE.Object3D();
    const model = new THREE.Object3D();
    wrapper.add(model);
    for (const [roll, pitch, yaw] of [[0.05, 0, 0], [0, 0.08, 0], [0.03, -0.06, 2.1], [-0.1, 0.02, -0.7]]) {
      model.rotation.set(pitch, 0, roll);
      wrapper.rotation.y = yaw;
      wrapper.updateMatrixWorld(true);
      const up = new THREE.Vector3(0, 1, 0).transformDirection(model.matrixWorld);
      const lean = mastLean(roll, pitch, yaw);
      const deg = (Math.acos(up.y) * 180) / Math.PI;
      expect(lean.degrees).toBeCloseTo(deg, 6);
      const h = Math.hypot(up.x, up.z);
      expect(lean.x).toBeCloseTo((up.x / h) * deg, 6);
      expect(lean.y).toBeCloseTo((-up.z / h) * deg, 6);
    }
  });

  it("leans right for a right roll seen from behind", () => {
    // The heli's attitude follows +gyro, and the model negates it: a right roll is a negative z.
    expect(mastLean(-0.1, 0, 0).x).toBeGreaterThan(0);
  });
});

describe("traceCountAt", () => {
  it("counts samples at or before a time", () => {
    const t = Float64Array.from([10, 20, 30]);
    expect(traceCountAt(t, 5)).toBe(0);
    expect(traceCountAt(t, 20)).toBe(2);
    expect(traceCountAt(t, 99)).toBe(3);
  });
});
