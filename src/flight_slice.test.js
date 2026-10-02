import { describe, it, expect } from "vitest";
import {
  parseFriendlyValue,
  selectSliceFields,
  buildFlightSlice,
  sliceToPromptText,
  sliceToSummaryText,
  isFlightSliceText,
  FLIGHT_SLICE_MARKER,
} from "./flight_slice.js";

// Frame layout: [iteration, time, gyroADC[0], setpoint[0], flightModeFlags]
const FIELD_INDEXES = { time: 1, "gyroADC[0]": 2, "setpoint[0]": 3, flightModeFlags: 4 };

function makeFlightLog(frames, minTime = 0) {
  return {
    getMinTime: () => minTime,
    getMainFieldIndexByName: (name) => FIELD_INDEXES[name],
    getChunksInTimeRange: () => [{ frames }],
  };
}

// 1 kHz frames from 0 to 1 s: gyro ramps 0..999, setpoint is constant 100
function rampFrames() {
  const frames = [];
  for (let i = 0; i < 1000; i++) {
    frames.push([i, i * 1000, i, 100, i < 500 ? 0 : 1]);
  }
  return frames;
}

// Stand-in for the presenter: degrees/s for rates, text for flags
function decode(name, raw) {
  if (name === "flightModeFlags") return raw ? "ANGLE" : "ACRO";
  return `${raw.toFixed(1)} °/s`;
}

const GRAPHS = [
  {
    label: "Roll",
    fields: [
      { name: "setpoint[0]", friendlyName: "Setpoint [roll]", hidden: false },
      { name: "gyroADC[0]", friendlyName: "Gyro [roll]", hidden: false },
    ],
  },
];

describe("parseFriendlyValue", () => {
  it("splits a number from its unit", () => {
    expect(parseFriendlyValue("-12.5 °/s")).toEqual({ value: -12.5, unit: "°/s" });
    expect(parseFriendlyValue("45.00 %")).toEqual({ value: 45, unit: "%" });
  });

  it("drops a secondary reading after the main unit", () => {
    expect(parseFriendlyValue("3000 rpm (50.0 Hz)")).toEqual({ value: 3000, unit: "rpm" });
    expect(parseFriendlyValue("1200 rpm / 20.0 hz")).toEqual({ value: 1200, unit: "rpm" });
  });

  it("returns null for non-numeric values", () => {
    expect(parseFriendlyValue("ANGLE | HORIZON")).toBeNull();
    expect(parseFriendlyValue("")).toBeNull();
  });
});

describe("selectSliceFields", () => {
  it("skips hidden fields, fields missing from the log, and duplicates", () => {
    const graphs = [
      {
        label: "Roll",
        fields: [
          { name: "gyroADC[0]", friendlyName: "Gyro [roll]", hidden: false },
          { name: "setpoint[0]", friendlyName: "Setpoint [roll]", hidden: true },
          { name: "notInLog", friendlyName: "Missing", hidden: false },
        ],
      },
      { label: "Again", fields: [{ name: "gyroADC[0]", friendlyName: "Gyro [roll]", hidden: false }] },
    ];
    const fields = selectSliceFields(graphs, makeFlightLog([]));
    expect(fields.map((f) => f.name)).toEqual(["gyroADC[0]"]);
    expect(fields[0]).toMatchObject({ graph: "Roll", label: "Gyro [roll]", index: 2 });
  });
});

describe("buildFlightSlice", () => {
  it("averages each field into buckets at the sample rate", () => {
    const slice = buildFlightSlice({
      flightLog: makeFlightLog(rampFrames()),
      range: { start: 0, end: 1e6 },
      graphs: GRAPHS,
      sampleRateHz: 10,
      workspace: "Tracking",
      decode,
    });

    expect(slice.rowCount).toBe(10);
    expect(slice.sampleRateHz).toBe(10);
    expect(slice.durationMs).toBe(1000);
    expect(slice.workspace).toBe("Tracking");
    expect(slice.fields).toEqual([
      { graph: "Roll", name: "setpoint[0]", label: "Setpoint [roll]", unit: "°/s" },
      { graph: "Roll", name: "gyroADC[0]", label: "Gyro [roll]", unit: "°/s" },
    ]);

    const lines = slice.csv.split("\n");
    expect(lines[0]).toBe("t_ms,setpoint[0],gyroADC[0]");
    // First bucket averages gyro 0..99 = 49.5
    expect(lines[1]).toBe("0,100,49.5");
    expect(lines[10]).toBe("900,100,949.5");

    expect(slice.stats["setpoint[0]"]).toEqual({ min: 100, max: 100, mean: 100, rms: 100 });
    expect(slice.stats["gyroADC[0]"].min).toBe(49.5);
    expect(slice.stats["gyroADC[0]"].max).toBe(949.5);
  });

  it("only includes frames inside the range, relative to its start", () => {
    const slice = buildFlightSlice({
      flightLog: makeFlightLog(rampFrames()),
      range: { start: 200000, end: 400000 },
      graphs: GRAPHS,
      sampleRateHz: 10,
      decode,
    });
    expect(slice.rowCount).toBe(2);
    expect(slice.range.offsetMs).toBe(200);
    expect(slice.csv.split("\n").slice(1)).toEqual(["0,100,249.5", "100,100,349.5"]);
  });

  it("reports non-numeric fields as their last value in each bucket", () => {
    const slice = buildFlightSlice({
      flightLog: makeFlightLog(rampFrames()),
      range: { start: 0, end: 1e6 },
      graphs: [{ label: "Modes", fields: [{ name: "flightModeFlags", friendlyName: "Flight mode", hidden: false }] }],
      sampleRateHz: 2,
      decode,
    });
    expect(slice.csv.split("\n")).toEqual(["t_ms,flightModeFlags", "0,ACRO", "500,ANGLE"]);
    expect(slice.stats).toEqual({});
  });

  it("skips buckets with no logged data", () => {
    const frames = rampFrames().filter((frame) => frame[1] < 300000 || frame[1] >= 600000);
    const slice = buildFlightSlice({
      flightLog: makeFlightLog(frames),
      range: { start: 0, end: 1e6 },
      graphs: GRAPHS,
      sampleRateHz: 10,
      decode,
    });
    expect(slice.rowCount).toBe(7);
  });

  it("throws a user-facing error when there's nothing to build", () => {
    const flightLog = makeFlightLog(rampFrames());
    expect(() => buildFlightSlice({ flightLog, range: null, graphs: GRAPHS, decode })).toThrow(/Ctrl\+I/);
    expect(() =>
      buildFlightSlice({ flightLog, range: { start: 0, end: 1e6 }, graphs: [], decode }),
    ).toThrow(/workspace/);
    expect(() =>
      buildFlightSlice({ flightLog, range: { start: 0, end: 60e6 }, graphs: GRAPHS, sampleRateHz: 1000, decode }),
    ).toThrow(/sample rate/);
  });
});

describe("slice prompt text", () => {
  const slice = buildFlightSlice({
    flightLog: makeFlightLog(rampFrames()),
    range: { start: 0, end: 1e6 },
    graphs: GRAPHS,
    sampleRateHz: 10,
    workspace: "Tracking",
    decode,
  });

  it("starts with the marker and includes the field legend and CSV", () => {
    const text = sliceToPromptText(slice);
    expect(text.startsWith(FLIGHT_SLICE_MARKER)).toBe(true);
    expect(isFlightSliceText(text)).toBe(true);
    expect(text).toContain('"Tracking" workspace');
    expect(text).toContain("- gyroADC[0]: Gyro [roll] (Roll graph), °/s");
    expect(text).toContain("```csv\nt_ms,setpoint[0],gyroADC[0]\n0,100,49.5");
  });

  it("summarises stats without the raw CSV", () => {
    const text = sliceToSummaryText(slice);
    expect(text).toContain("- Setpoint [roll]: min 100, max 100, mean 100, rms 100 °/s");
    expect(text).not.toContain("t_ms,");
  });

  it("doesn't mistake ordinary text for a slice", () => {
    expect(isFlightSliceText("What about the tail?")).toBe(false);
  });
});
