import { describe, expect, test } from "vitest";
import {
  convertToLayout,
  generateRpmLayout,
  notchCount,
  NOTCH_TYPE,
  parseRpmLayout,
} from "./rpm_notch_layout.js";
import { resolveRpmBanks } from "./filters/rpm_filter.js";

const pad = (a) => [...a, ...new Array(16 - a.length).fill(0)];
const cfg = (axes) => ({
  source: axes.map((a) => pad(a.map((n) => n[0]))),
  center: axes.map((a) => pad(a.map((n) => n[1]))),
  q: axes.map((a) => pad(a.map((n) => n[2]))),
});

describe("Configurator RPM notch layout", () => {
  test("parses single, double and triple notches and writes them back unchanged", () => {
    const rpm = cfg([
      [[10, 0, 80], [11, 0, 60]],
      [[11, 40, 25], [11, -40, 25], [12, 0, 30], [21, 0, 50]],
      [[12, 0, 30], [12, -66, 30], [12, 66, 30]],
    ]);
    const banks = parseRpmLayout(rpm);
    expect(banks).not.toBeNull();
    expect(banks[0][10]).toEqual({ enabled: true, type: NOTCH_TYPE.SINGLE, q: 8 });
    expect(banks[1][11]).toEqual({ enabled: true, type: NOTCH_TYPE.DOUBLE, q: 2.5 });
    expect(banks[2][12]).toEqual({ enabled: true, type: NOTCH_TYPE.TRIPLE, q: 3 });
    expect(banks[2][13].enabled).toBe(false);
    expect(notchCount(banks[1])).toBe(4);

    const back = generateRpmLayout(banks);
    // same notches per axis (generated in source order)
    expect(back.source[1].slice(0, 4)).toEqual([11, 11, 12, 21]);
    expect(back.center[1].slice(0, 2)).toEqual([40, -40]);
    expect(back.center[2].slice(0, 3)).toEqual([0, -66, 66]);
    expect(back.q[2].slice(0, 3)).toEqual([30, 30, 30]);
  });

  test("all three firmware presets are representable", () => {
    for (const preset of [1, 2, 3]) {
      expect(parseRpmLayout(resolveRpmBanks({ preset }))).not.toBeNull();
    }
  });

  test("layouts the Configurator can't show return null and convert approximately", () => {
    // M4 roll: main rotor x1 as a Q 1.0 centre notch with Q 1.5 side notches
    const rpm = cfg([[[11, 0, 10], [11, -133, 15], [11, 133, 15], [12, 0, 15]], [], []]);
    expect(parseRpmLayout(rpm)).toBeNull();
    const { banks, changed } = convertToLayout(rpm);
    expect(changed).toBe(true);
    expect(banks[0][11]).toEqual({ enabled: true, type: NOTCH_TYPE.TRIPLE, q: 1.5 });
    expect(banks[0][12]).toEqual({ enabled: true, type: NOTCH_TYPE.SINGLE, q: 1.5 });
  });

  test("a representable layout converts without change", () => {
    const rpm = resolveRpmBanks({ preset: 2 });
    expect(convertToLayout(rpm).changed).toBe(false);
  });
});
