import { describe, it, expect } from "vitest";
import * as THREE from "three";
import {
  nextPiroSection, isInPiroSection, mastLean, traceCountAt, analysePiroTrim, formatPiroTrim,
} from "./piro_wobble.js";
import { FlightLogParser } from "./flightlog_parser.js";

const TIME = FlightLogParser.prototype.FLIGHT_LOG_FIELD_INDEX_TIME;
const PIRO_FIELDS = { "attitude[2]": 2, "mixer[0]": 3, "mixer[1]": 4, "setpoint[0]": 5, "setpoint[1]": 6 };

// A piro at `degPerSec` for `seconds`, logged every 2 ms. The controller holds a body-fixed
// correction (rollOffset/pitchOffset, mixer units) plus a world-fixed "wind" correction, which
// turns round in the heli's frame as it yaws.
function piroLog({ seconds, degPerSec, rollOffset, pitchOffset, wind = 0, stick = 0 }) {
  const frames = [];
  for (let us = 0; us <= seconds * 1e6; us += 2000) {
    const yawDeg = (degPerSec * us) / 1e6;
    const a = (yawDeg * Math.PI) / 180;
    const frame = new Array(7).fill(0);
    frame[TIME] = us;
    // Logged as decidegrees wrapped to [-1800, 1800)
    frame[2] = ((((yawDeg * 10 + 1800) % 3600) + 3600) % 3600) - 1800;
    frame[3] = rollOffset + wind * Math.cos(a);
    frame[4] = pitchOffset + wind * Math.sin(a);
    frame[5] = stick;
    frames.push(frame);
  }
  return {
    getMainFieldIndexByName: (name) => PIRO_FIELDS[name],
    getChunksInTimeRange: () => [{ frames }],
  };
}

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

describe("analysePiroTrim", () => {
  it("finds the body-fixed correction and cancels world-fixed wind over whole turns", () => {
    const log = piroLog({ seconds: 3.5, degPerSec: 360, rollOffset: 6, pitchOffset: -3, wind: 40 });
    const r = analysePiroTrim(log, 0, 3.5e6);
    expect(r.ok).toBe(true);
    expect(r.wholeRevolutions).toBe(3);
    expect(r.rollTrim).toBeCloseTo(0.6, 1);
    expect(r.pitchTrim).toBeCloseTo(-0.3, 1);
    expect(r.stickWarning).toBe(false);
  });

  it("works for a piro the other way", () => {
    const r = analysePiroTrim(piroLog({ seconds: 2.2, degPerSec: -360, rollOffset: -10, pitchOffset: 0, wind: 30 }), 0, 2.2e6);
    expect(r.ok).toBe(true);
    expect(r.rollTrim).toBeCloseTo(-1.0, 1);
  });

  it("needs a full turn", () => {
    const r = analysePiroTrim(piroLog({ seconds: 0.8, degPerSec: 360, rollOffset: 5, pitchOffset: 5 }), 0, 0.8e6);
    expect(r.ok).toBe(false);
    expect(formatPiroTrim(r)).toContain("full turn");
  });

  it("flags cyclic stick input", () => {
    const r = analysePiroTrim(piroLog({ seconds: 1.5, degPerSec: 360, rollOffset: 0, pitchOffset: 0, stick: 50 }), 0, 1.5e6);
    expect(r.stickWarning).toBe(true);
    expect(formatPiroTrim(r)).toContain("unreliable");
  });
});
