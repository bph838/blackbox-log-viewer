import { beforeEach, describe, expect, it } from "vitest";
import { createGitHubClient } from "../../github_client.js";
import { createFakeGitHub } from "../../testing/fake_github.js";
import { appendUserMessage, createConversation } from "./conversation.js";
import { INDEX_PATH, defaultPath, fetchIndex, indexRows, isDirty, syncConversations } from "./conversation_cloud.js";

// One "computer": a Map of local records, synced the way ai_filters_store.js applies results.
function computer(client) {
  const records = new Map();
  return {
    records,
    add(craftName, text) {
      const record = createConversation({ craftName });
      appendUserMessage(record, text);
      record.rev = 1;
      records.set(record.id, record);
      return record;
    },
    edit(id, text) {
      const record = records.get(id);
      appendUserMessage(record, text);
      record.rev = (record.rev || 0) + 1;
    },
    remove(id) {
      const r = records.get(id);
      records.set(id, { id, deleted: true, craftName: r.craftName, cloud: r.cloud, rev: (r.rev || 0) + 1 });
    },
    async sync(craftName = null) {
      const result = await syncConversations(client, [...records.values()].map((r) => JSON.parse(JSON.stringify(r))), {
        craftName,
      });
      for (const { id } of result.removed) records.delete(id);
      for (const { record } of result.saved) records.set(record.id, record);
      return result;
    },
  };
}

describe("AI Filters conversation cloud sync", () => {
  let fake;
  let a;
  let b;
  let clientA;

  beforeEach(() => {
    fake = createFakeGitHub();
    clientA = createGitHubClient({ repo: "me/tuning", token: "t", fetch: fake.fetch });
    a = computer(clientA);
    b = computer(createGitHubClient({ repo: "me/tuning", token: "t", fetch: fake.fetch }));
  });

  it("uploads several conversations for one heli, each as its own file, without sync bookkeeping", async () => {
    const one = a.add("TRON 7.0", "Too much noise at 80 Hz");
    const two = a.add("TRON 7.0", "Is the dynamic notch needed?");

    const result = await a.sync();
    expect(result.uploaded).toBe(true);
    expect([...a.records.values()].every((r) => !isDirty(r))).toBe(true);

    const rows = indexRows(await fetchIndex(clientA));
    expect(rows.size).toBe(2);
    expect(rows.get(one.id).path).toBe(defaultPath(one));
    expect(rows.get(one.id).path).toMatch(/^ai-filters\/crafts\/tron-7-0\//);

    const file = await clientA.getJsonFile(rows.get(two.id).path);
    expect(file.json.messages[0].content.at(-1).text).toBe("Is the dynamic notch needed?");
    expect(file.json.cloud).toBeUndefined();
    expect(file.json.rev).toBeUndefined();

    // Nothing changed: no further commits.
    expect((await a.sync()).uploaded).toBe(false);
  });

  it("keeps out of the tuning logs' index", async () => {
    a.add("TRON 7.0", "hi");
    await a.sync();
    expect(INDEX_PATH).not.toBe("index.json");
    expect(await clientA.getJsonFile("index.json")).toBeNull();
  });

  it("brings another computer the open heli's conversations, and only that heli's", async () => {
    const tron = a.add("TRON 7.0", "tron question");
    a.add("Goblin 700", "goblin question");
    await a.sync();

    await b.sync("tron 7.0");
    expect([...b.records.keys()]).toEqual([tron.id]);
    expect(isDirty(b.records.get(tron.id))).toBe(false);
  });

  it("passes later messages along to the other computer", async () => {
    const c = a.add("TRON 7.0", "first");
    await a.sync();
    await b.sync("TRON 7.0");

    a.edit(c.id, "second");
    await a.sync();
    await b.sync("TRON 7.0");
    expect(b.records.get(c.id).messages).toHaveLength(2);
  });

  it("keeps both versions when a conversation changed on both computers", async () => {
    const c = a.add("TRON 7.0", "first");
    await a.sync();
    await b.sync("TRON 7.0");

    a.edit(c.id, "from A");
    await a.sync();
    b.edit(c.id, "from B");
    const result = await b.sync("TRON 7.0");

    expect(result.conflicts).toHaveLength(1);
    const { copyId } = result.conflicts[0];
    expect(b.records.get(c.id).messages.at(-1).content.at(-1).text).toBe("from A");
    expect(b.records.get(copyId).messages.at(-1).content.at(-1).text).toBe("from B");
    expect(b.records.get(copyId).title).toMatch(/\(this computer\)$/);

    const rows = indexRows(await fetchIndex(clientA));
    expect(rows.has(copyId)).toBe(true);
  });

  it("deletes from the cloud, and then from other computers", async () => {
    const c = a.add("TRON 7.0", "first");
    await a.sync();
    await b.sync("TRON 7.0");

    a.remove(c.id);
    await a.sync();
    expect(a.records.size).toBe(0);
    expect(indexRows(await fetchIndex(clientA)).size).toBe(0);
    expect(await clientA.getJsonFile(defaultPath(c))).toBeNull();

    await b.sync("TRON 7.0");
    expect(b.records.size).toBe(0);
  });

  it("re-uploads a conversation deleted elsewhere if it was changed here meanwhile", async () => {
    const c = a.add("TRON 7.0", "first");
    await a.sync();
    await b.sync("TRON 7.0");

    a.remove(c.id);
    await a.sync();
    b.edit(c.id, "still using this");
    await b.sync("TRON 7.0");

    expect(b.records.has(c.id)).toBe(true);
    expect(indexRows(await fetchIndex(clientA)).has(c.id)).toBe(true);
  });

  it("retries when the other computer commits in between", async () => {
    a.add("TRON 7.0", "from A");
    b.add("TRON 7.0", "from B");
    await Promise.all([a.sync(), b.sync()]);
    expect(indexRows(await fetchIndex(clientA)).size).toBe(2);
  });
});

describe("AI Filters store with GitHub", () => {
  it("uploads saved conversations, shows them on another computer, and deletes everywhere", async () => {
    const { createPinia, setActivePinia } = await import("pinia");
    const { useSettingsStore } = await import("../../stores/settings.js");
    const { useImagineStore } = await import("../imagine_store.js");
    const { useAiFiltersStore, setConversationDb, setAiFiltersCloudForTests } = await import("./ai_filters_store.js");
    const { createConversationDb, AI_FILTERS_SCHEMA } = await import("./conversation_db.js");
    const { createMemoryBackend } = await import("../../tuning_log_db.js");

    const fake = createFakeGitHub();
    setAiFiltersCloudForTests({
      clientFactory: (o) => createGitHubClient({ ...o, fetch: fake.fetch }),
      syncDelayMs: null,
    });

    async function openComputer() {
      setActivePinia(createPinia());
      setConversationDb(createConversationDb(createMemoryBackend(AI_FILTERS_SCHEMA)));
      Object.assign(useSettingsStore().userSettings, { githubRepo: "me/tuning", githubToken: "t", githubBranch: "" });
      const imagine = useImagineStore();
      imagine.sysConfig = { "Craft name": "TRON 7.0" };
      imagine.data = { count: 0 }; // just enough for hasLog
      return useAiFiltersStore();
    }

    const a = await openComputer();
    a.newConversation();
    appendUserMessage(a.current, "Which notch can go?");
    await a.renameConversation("Notch clean-up");
    expect(a.syncStatus).toBe("pending");
    await a.syncNow();
    expect(a.syncStatus).toBe("synced");
    const id = a.current.id;

    const b = await openComputer();
    await b.loadForCraft();
    expect(b.conversations.map((c) => c.title)).toEqual(["Notch clean-up"]);
    expect(b.current.id).toBe(id);
    expect(b.syncStatus).toBe("synced");

    await b.deleteConversation(id);
    expect(b.conversations).toEqual([]);
    expect(b.pendingCount).toBe(1);
    await b.syncNow();
    expect(b.pendingCount).toBe(0);
    expect(indexRows(await fetchIndex(createGitHubClient({ repo: "me/tuning", fetch: fake.fetch }))).size).toBe(0);
  });
});
