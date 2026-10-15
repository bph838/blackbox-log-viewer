import { describe, expect, test } from "vitest";
import { FILTER_TOOL, FILTER_PARAM_NAMES, validateProposal, toolResultText, diffSettings, changesToCli } from "./filter_tool.js";
import { analyseAxisNoise, foldFrequency, identifyPeak, rotorFrequencies } from "./filter_summary.js";

const base = () => ({
  lpf1: { type: 1, staticHz: 90, dynMinHz: 0, dynMaxHz: 0 },
  lpf2: { type: 0, staticHz: 0 },
  notch1: { hz: 0, cutoff: 0 },
  notch2: { hz: 0, cutoff: 0 },
  dynNotch: { enabled: true, count: 2, q: 25, minHz: 20, maxHz: 120 },
  rpm: {
    enabled: true,
    minHz: 39,
    preset: 0,
    source: [0, 1, 2].map(() => [11, 12, ...new Array(14).fill(0)]),
    center: [0, 1, 2].map(() => new Array(16).fill(0)),
    q: [0, 1, 2].map(() => [50, 30, ...new Array(14).fill(0)]),
  },
});

describe("filter suggestion tool", () => {
  test("schema is strict and lists every parameter", () => {
    expect(FILTER_TOOL.strict).toBe(true);
    expect(FILTER_TOOL.input_schema.additionalProperties).toBe(false);
    const param = FILTER_TOOL.input_schema.properties.changes.items.properties.parameter;
    expect(param.enum).toEqual(FILTER_PARAM_NAMES);
    expect(FILTER_PARAM_NAMES).toContain("gyro_rpm_notch_q_yaw");
    expect(FILTER_PARAM_NAMES).toContain("feature_DYN_NOTCH");
  });

  test("a valid proposal is applied to a copy, with old -> new for the card", () => {
    const b = base();
    const v = validateProposal(
      {
        name: "Step 1",
        summary: "x",
        changes: [
          { parameter: "gyro_lpf1_static_hz", value: [70], reason: "less noise above 70 Hz" },
          { parameter: "dyn_notch_q", value: [30], reason: "narrower" },
          { parameter: "gyro_rpm_notch_q_roll", value: [60, 30], reason: "deeper x1" },
        ],
      },
      b,
    );
    expect(v.ok).toBe(true);
    expect(v.settings.lpf1.staticHz).toBe(70);
    expect(b.lpf1.staticHz).toBe(90); // base untouched
    expect(v.settings.rpm.q[0].slice(0, 3)).toEqual([60, 30, 0]);
    expect(v.settings.rpm.q[0].length).toBe(16);
    const q = v.changes.find((c) => c.parameter === "dyn_notch_q");
    expect([q.oldText, q.newText]).toEqual(["2.5", "3.0"]);
    expect(toolResultText(v)).toMatch(/nothing has been applied/);
  });

  test("firmware ranges, integers, sources and cross-checks are enforced", () => {
    const bad = validateProposal(
      {
        changes: [
          { parameter: "dyn_notch_max_hz", value: [600], reason: "" },
          { parameter: "gyro_lpf1_static_hz", value: [70.5], reason: "" },
          { parameter: "gyro_rpm_notch_source_pitch", value: [11, 19], reason: "" },
          { parameter: "made_up", value: [1], reason: "" },
          { parameter: "gyro_notch1_hz", value: [100], reason: "" },
          { parameter: "gyro_notch1_cutoff", value: [120], reason: "" },
        ],
      },
      base(),
    );
    expect(bad.ok).toBe(false);
    expect(bad.settings).toBeNull();
    const text = bad.errors.join("\n");
    expect(text).toMatch(/dyn_notch_max_hz = 600 is outside the firmware range 100–500/);
    expect(text).toMatch(/whole numbers/);
    expect(text).toMatch(/invalid source/);
    expect(text).toMatch(/Unknown parameter "made_up"/);
    expect(text).toMatch(/gyro_notch1_cutoff \(120\) must be below gyro_notch1_hz \(100\)/);
    expect(toolResultText(bad)).toMatch(/rejected/);
  });

  test("warnings for Configurator ranges and presets", () => {
    const v = validateProposal({ changes: [{ parameter: "gyro_rpm_notch_q_roll", value: [10, 30], reason: "" }, { parameter: "gyro_rpm_notch_preset", value: [2], reason: "" }] }, base());
    expect(v.ok).toBe(true);
    expect(v.warnings.join("\n")).toMatch(/outside the Configurator's 1.5–10 range/);
    expect(v.warnings.join("\n")).toMatch(/ignored while gyro_rpm_notch_preset is 2/);
  });

  test("diff and CLI lines", () => {
    const a = base();
    const b = base();
    b.lpf2 = { type: 2, staticHz: 150 };
    b.dynNotch.enabled = false;
    const d = diffSettings(a, b);
    expect(d.map((c) => c.parameter)).toEqual(["gyro_lpf2_type", "gyro_lpf2_static_hz", "feature_DYN_NOTCH"]);
    // lowpass types are written by name - the CLI rejects the number
    expect(changesToCli(d)).toBe("set gyro_lpf2_type = SECOND_ORDER\nset gyro_lpf2_static_hz = 150\nfeature -DYN_NOTCH");
  });
});

describe("log summary helpers", () => {
  test("folding and peak identification", () => {
    expect(foldFrequency(312.5, 500)).toBeCloseTo(187.5);
    expect(foldFrequency(187.9, 250)).toBeCloseTo(62.1);
    const sources = rotorFrequencies({ mainGearRatio: 1 / 9.69 }, { head: 2506, tail: 2506 * 4.5 });
    expect(sources.find((s) => s.label === "main motor").hz).toBeCloseTo((2506 / 60) * 9.69, 1);
    expect(identifyPeak(41.5, sources, 500)).toBe("main rotor ×1");
    expect(identifyPeak(187, sources, 500)).toBe("tail rotor ×1");
    expect(identifyPeak(63.8, sources, 500)).toMatch(/alias of tail rotor ×3/);
    expect(identifyPeak(104, sources, 500)).toBe("unidentified");
  });

  test("finds tones as peaks and measures their amplitude", () => {
    const rate = 500;
    const n = 20000;
    const x = new Float64Array(n);
    let seed = 1;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5);
    for (let i = 0; i < n; i++) {
      x[i] = 10 * Math.sin((2 * Math.PI * 42 * i) / rate) + 3 * Math.sin((2 * Math.PI * 104 * i) / rate) + rnd();
    }
    const r = analyseAxisNoise(x, 0, n, rate, rotorFrequencies(null, { head: 2520 }));
    const hz = r.peaks.map((p) => Math.round(p.hz));
    expect(hz).toContain(42);
    expect(hz).toContain(104);
    const p42 = r.peaks.find((p) => Math.round(p.hz) === 42);
    expect(p42.rms).toBeCloseTo(10 / Math.SQRT2, 0); // a sine of amplitude A has rms A/√2
    expect(p42.source).toBe("main rotor ×1");
  });
});
