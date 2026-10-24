import { describe, it, expect, beforeEach } from "vitest";
import { createGitHubClient } from "./github_client.js";
import { createFakeGitHub } from "./testing/fake_github.js";
import * as TuningLog from "./tuning_log.js";
import { OPS, emptySyncState, recordChange, NOTES_CONFLICT_SEPARATOR } from "./tuning_log_sync.js";
import {
  syncLog,
  fetchIndex,
  indexRowsForCraft,
  downloadLog,
  setIndexRow,
  emptyIndex,
  defaultLogDir,
  deleteLog,
  migrateLegacyLogs,
} from "./tuning_log_cloud.js";

const IMG_A = "data:image/png;base64,QUFBQQ==";
const IMG_B = "data:image/png;base64,QkJCQg==";

function newLog(name = "Cyclic", craftName = "TRON 7.0") {
  const log = TuningLog.create(name, craftName);
  return { log, sync: recordChange(emptySyncState(), { op: OPS.CREATE_LOG }) };
}

function add(state, timestamp, image, extra = {}) {
  const entry = TuningLog.addEntry(state.log, { image, timestamp, ...extra });
  recordChange(state.sync, { op: OPS.ADD_ENTRY, entryId: entry.id });
  return entry;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

// One "computer": its own local copy + sync state, synced through its own client.
async function sync(client, state) {
  const result = await syncLog(client, state.log, state.sync);
  state.log = result.log;
  state.sync = result.sync;
  return result;
}

describe("tuning log cloud sync", () => {
  let fake;
  let client;

  beforeEach(() => {
    fake = createFakeGitHub();
    client = createGitHubClient({ repo: "me/tuning", token: "t", fetch: fake.fetch });
  });

  it("uploads a new log, its images and the index in one commit", async () => {
    const state = newLog();
    const entry = add(state, "2026-09-01T00:00:00.000Z", IMG_A);

    const result = await sync(client, state);
    expect(result.uploaded).toBe(true);
    expect(state.sync.pending).toEqual([]);

    const dir = defaultLogDir(state.log);
    expect(dir).toBe(`crafts/tron-7-0/${state.log.logId}`);

    const files = fake.files();
    const stored = JSON.parse(files[`${dir}/log.json`]);
    expect(stored.entries).toBeUndefined();
    expect(stored.entryFiles).toEqual([{ id: entry.id, hash: expect.any(String) }]);
    const storedEntry = JSON.parse(files[`${dir}/entries/${entry.id}.json`]);
    expect(storedEntry.image).toBeUndefined();
    expect(storedEntry.hasImage).toBe(true);
    expect(fake.fileBase64(`${dir}/images/${entry.id}.png`)).toBe("QUFBQQ==");

    const rows = indexRowsForCraft(await fetchIndex(client), "Tron 7.0");
    expect(rows).toEqual([expect.objectContaining({ logId: state.log.logId, name: "Cyclic", path: dir, entryCount: 1 })]);

    // README (initialising the empty repo) + one commit with everything.
    expect(fake.commitCount()).toBe(2);
  });

  it("does nothing when neither side has changed", async () => {
    const state = newLog();
    await sync(client, state);
    const commits = fake.commitCount();

    const result = await sync(client, state);
    expect(result).toMatchObject({ uploaded: false, downloaded: false });
    expect(fake.commitCount()).toBe(commits);
  });

  it("only uploads an image once", async () => {
    const state = newLog();
    add(state, "2026-09-01T00:00:00.000Z", IMG_A);
    await sync(client, state);

    add(state, "2026-09-02T00:00:00.000Z", IMG_B);
    const blobPosts = () => fake.requests.filter((r) => r.method === "POST" && r.path.endsWith("/git/blobs")).length;
    const before = blobPosts();
    await sync(client, state);

    // The new image, its entry, log.json and index.json - not the first entry or image again.
    expect(blobPosts() - before).toBe(4);
  });

  it("only uploads the entry that changed, and only downloads entries it hasn't got", async () => {
    const pc1 = newLog();
    add(pc1, "2026-09-01T00:00:00.000Z", IMG_A);
    const edited = add(pc1, "2026-09-02T00:00:00.000Z", IMG_B);
    await sync(client, pc1);
    const pc2 = clone(pc1);

    pc1.log.entries.find((e) => e.id === edited.id).notes = "too much bounce-back";
    recordChange(pc1.sync, { op: OPS.UPDATE_NOTES, entryId: edited.id });
    const blobPosts = () => fake.requests.filter((r) => r.method === "POST" && r.path.endsWith("/git/blobs")).length;
    const posted = blobPosts();
    await sync(client, pc1);
    // The edited entry, log.json and index.json.
    expect(blobPosts() - posted).toBe(3);

    const entryReads = () => fake.requests.filter((r) => r.method === "GET" && r.path.includes("/entries/")).length;
    const read = entryReads();
    const result = await sync(client, pc2);
    expect(result.downloaded).toBe(true);
    expect(entryReads() - read).toBe(1);
    expect(pc2.log.entries.find((e) => e.id === edited.id).notes).toBe("too much bounce-back");
  });

  it("reads a log in the old layout and rewrites it with one file per entry", async () => {
    const pc1 = newLog();
    const first = add(pc1, "2026-09-01T00:00:00.000Z", IMG_A, { notes: "old" });
    await sync(client, pc1);
    const dir = pc1.sync.cloudDir;

    // As an older version of the app would have stored it.
    const legacy = clone(pc1.sync.base);
    fake.commitElsewhere({ [`${dir}/log.json`]: JSON.stringify(legacy), [`${dir}/entries/${first.id}.json`]: null });

    const row = indexRowsForCraft(await fetchIndex(client), "TRON 7.0")[0];
    const pc2 = await downloadLog(client, row);
    expect(pc2.log.entries).toEqual([expect.objectContaining({ id: first.id, notes: "old", image: IMG_A })]);

    const result = await sync(client, pc2);
    expect(result.uploaded).toBe(true);
    const stored = JSON.parse(fake.files()[`${dir}/log.json`]);
    expect(stored.entries).toBeUndefined();
    expect(stored.entryFiles.map((r) => r.id)).toEqual([first.id]);
    expect(JSON.parse(fake.files()[`${dir}/entries/${first.id}.json`]).notes).toBe("old");

    // pc1's copy is still in step (nothing to download, nothing lost).
    const again = await sync(client, pc1);
    expect(again.downloaded).toBe(false);
    expect(pc1.log.entries.map((e) => e.id)).toEqual([first.id]);
  });

  it("converts every old-layout log in the repo at once", async () => {
    const a = newLog("A");
    add(a, "2026-09-01T00:00:00.000Z", IMG_A);
    const b = newLog("B", "Goblin");
    add(b, "2026-09-02T00:00:00.000Z", IMG_B);
    await sync(client, a);
    await sync(client, b);
    fake.commitElsewhere({ [`${a.sync.cloudDir}/log.json`]: JSON.stringify(a.sync.base) });

    expect(await migrateLegacyLogs(client)).toEqual({ migrated: 1, total: 2 });
    expect(JSON.parse(fake.files()[`${a.sync.cloudDir}/log.json`]).entryFiles).toHaveLength(1);
    expect(await migrateLegacyLogs(client)).toEqual({ migrated: 0, total: 2 });
  });

  it("re-uploads a re-captured image and passes it on to another computer", async () => {
    const a = newLog();
    const entry = add(a, "2026-09-01T00:00:00.000Z", IMG_A);
    await sync(client, a);
    const b = clone(a);

    const aEntry = a.log.entries[0];
    aEntry.image = IMG_B;
    aEntry.imageUpdatedAt = "2026-09-03T00:00:00.000Z";
    recordChange(a.sync, { op: OPS.UPDATE_IMAGE, entryId: entry.id });
    expect((await sync(client, a)).uploaded).toBe(true);
    expect(fake.fileBase64(`${defaultLogDir(a.log)}/images/${entry.id}.png`)).toBe("QkJCQg==");

    const result = await sync(client, b);
    expect(result.downloaded).toBe(true);
    expect(b.log.entries[0].image).toBe(IMG_B);
  });

  it("merges work done offline on two computers, keeping everything", async () => {
    // Computer 1 creates the log and syncs it.
    const pc1 = newLog();
    const shared = add(pc1, "2026-09-01T00:00:00.000Z", IMG_A, { notes: "first flight" });
    await sync(client, pc1);

    // Computer 2 downloads it.
    const client2 = createGitHubClient({ repo: "me/tuning", token: "t", fetch: fake.fetch });
    const [row] = indexRowsForCraft(await fetchIndex(client2), "TRON 7.0");
    const pc2 = await downloadLog(client2, row);
    expect(pc2.log.entries[0].image).toBe(IMG_A);

    // Both work offline.
    const fromPc1 = add(pc1, "2026-09-02T00:00:00.000Z", IMG_B);
    pc1.log.entries.find((e) => e.id === shared.id).notes = "edited on pc1";
    recordChange(pc1.sync, { op: OPS.UPDATE_NOTES, entryId: shared.id });

    const fromPc2 = add(pc2, "2026-09-03T00:00:00.000Z", IMG_B);
    pc2.log.entries.find((e) => e.id === shared.id).notes = "edited on pc2";
    recordChange(pc2.sync, { op: OPS.UPDATE_NOTES, entryId: shared.id });

    // Both come back online.
    await sync(client, pc1);
    await sync(client2, pc2);
    await sync(client, pc1);

    for (const state of [pc1, pc2]) {
      expect(state.log.entries.map((e) => e.id).sort()).toEqual([shared.id, fromPc1.id, fromPc2.id].sort());
      const notes = state.log.entries.find((e) => e.id === shared.id).notes;
      expect(notes).toContain("edited on pc1");
      expect(notes).toContain("edited on pc2");
      expect(notes).toContain(NOTES_CONFLICT_SEPARATOR);
      // Images from the other computer were downloaded.
      expect(state.log.entries.every((e) => e.image)).toBe(true);
      expect(state.sync.pending).toEqual([]);
    }
  });

  it("retries when another computer commits in the middle of a save", async () => {
    const pc1 = newLog();
    await sync(client, pc1);
    add(pc1, "2026-09-01T00:00:00.000Z", IMG_A);

    let interfered = false;
    const racingClient = createGitHubClient({
      repo: "me/tuning",
      token: "t",
      fetch: async (url, init) => {
        if (!interfered && init && init.method === "POST" && url.endsWith("/git/commits")) {
          interfered = true;
          fake.commitElsewhere({ "crafts/goblin/other/log.json": "{}" });
        }
        return fake.fetch(url, init);
      },
    });

    const result = await sync(racingClient, pc1);
    expect(result.uploaded).toBe(true);
    expect(fake.files()["crafts/goblin/other/log.json"]).toBe("{}");
    expect(JSON.parse(fake.files()[`${defaultLogDir(pc1.log)}/log.json`]).entryFiles).toHaveLength(1);
  });

  it("propagates a deletion and removes the entry's image from the repo", async () => {
    const pc1 = newLog();
    const entry = add(pc1, "2026-09-01T00:00:00.000Z", IMG_A);
    await sync(client, pc1);
    const imageFile = `${defaultLogDir(pc1.log)}/images/${entry.id}.png`;
    expect(fake.fileBase64(imageFile)).toBeDefined();

    const pc2 = await downloadLog(client, indexRowsForCraft(await fetchIndex(client), "TRON 7.0")[0]);

    pc1.log.entries = [];
    pc1.log.deletedEntries.push({ id: entry.id, deletedAt: new Date(Date.now() + 1000).toISOString() });
    recordChange(pc1.sync, { op: OPS.DELETE_ENTRY, entryId: entry.id });
    await sync(client, pc1);

    expect(fake.fileBase64(imageFile)).toBeUndefined();
    expect(fake.files()[`${defaultLogDir(pc1.log)}/entries/${entry.id}.json`]).toBeUndefined();

    await sync(client, pc2);
    expect(pc2.log.entries).toEqual([]);
  });

  it("deletes a log, its images and its index row, and doesn't bring it back", async () => {
    const pc1 = newLog();
    const entry = add(pc1, "2026-09-01T00:00:00.000Z", IMG_A);
    const other = newLog("Tail");
    await sync(client, pc1);
    await sync(client, other);
    const dir = pc1.sync.cloudDir;

    const row = indexRowsForCraft(await fetchIndex(client), "TRON 7.0").find((r) => r.logId === pc1.log.logId);
    const pc2 = await downloadLog(client, row);

    expect(await deleteLog(client, pc1.log.logId)).toBe(true);
    expect(fake.files()[`${dir}/log.json`]).toBeUndefined();
    expect(fake.fileBase64(`${dir}/images/${entry.id}.png`)).toBeUndefined();
    expect(fake.files()[`${dir}/entries/${entry.id}.json`]).toBeUndefined();
    expect(indexRowsForCraft(await fetchIndex(client), "TRON 7.0").map((r) => r.name)).toEqual(["Tail"]);

    // A computer with a copy (even with changes of its own) is told, rather than re-uploading it.
    recordChange(pc2.sync, { op: OPS.IMPORT_LOG });
    const result = await syncLog(client, pc2.log, pc2.sync);
    expect(result.deletedInCloud).toBe(true);
    expect(fake.files()[`${dir}/log.json`]).toBeUndefined();

    expect(await deleteLog(client, pc1.log.logId)).toBe(false);
  });

  it("keeps a log in its folder after its craft name changes, moving its index row", async () => {
    const state = newLog("Cyclic", "TRON 7.0");
    await sync(client, state);
    const dir = state.sync.cloudDir;

    state.log.craftName = "TRON 7.0 DD";
    recordChange(state.sync, { op: OPS.IMPORT_LOG });
    await sync(client, state);

    const index = await fetchIndex(client);
    expect(indexRowsForCraft(index, "TRON 7.0")).toEqual([]);
    expect(indexRowsForCraft(index, "TRON 7.0 DD")[0].path).toBe(dir);
  });

  it("fails with a network error when offline, leaving the outbox intact", async () => {
    const state = newLog();
    add(state, "2026-09-01T00:00:00.000Z", IMG_A);
    const before = clone(state);

    fake.setOnline(false);
    const error = await syncLog(client, state.log, state.sync).catch((e) => e);
    expect(error.isNetwork).toBe(true);
    expect(state).toEqual(before);
  });
});

describe("setIndexRow / indexRowsForCraft", () => {
  it("groups logs by craft and lists them newest first", () => {
    const index = emptyIndex();
    setIndexRow(index, { logId: "a", name: "A", craftName: "TRON 7.0", entries: [] }, "crafts/tron-7-0/a", "2026-01-01");
    setIndexRow(index, { logId: "b", name: "B", craftName: "tron 7.0", entries: [{}] }, "crafts/tron-7-0/b", "2026-02-01");
    setIndexRow(index, { logId: "c", name: "C", craftName: "Goblin", entries: [] }, "crafts/goblin/c", "2026-03-01");

    expect(indexRowsForCraft(index, "TRON 7.0").map((r) => r.logId)).toEqual(["b", "a"]);
    expect(indexRowsForCraft(index, "goblin").map((r) => r.logId)).toEqual(["c"]);
    expect(indexRowsForCraft(index, "nothing")).toEqual([]);
  });
});

describe("tuning log cloud sync with a token that can only use the contents API", () => {
  it("syncs between two computers, one file at a time", async () => {
    const fake = createFakeGitHub({ branchReadsForbidden: true, gitWritesForbidden: true });
    fake.commitElsewhere({ "README.md": "hi" });
    const client1 = createGitHubClient({ repo: "me/tuning", token: "t", fetch: fake.fetch });
    const client2 = createGitHubClient({ repo: "me/tuning", token: "t", fetch: fake.fetch });

    const pc1 = newLog();
    const first = add(pc1, "2026-09-01T00:00:00.000Z", IMG_A);
    await sync(client1, pc1);

    const pc2 = await downloadLog(client2, indexRowsForCraft(await fetchIndex(client2), "TRON 7.0")[0]);
    expect(pc2.log.entries[0].image).toBe(IMG_A);

    const second = add(pc2, "2026-09-02T00:00:00.000Z", IMG_B);
    await sync(client2, pc2);
    await sync(client1, pc1);

    expect(pc1.log.entries.map((e) => e.id).sort()).toEqual([first.id, second.id].sort());
    expect(pc1.log.entries.every((e) => e.image)).toBe(true);
    expect(pc1.sync.pending).toEqual([]);
  });
});
