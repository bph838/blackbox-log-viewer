import { describe, it, expect, beforeEach } from "vitest";
import { setActivePinia, createPinia } from "pinia";
import { useTuningLogStore, setTuningLogDb } from "./tuningLog.js";
import { createTuningLogDb, createMemoryBackend } from "../tuning_log_db.js";

const IMAGE = "data:image/png;base64,AAAA";

// Saves are fire-and-forget from the UI's point of view - let them land before checking storage.
function settle() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function freshStore() {
  setActivePinia(createPinia());
  const store = useTuningLogStore();
  await store.ready;
  return store;
}

describe("useTuningLogStore", () => {
  let db;

  beforeEach(() => {
    localStorage.clear();
    db = createTuningLogDb(createMemoryBackend());
    setTuningLogDb(db);
  });

  it("starts with no log", async () => {
    const store = await freshStore();
    expect(store.hasLog).toBe(false);
    expect(store.localLogs).toEqual([]);
  });

  it("remembers the current log, entries and images between sessions", async () => {
    let store = await freshStore();
    store.createLog("Cyclic", "TRON 7.0");
    store.addEntry({ image: IMAGE, config: "p: 1", timestamp: "2026-09-01T00:00:00.000Z" });
    await settle();

    store = await freshStore();
    expect(store.currentLog.name).toBe("Cyclic");
    expect(store.currentLog.craftName).toBe("TRON 7.0");
    expect(store.entries).toHaveLength(1);
    expect(store.entries[0].image).toBe(IMAGE);
  });

  it("records every change in the outbox", async () => {
    const store = await freshStore();
    store.createLog("Cyclic", "TRON 7.0");
    const entry = store.addEntry({ image: IMAGE, timestamp: "2026-09-01T00:00:00.000Z" });
    store.updateEntryNotes(entry.id, "hello");
    store.setEntryAiResult(entry.id, { model: "m", conversation: [], costUsd: 0.1 });
    await settle();

    expect(store.pendingChangeCount).toBe(4);
    expect((await db.getLog(store.currentLog.logId)).sync.pending).toHaveLength(4);
  });

  it("keeps a tombstone when an entry is deleted", async () => {
    const store = await freshStore();
    store.createLog("Cyclic", "TRON 7.0");
    const entry = store.addEntry({ image: IMAGE, timestamp: "2026-09-01T00:00:00.000Z" });
    store.deleteEntry(entry.id);
    await settle();

    expect(store.entries).toEqual([]);
    expect(store.currentLog.deletedEntries.map((t) => t.id)).toEqual([entry.id]);
    expect(await db.getImage(store.currentLog.logId, entry.id)).toBeUndefined();
  });

  it("keeps every log locally and can switch between them", async () => {
    const store = await freshStore();
    const first = store.createLog("Cyclic", "TRON 7.0");
    await settle();
    store.createLog("Tail", "TRON 7.0");
    await settle();

    expect(store.localLogs.map((l) => l.name).sort()).toEqual(["Cyclic", "Tail"]);

    expect(await store.switchLog(first.logId)).toBe(true);
    expect(store.currentLog.name).toBe("Cyclic");
  });

  it("closing a log keeps it stored", async () => {
    const store = await freshStore();
    const log = store.createLog("Cyclic", "TRON 7.0");
    await settle();
    store.closeLog();

    expect(store.hasLog).toBe(false);
    expect(await db.getLog(log.logId)).not.toBeNull();
  });

  it("migrates a log left in localStorage by an older version", async () => {
    const legacy = {
      formatVersion: 1,
      logId: "legacy1",
      name: "Old log",
      craftName: "TRON 7.0",
      createdDate: "2026-01-01T00:00:00.000Z",
      entries: [{ id: "e1", timestamp: "2026-01-01T00:00:00.000Z", image: IMAGE, notes: "" }],
    };
    localStorage.setItem("tuningLog", JSON.stringify(legacy));

    const store = await freshStore();
    expect(store.currentLog.name).toBe("Old log");
    expect(store.entries[0].image).toBe(IMAGE);
    expect(store.pendingChangeCount).toBe(1);
    expect(JSON.parse(localStorage.getItem("tuningLog"))).toBeNull();
  });
});
