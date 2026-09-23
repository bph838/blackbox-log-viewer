import { describe, it, expect, beforeEach } from "vitest";
import { setActivePinia, createPinia } from "pinia";
import { useTuningLogStore, setTuningLogDb, setTuningLogCloudForTests } from "./tuningLog.js";
import { useSettingsStore } from "./settings.js";
import { createTuningLogDb, createMemoryBackend } from "../tuning_log_db.js";
import { createGitHubClient } from "../github_client.js";
import { createFakeGitHub } from "../testing/fake_github.js";

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

describe("useTuningLogStore cloud sync", () => {
  let db;
  let fake;

  async function configuredStore() {
    setActivePinia(createPinia());
    const settings = useSettingsStore();
    settings.userSettings.githubRepo = "me/tuning";
    settings.userSettings.githubToken = "t";
    const store = useTuningLogStore();
    await store.ready;
    return store;
  }

  beforeEach(() => {
    localStorage.clear();
    db = createTuningLogDb(createMemoryBackend());
    setTuningLogDb(db);
    fake = createFakeGitHub();
    setTuningLogCloudForTests({
      clientFactory: (options) => createGitHubClient({ ...options, fetch: fake.fetch }),
      syncDelayMs: null,
      retryDelayMs: null,
    });
  });

  it("is off until a repo and token are set", async () => {
    const store = await freshStore();
    expect(store.syncStatus).toBe("off");
  });

  it("keeps work done offline and uploads it once back online", async () => {
    const store = await configuredStore();
    fake.setOnline(false);

    store.createLog("Cyclic", "TRON 7.0");
    store.addEntry({ image: IMAGE, timestamp: "2026-09-01T00:00:00.000Z" });
    await settle();
    await store.syncNow();

    expect(store.syncStatus).toBe("offline");
    expect(store.totalPendingCount).toBe(2);
    expect(Object.keys(fake.files())).toEqual([]);

    fake.setOnline(true);
    await store.syncNow();

    expect(store.syncStatus).toBe("synced");
    expect(store.totalPendingCount).toBe(0);
    const logFile = Object.keys(fake.files()).find((p) => p.endsWith("/log.json"));
    expect(JSON.parse(fake.files()[logFile]).entries).toHaveLength(1);
  });

  it("uploads every log with unsynced changes, not just the current one", async () => {
    const store = await configuredStore();
    fake.setOnline(false);
    store.createLog("Cyclic", "TRON 7.0");
    await settle();
    store.createLog("Tail", "TRON 7.0");
    await settle();

    fake.setOnline(true);
    await store.syncNow();

    const names = (await store.listCloudLogs("TRON 7.0")).map((r) => r.name).sort();
    expect(names).toEqual(["Cyclic", "Tail"]);
  });

  it("keeps changes made while a sync is running, leaving them pending", async () => {
    const store = await configuredStore();
    store.createLog("Cyclic", "TRON 7.0");
    const entry = store.addEntry({ image: IMAGE, timestamp: "2026-09-01T00:00:00.000Z" });
    await settle();

    // Edit the notes while the upload is in flight (after the sync has taken its snapshot).
    let edited = false;
    setTuningLogCloudForTests({
      clientFactory: (options) =>
        createGitHubClient({
          ...options,
          fetch: (url, init) => {
            if (!edited && init && init.method === "POST" && url.endsWith("/git/commits")) {
              edited = true;
              store.updateEntryNotes(entry.id, "typed during sync");
            }
            return fake.fetch(url, init);
          },
        }),
    });
    const settings = useSettingsStore();
    settings.userSettings.githubToken = "t2"; // new client, using the fetch above

    await store.syncNow();
    expect(edited).toBe(true);

    expect(store.entries[0].notes).toBe("typed during sync");
    expect(store.pendingChangeCount).toBe(1);

    await store.syncNow();
    expect(store.pendingChangeCount).toBe(0);
    const logFile = Object.keys(fake.files()).find((p) => p.endsWith("/log.json"));
    expect(JSON.parse(fake.files()[logFile]).entries[0].notes).toBe("typed during sync");
  });

  it("keeps an entry that was deleted and then captured again, on every computer", async () => {
    const pc1 = await configuredStore();
    pc1.createLog("Cyclic", "TRON 7.0");
    const capture = { image: IMAGE, config: "p: 1", timestamp: "2026-09-01T00:00:00.000Z" };
    const entry = pc1.addEntry(capture);
    await settle();
    await pc1.syncNow();

    pc1.deleteEntry(entry.id);
    await settle();
    await pc1.syncNow();
    expect(pc1.entries).toEqual([]);

    await new Promise((resolve) => setTimeout(resolve, 5));
    const again = pc1.addEntry(capture);
    expect(again.id).toBe(entry.id);
    await settle();
    await pc1.syncNow();
    expect(pc1.entries.map((e) => e.id)).toEqual([entry.id]);
    expect(pc1.entries[0].image).toBe(IMAGE);

    // Another computer opening the log sees it too, image and all.
    setTuningLogDb(createTuningLogDb(createMemoryBackend()));
    localStorage.clear();
    const pc2 = await configuredStore();
    const [row] = await pc2.listCloudLogs("TRON 7.0");
    await pc2.openCloudLog(row);
    expect(pc2.entries.map((e) => e.id)).toEqual([entry.id]);
    expect(pc2.entries[0].image).toBe(IMAGE);
  });

  it("lists a heli's logs from this computer and the cloud together, and opens either kind", async () => {
    const pc1 = await configuredStore();
    pc1.createLog("Cyclic", "TRON 7.0");
    await settle();
    pc1.createLog("Goblin log", "Goblin");
    await settle();
    await pc1.syncNow();

    // A second computer with a log of its own for the same heli, never synced.
    setTuningLogDb(createTuningLogDb(createMemoryBackend()));
    localStorage.clear();
    const pc2 = await configuredStore();
    fake.setOnline(false);
    pc2.createLog("Tail", "tron 7.0");
    await settle();
    fake.setOnline(true);

    const { logs, cloudError } = await pc2.listLogsForCraft("TRON 7.0");
    expect(cloudError).toBeNull();
    expect(logs.map((l) => [l.name, l.isLocal, l.inCloud]).sort()).toEqual([
      ["Cyclic", false, true],
      ["Tail", true, false],
    ]);

    expect(await pc2.openLog(logs.find((l) => l.name === "Cyclic"))).toBe(true);
    expect(pc2.currentLog.name).toBe("Cyclic");
    expect(await pc2.openLog(logs.find((l) => l.name === "Tail"))).toBe(true);
    expect(pc2.currentLog.name).toBe("Tail");
  });

  it("still lists this computer's logs when offline", async () => {
    const store = await configuredStore();
    store.createLog("Cyclic", "TRON 7.0");
    await settle();
    fake.setOnline(false);

    const { logs, cloudError } = await store.listLogsForCraft("TRON 7.0");
    expect(logs.map((l) => l.name)).toEqual(["Cyclic"]);
    expect(cloudError).toContain("Can't reach GitHub");
  });

  it("deletes a log from this computer and the cloud, and from other computers when they sync", async () => {
    const pc1 = await configuredStore();
    pc1.createLog("Cyclic", "TRON 7.0");
    pc1.addEntry({ image: IMAGE, timestamp: "2026-09-01T00:00:00.000Z" });
    await settle();
    await pc1.syncNow();
    const pc1Db = db;

    // A second computer that downloads it.
    setTuningLogDb(createTuningLogDb(createMemoryBackend()));
    localStorage.clear();
    const pc2 = await configuredStore();
    const [row] = await pc2.listCloudLogs("TRON 7.0");
    expect(await pc2.openCloudLog(row)).toBe(true);

    setTuningLogDb(pc1Db);
    const { logs } = await pc1.listLogsForCraft("TRON 7.0");
    expect(logs[0]).toMatchObject({ isLocal: true, inCloud: true });
    await pc1.deleteLog(logs[0]);

    expect(pc1.hasLog).toBe(false);
    expect(pc1.localLogs).toEqual([]);
    expect((await pc1.listLogsForCraft("TRON 7.0")).logs).toEqual([]);

    await pc2.syncNow();
    expect(pc2.hasLog).toBe(false);
    expect(pc2.localLogs).toEqual([]);
  });

  it("opens a cloud log on another computer, with its images", async () => {
    const pc1 = await configuredStore();
    pc1.createLog("Cyclic", "TRON 7.0");
    pc1.addEntry({ image: IMAGE, timestamp: "2026-09-01T00:00:00.000Z" });
    await settle();
    await pc1.syncNow();

    // A second computer: its own local storage, same repo.
    setTuningLogDb(createTuningLogDb(createMemoryBackend()));
    localStorage.clear();
    const pc2 = await configuredStore();
    expect(pc2.hasLog).toBe(false);

    const [row] = await pc2.listCloudLogs("tron 7.0");
    expect(row).toMatchObject({ name: "Cyclic", entryCount: 1, isLocal: false });

    expect(await pc2.openCloudLog(row)).toBe(true);
    expect(pc2.currentLog.name).toBe("Cyclic");
    expect(pc2.entries[0].image).toBe(IMAGE);
    expect(pc2.pendingChangeCount).toBe(0);
  });
});
