import { describe, it, expect } from "vitest";
import {
  OPS,
  NOTES_CONFLICT_SEPARATOR,
  craftKey,
  emptySyncState,
  recordChange,
  pendingCount,
  markSynced,
  stripImages,
  mergeLogs,
} from "./tuning_log_sync.js";

function entry(id, extra = {}) {
  return { id, timestamp: `2026-09-01T00:00:0${id.slice(-1)}.000Z`, config: "", notes: "", ...extra };
}

function log(entries, extra = {}) {
  return { formatVersion: 1, logId: "L1", name: "Log", craftName: "Heli", entries, deletedEntries: [], ...extra };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

describe("craftKey", () => {
  it("normalises case, spacing and punctuation", () => {
    expect(craftKey("TRON 7.0")).toBe("tron-7-0");
    expect(craftKey("  Tron 7.0 ")).toBe("tron-7-0");
    expect(craftKey("Goblin_420!")).toBe("goblin-420");
  });

  it("uses 'unnamed' for a missing or symbol-only name", () => {
    expect(craftKey("")).toBe("unnamed");
    expect(craftKey(null)).toBe("unnamed");
    expect(craftKey("***")).toBe("unnamed");
  });
});

describe("recordChange", () => {
  it("queues changes in order", () => {
    const sync = emptySyncState();
    recordChange(sync, { op: OPS.CREATE_LOG });
    recordChange(sync, { op: OPS.ADD_ENTRY, entryId: "a" });
    expect(sync.pending.map((c) => c.op)).toEqual([OPS.CREATE_LOG, OPS.ADD_ENTRY]);
    expect(pendingCount(sync)).toBe(2);
  });

  it("counts repeated edits to the same entry once", () => {
    const sync = emptySyncState();
    recordChange(sync, { op: OPS.UPDATE_NOTES, entryId: "a" });
    recordChange(sync, { op: OPS.UPDATE_NOTES, entryId: "a" });
    recordChange(sync, { op: OPS.SET_AI, entryId: "a" });
    recordChange(sync, { op: OPS.SET_AI, entryId: "a" });
    expect(pendingCount(sync)).toBe(2);
  });

  it("replaces an entry's other pending changes with its deletion", () => {
    const sync = emptySyncState();
    recordChange(sync, { op: OPS.ADD_ENTRY, entryId: "a" });
    recordChange(sync, { op: OPS.UPDATE_NOTES, entryId: "a" });
    recordChange(sync, { op: OPS.DELETE_ENTRY, entryId: "a" });
    expect(sync.pending.map((c) => c.op)).toEqual([OPS.DELETE_ENTRY]);
  });

  it("keeps the deletion of an already-synced entry, replacing its other pending changes", () => {
    const sync = emptySyncState();
    recordChange(sync, { op: OPS.UPDATE_NOTES, entryId: "a" });
    recordChange(sync, { op: OPS.DELETE_ENTRY, entryId: "a" });
    expect(sync.pending.map((c) => c.op)).toEqual([OPS.DELETE_ENTRY]);
  });
});

describe("markSynced / stripImages", () => {
  it("stores an image-free base and empties the outbox", () => {
    const sync = recordChange(emptySyncState(), { op: OPS.CREATE_LOG });
    const synced = log([entry("e1", { image: "data:image/png;base64,AAAA" })]);

    markSynced(sync, synced, "sha1", "2026-09-23T00:00:00.000Z");

    expect(sync.pending).toEqual([]);
    expect(sync.baseSha).toBe("sha1");
    expect(sync.base.entries[0].image).toBeUndefined();
    expect(sync.base.entries[0].hasImage).toBe(true);
    expect(synced.entries[0].image).toBe("data:image/png;base64,AAAA");
  });

  it("returns null for no log", () => {
    expect(stripImages(null)).toBeNull();
  });
});

describe("mergeLogs", () => {
  it("returns the local copy when there's no cloud copy yet", () => {
    const local = log([entry("e1")]);
    expect(mergeLogs(null, local, null)).toEqual(local);
  });

  it("unions entries added on each side", () => {
    const base = log([entry("e1")]);
    const local = log([entry("e1"), entry("e2")]);
    const remote = log([entry("e1"), entry("e3")]);

    const merged = mergeLogs(base, local, remote);
    expect(merged.entries.map((e) => e.id)).toEqual(["e1", "e3", "e2"]);
  });

  it("doesn't duplicate an entry captured on both sides", () => {
    const merged = mergeLogs(log([]), log([entry("e1")]), log([entry("e1")]));
    expect(merged.entries.map((e) => e.id)).toEqual(["e1"]);
  });

  it("honours deletions from either side, and keeps the tombstones", () => {
    const base = log([entry("e1"), entry("e2")]);
    const local = log([entry("e2")], { deletedEntries: [{ id: "e1", deletedAt: "2026-09-02T00:00:00.000Z" }] });
    const remote = log([entry("e1")], { deletedEntries: [{ id: "e2", deletedAt: "2026-09-03T00:00:00.000Z" }] });

    const merged = mergeLogs(base, local, remote);
    expect(merged.entries).toEqual([]);
    expect(merged.deletedEntries.map((t) => t.id).sort()).toEqual(["e1", "e2"]);
  });

  describe("re-adding a deleted entry (same flight captured again, so the same id)", () => {
    const added = "2026-09-01T00:00:00.000Z";
    const deleted = "2026-09-02T00:00:00.000Z";
    const readded = "2026-09-03T00:00:00.000Z";

    it("keeps an entry added after its tombstone", () => {
      const base = log([], { deletedEntries: [{ id: "e1", deletedAt: deleted }] });
      const local = log([entry("e1", { addedAt: readded })], { deletedEntries: [{ id: "e1", deletedAt: deleted }] });
      const merged = mergeLogs(base, local, clone(base));
      expect(merged.entries.map((e) => e.id)).toEqual(["e1"]);
    });

    it("replaces the old copy the other side still has with the re-added one", () => {
      const old = entry("e1", { addedAt: added, notes: "old notes" });
      const base = log([old]);
      const local = log([entry("e1", { addedAt: readded, notes: "" })], {
        deletedEntries: [{ id: "e1", deletedAt: deleted }],
      });
      const merged = mergeLogs(base, local, clone(base));
      expect(merged.entries).toHaveLength(1);
      expect(merged.entries[0].addedAt).toBe(readded);
      expect(merged.entries[0].notes).toBe("");
    });

    it("still deletes an entry deleted again after being re-added", () => {
      const tombstones = [
        { id: "e1", deletedAt: deleted },
        { id: "e1", deletedAt: "2026-09-04T00:00:00.000Z" },
      ];
      const base = log([entry("e1", { addedAt: readded })]);
      const local = log([], { deletedEntries: [tombstones[1]] });
      const remote = log([entry("e1", { addedAt: readded })], { deletedEntries: [tombstones[0]] });
      expect(mergeLogs(base, local, remote).entries).toEqual([]);
    });

    it("still deletes entries from before addedAt existed", () => {
      const base = log([entry("e1")]);
      const local = log([], { deletedEntries: [{ id: "e1", deletedAt: deleted }] });
      expect(mergeLogs(base, local, clone(base)).entries).toEqual([]);
    });
  });

  it("keeps a local image on a merged entry (remote copies carry none)", () => {
    const local = log([entry("e1", { image: "data:image/png;base64,AAAA" })]);
    const remote = log([entry("e1", { hasImage: true })]);
    expect(mergeLogs(stripImages(local), local, remote).entries[0].image).toBe("data:image/png;base64,AAAA");
  });

  describe("notes", () => {
    const base = log([entry("e1", { notes: "original" })]);

    it("takes the side that changed", () => {
      const changedLocally = log([entry("e1", { notes: "mine" })]);
      expect(mergeLogs(base, changedLocally, clone(base)).entries[0].notes).toBe("mine");

      const changedRemotely = log([entry("e1", { notes: "theirs" })]);
      expect(mergeLogs(base, clone(base), changedRemotely).entries[0].notes).toBe("theirs");
    });

    it("keeps both versions when both sides changed them", () => {
      const local = log([entry("e1", { notes: "mine" })]);
      const remote = log([entry("e1", { notes: "theirs" })]);

      const notes = mergeLogs(base, local, remote).entries[0].notes;
      expect(notes).toContain("mine");
      expect(notes).toContain("theirs");
      expect(notes).toContain(NOTES_CONFLICT_SEPARATOR);
    });
  });

  describe("AI results", () => {
    const q = (text) => ({ role: "user", content: text });
    const a = (text) => ({ role: "assistant", content: text });
    const base = log([entry("e1", { ai: { model: "m", conversation: [q("1"), a("1")], costUsd: 1 } })]);

    it("takes the side that asked a follow-up", () => {
      const local = log([entry("e1", { ai: { model: "m", conversation: [q("1"), a("1"), q("2"), a("2")], costUsd: 2 } })]);
      const merged = mergeLogs(base, local, clone(base)).entries[0].ai;
      expect(merged.conversation).toHaveLength(4);
      expect(merged.costUsd).toBe(2);
    });

    it("keeps both sides' follow-ups when both asked something, adding up the cost", () => {
      const local = log([entry("e1", { ai: { model: "m", conversation: [q("1"), a("1"), q("L"), a("L")], costUsd: 1.5 } })]);
      const remote = log([entry("e1", { ai: { model: "m", conversation: [q("1"), a("1"), q("R"), a("R")], costUsd: 1.25 } })]);

      const merged = mergeLogs(base, local, remote).entries[0].ai;
      expect(merged.conversation.map((m) => m.content)).toEqual(["1", "1", "R", "R", "L", "L"]);
      expect(merged.costUsd).toBeCloseTo(1.75);
    });

    it("keeps an analysis made only on one side", () => {
      const noAi = log([entry("e1")]);
      const withAi = log([entry("e1", { ai: { model: "m", conversation: [q("1"), a("1")], costUsd: 1 } })]);
      expect(mergeLogs(noAi, noAi, withAi).entries[0].ai.costUsd).toBe(1);
      expect(mergeLogs(noAi, withAi, noAi).entries[0].ai.costUsd).toBe(1);
    });
  });

  it("merges log-level fields three ways, preferring this computer's edit on a conflict", () => {
    const base = log([]);
    expect(mergeLogs(base, log([], { name: "Mine" }), log([])).name).toBe("Mine");
    expect(mergeLogs(base, log([]), log([], { name: "Theirs" })).name).toBe("Theirs");
    expect(mergeLogs(base, log([], { name: "Mine" }), log([], { name: "Theirs" })).name).toBe("Mine");
  });

  it("doesn't modify its inputs", () => {
    const base = log([entry("e1")]);
    const local = log([entry("e1", { notes: "mine" }), entry("e2")]);
    const remote = log([entry("e1", { notes: "theirs" })]);
    const snapshot = clone({ base, local, remote });

    mergeLogs(base, local, remote);
    expect({ base, local, remote }).toEqual(snapshot);
  });
});
