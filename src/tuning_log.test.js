import { describe, it, expect } from "vitest";
import {
  makeId,
  create,
  buildConfigSummary,
  resolveLogDateTimes,
  addEntry,
  buildFilename,
  validationError,
} from "./tuning_log.js";

describe("makeId", () => {
  it("is stable for the same input", () => {
    expect(makeId("2026-01-02T03:04:05.000Z")).toBe(makeId("2026-01-02T03:04:05.000Z"));
  });

  it("differs for different input", () => {
    expect(makeId("2026-01-02T03:04:05.000Z")).not.toBe(makeId("2026-01-02T03:04:05.001Z"));
  });

  it("ignores logIndex for a single-log file", () => {
    const ts = "2026-01-02T03:04:05.000Z";
    expect(makeId(ts, 0, 1)).toBe(makeId(ts));
    expect(makeId(ts, 5, 1)).toBe(makeId(ts));
  });

  it("folds logIndex into the id for a multi-log file, so same-timestamp sub-logs stay distinct", () => {
    const ts = "2026-01-02T03:04:05.000Z";
    expect(makeId(ts, 0, 3)).not.toBe(makeId(ts, 1, 3));
    expect(makeId(ts, 0, 3)).not.toBe(makeId(ts));
  });
});

describe("create", () => {
  it("builds an empty log with the given name/craftName", () => {
    const log = create("My Log", "My Heli");
    expect(log.formatVersion).toBe(1);
    expect(log.name).toBe("My Log");
    expect(log.craftName).toBe("My Heli");
    expect(log.entries).toEqual([]);
    expect(typeof log.logId).toBe("string");
  });

  it("falls back to craftName, then a default, when no name is given", () => {
    expect(create(null, "My Heli").name).toBe("My Heli");
    expect(create(null, null).name).toBe("Tuning Log");
  });
});

describe("buildConfigSummary", () => {
  it("flattens sorted key/value pairs, skipping null/undefined/function values", () => {
    const summary = buildConfigSummary({ b: 2, a: 1, skipMe: undefined, alsoSkip: () => {} });
    expect(summary).toBe("a: 1\nb: 2");
  });

  it("returns an empty string for an empty/missing config", () => {
    expect(buildConfigSummary({})).toBe("");
    expect(buildConfigSummary(undefined)).toBe("");
  });
});

describe("resolveLogDateTimes", () => {
  it("uses each log's own known start time and marks it as not calculated", () => {
    const results = resolveLogDateTimes(
      [
        { startDateTime: "2026-03-04T05:00:00.000Z", durationMs: 60000 },
        { startDateTime: "2026-03-04T06:00:00.000Z", durationMs: 60000 },
      ],
      null,
    );

    expect(results).toEqual([
      { dateTime: "2026-03-04T05:00:00.000Z", isCalculated: false },
      { dateTime: "2026-03-04T06:00:00.000Z", isCalculated: false },
    ]);
  });

  it("falls back to fallbackIso for a leading unknown log", () => {
    const results = resolveLogDateTimes([{ startDateTime: null, durationMs: 60000 }], "2026-01-15T12:00:00.000Z");

    expect(results).toEqual([{ dateTime: "2026-01-15T12:00:00.000Z", isCalculated: true }]);
  });

  it("estimates an unknown log from the previous known log's end time (start + duration)", () => {
    const results = resolveLogDateTimes(
      [
        { startDateTime: "2026-03-04T05:00:00.000Z", durationMs: 60000 },
        { startDateTime: null, durationMs: 30000 },
        { startDateTime: "2026-03-05T00:00:00.000Z", durationMs: 60000 },
      ],
      null,
    );

    expect(results[1]).toEqual({ dateTime: "2026-03-04T05:01:00.000Z", isCalculated: true });
    // A later known log is trusted outright, even though it doesn't follow on from the estimate.
    expect(results[2]).toEqual({ dateTime: "2026-03-05T00:00:00.000Z", isCalculated: false });
  });

  it("keeps a run of consecutive unknown logs incrementing forward instead of colliding", () => {
    const results = resolveLogDateTimes(
      [
        { startDateTime: "2026-03-04T05:00:00.000Z", durationMs: 60000 },
        { startDateTime: null, durationMs: 30000 },
        { startDateTime: null, durationMs: 45000 },
      ],
      null,
    );

    expect(results[1].dateTime).toBe("2026-03-04T05:01:00.000Z");
    expect(results[2].dateTime).toBe("2026-03-04T05:01:30.000Z");
    expect(results[1].isCalculated).toBe(true);
    expect(results[2].isCalculated).toBe(true);
  });

  it("returns a null dateTime when there's no known log and no fallback", () => {
    const results = resolveLogDateTimes([{ startDateTime: null, durationMs: 60000 }], null);
    expect(results).toEqual([{ dateTime: null, isCalculated: true }]);
  });
});

describe("addEntry", () => {
  it("appends an entry with a derived id and returns it", () => {
    const log = create("Log", "Heli");
    const entry = addEntry(log, { timestamp: "2026-01-02T03:04:05.000Z", image: "data:x", config: "a: 1" });

    expect(log.entries).toHaveLength(1);
    expect(log.entries[0]).toBe(entry);
    expect(entry.id).toBe(makeId("2026-01-02T03:04:05.000Z"));
    expect(entry.image).toBe("data:x");
    expect(entry.notes).toBe("");
  });

  it("folds logIndex/logCount into the id when given", () => {
    const log = create("Log", "Heli");
    const entry = addEntry(log, {
      timestamp: "2026-01-02T03:04:05.000Z",
      logIndex: 2,
      logCount: 5,
    });

    expect(entry.id).toBe(makeId("2026-01-02T03:04:05.000Z", 2, 5));
    expect(entry.id).not.toBe(makeId("2026-01-02T03:04:05.000Z"));
  });
});

describe("buildFilename", () => {
  it("sanitizes the log name and includes a timestamp", () => {
    const filename = buildFilename({ name: "My Heli / Test!" });
    // Runs of characters outside [a-z0-9_-] collapse to a single "_" each.
    expect(filename).toMatch(/^RF_TUNING_LOG_My_Heli_Test__\d{8}_\d{6}\.json$/);
  });

  it("falls back to a default name when the log has none", () => {
    expect(buildFilename({})).toMatch(/^RF_TUNING_LOG_TuningLog_\d{8}_\d{6}\.json$/);
  });
});

describe("validationError", () => {
  it("accepts a well-formed tuning log", () => {
    expect(validationError(create("Log", "Heli"))).toBeNull();
  });

  it("rejects non-objects, arrays, and missing formatVersion", () => {
    expect(validationError(null)).not.toBeNull();
    expect(validationError([])).not.toBeNull();
    expect(validationError({})).not.toBeNull();
  });

  it("rejects a malformed entries field", () => {
    expect(validationError({ formatVersion: 1, entries: "nope" })).not.toBeNull();
    expect(validationError({ formatVersion: 1, entries: [null] })).not.toBeNull();
  });
});
