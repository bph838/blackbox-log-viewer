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
    expect(stored.entries[0].image).toBeUndefined();
    expect(stored.entries[0].hasImage).toBe(true);
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

    // The new image, log.json and index.json - not the first image again.
    expect(blobPosts() - before).toBe(3);
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
    expect(JSON.parse(fake.files()[`${defaultLogDir(pc1.log)}/log.json`]).entries).toHaveLength(1);
  });

  it("propagates a deletion and removes the entry's image from the repo", async () => {
    const pc1 = newLog();
    const entry = add(pc1, "2026-09-01T00:00:00.000Z", IMG_A);
    await sync(client, pc1);
    const imageFile = `${defaultLogDir(pc1.log)}/images/${entry.id}.png`;
    expect(fake.fileBase64(imageFile)).toBeDefined();

    const pc2 = await downloadLog(client, indexRowsForCraft(await fetchIndex(client), "TRON 7.0")[0]);

    pc1.log.entries = [];
    pc1.log.deletedEntries.push({ id: entry.id, deletedAt: "2026-09-05T00:00:00.000Z" });
    recordChange(pc1.sync, { op: OPS.DELETE_ENTRY, entryId: entry.id });
    await sync(client, pc1);

    expect(fake.fileBase64(imageFile)).toBeUndefined();

    await sync(client, pc2);
    expect(pc2.log.entries).toEqual([]);
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
