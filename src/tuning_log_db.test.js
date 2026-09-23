import { describe, it, expect, beforeEach } from "vitest";
import { createTuningLogDb, createMemoryBackend } from "./tuning_log_db.js";
import { emptySyncState, recordChange, OPS } from "./tuning_log_sync.js";

function makeLog(logId, craftName, entries) {
  return { formatVersion: 1, logId, name: `Log ${logId}`, craftName, entries, deletedEntries: [] };
}

describe("createTuningLogDb", () => {
  let db;

  beforeEach(() => {
    db = createTuningLogDb(createMemoryBackend());
  });

  it("round-trips a log, storing images separately and putting them back on load", async () => {
    const log = makeLog("L1", "Heli", [{ id: "e1", image: "data:image/png;base64,AAAA", notes: "n" }]);
    await db.putImage("L1", "e1", "data:image/png;base64,AAAA");
    await db.putLog(log, emptySyncState());

    const stored = await db.getLog("L1");
    expect(stored.log.entries[0].image).toBe("data:image/png;base64,AAAA");
    expect(stored.log.entries[0].notes).toBe("n");
    expect(stored.sync.pending).toEqual([]);
  });

  it("doesn't store image data in the log record itself", async () => {
    const backend = createMemoryBackend();
    db = createTuningLogDb(backend);
    await db.putLog(makeLog("L1", "Heli", [{ id: "e1", image: "data:image/png;base64,AAAA" }]), emptySyncState());

    const record = await backend.get("logs", "L1");
    expect(record.log.entries[0].image).toBeUndefined();
    expect(record.log.entries[0].hasImage).toBe(true);
  });

  it("resolves null for an unknown log", async () => {
    expect(await db.getLog("nope")).toBeNull();
  });

  it("lists logs with their craft key and pending change count", async () => {
    const sync = recordChange(emptySyncState(), { op: OPS.CREATE_LOG });
    await db.putLog(makeLog("L1", "TRON 7.0", [{ id: "e1" }]), sync);

    const [summary] = await db.listLogs();
    expect(summary).toMatchObject({ logId: "L1", craftName: "TRON 7.0", craftKey: "tron-7-0", entryCount: 1, pendingCount: 1 });
  });

  it("deletes a log along with its images", async () => {
    await db.putImage("L1", "e1", "data:image/png;base64,AAAA");
    await db.putLog(makeLog("L1", "Heli", [{ id: "e1", image: "x" }]), emptySyncState());

    await db.deleteLog("L1");
    expect(await db.getLog("L1")).toBeNull();
    expect(await db.getImage("L1", "e1")).toBeUndefined();
  });
});
