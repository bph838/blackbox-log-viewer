import { describe, it, expect, beforeEach } from "vitest";
import { createGitHubClient, parseRepo, utf8ToBase64, base64ToUtf8, GitHubError } from "./github_client.js";
import { createFakeGitHub } from "./testing/fake_github.js";

describe("parseRepo", () => {
  it("accepts owner/repo and common URL forms", () => {
    const expected = { owner: "bph838", repo: "heli-tuning" };
    expect(parseRepo("bph838/heli-tuning")).toEqual(expected);
    expect(parseRepo(" https://github.com/bph838/heli-tuning ")).toEqual(expected);
    expect(parseRepo("https://github.com/bph838/heli-tuning.git")).toEqual(expected);
    expect(parseRepo("git@github.com:bph838/heli-tuning.git")).toEqual(expected);
    expect(parseRepo("github.com/bph838/heli-tuning/")).toEqual(expected);
  });

  it("rejects anything else", () => {
    expect(parseRepo("")).toBeNull();
    expect(parseRepo("just-a-name")).toBeNull();
    expect(parseRepo("a/b/c")).toBeNull();
  });
});

describe("utf8 <-> base64", () => {
  it("round-trips non-ASCII text", () => {
    const text = "Tron 7.0 “notes” – 1500rpm ✓";
    expect(base64ToUtf8(utf8ToBase64(text))).toBe(text);
  });
});

describe("createGitHubClient", () => {
  let fake;
  let client;

  beforeEach(() => {
    fake = createFakeGitHub();
    client = createGitHubClient({ repo: "me/tuning", token: "t", fetch: fake.fetch });
  });

  it("throws for an unusable repo name", () => {
    expect(() => createGitHubClient({ repo: "nope", fetch: fake.fetch })).toThrow(GitHubError);
  });

  describe("testConnection", () => {
    it("reports a writable repo and its default branch", async () => {
      const result = await client.testConnection();
      expect(result).toMatchObject({ ok: true, canWrite: true, isPrivate: true, branch: "main" });
    });

    it("reports a read-only token even though the repo says the user can push", async () => {
      const readOnly = createFakeGitHub({ canWrite: false, userCanWrite: true });
      readOnly.commitElsewhere({ "README.md": "hi" });
      client = createGitHubClient({ repo: "me/tuning", fetch: readOnly.fetch });
      const result = await client.testConnection();
      expect(result.ok).toBe(false);
      expect(result.message).toContain("can't write");
      expect(result.message).toContain("Read and write");
    });

    it("reports a read-only token on an empty repo", async () => {
      const readOnly = createFakeGitHub({ canWrite: false, userCanWrite: true });
      client = createGitHubClient({ repo: "me/tuning", fetch: readOnly.fetch });
      const result = await client.testConnection();
      expect(result.ok).toBe(false);
      expect(result.message).toContain("can't write");
    });

    it("proves write access on an empty repo by creating its README", async () => {
      const result = await client.testConnection();
      expect(result.ok).toBe(true);
      expect(Object.keys(fake.files())).toEqual(["README.md"]);
    });

    it("explains a permission error from a sync", async () => {
      const readOnly = createFakeGitHub({ canWrite: false });
      readOnly.commitElsewhere({ "README.md": "hi" });
      client = createGitHubClient({ repo: "me/tuning", fetch: readOnly.fetch });
      const error = await client.commitFiles({ files: [{ path: "a.txt", text: "a" }] }).catch((e) => e);
      expect(error.isPermission).toBe(true);
      expect(error.message).toContain('"Contents" to "Read and write"');
    });

    it("reports a missing repo", async () => {
      client = createGitHubClient({ repo: "me/other", fetch: fake.fetch });
      const result = await client.testConnection();
      expect(result.ok).toBe(false);
      expect(result.message).toContain("wasn't found");
    });

    it("reports being offline", async () => {
      fake.setOnline(false);
      const result = await client.testConnection();
      expect(result.ok).toBe(false);
      expect(result.message).toContain("Could not reach GitHub");
    });
  });

  it("resolves null for files in an empty repo", async () => {
    expect(await client.getJsonFile("index.json")).toBeNull();
  });

  it("initialises an empty repo and commits several files at once", async () => {
    await client.commitFiles({
      files: [
        { path: "index.json", text: JSON.stringify({ formatVersion: 1 }) },
        { path: "crafts/tron/L1/images/e1.png", base64: "iVBORw0K" },
      ],
      message: "Save",
    });

    const files = fake.files();
    expect(Object.keys(files).sort()).toEqual(["README.md", "crafts/tron/L1/images/e1.png", "index.json"]);
    expect(fake.fileBase64("crafts/tron/L1/images/e1.png")).toBe("iVBORw0K");
    // README (initialisation) + the one commit holding both files.
    expect(fake.commitCount()).toBe(2);

    const index = await client.getJsonFile("index.json");
    expect(index.json).toEqual({ formatVersion: 1 });
    expect(typeof index.sha).toBe("string");
  });

  it("test connection initialises an empty repo when a fine-grained token gets 403s", async () => {
    const fineGrained = createFakeGitHub({ emptyRepoGitStatus: 403 });
    client = createGitHubClient({ repo: "me/tuning", token: "t", fetch: fineGrained.fetch });

    const result = await client.testConnection();
    expect(result.ok).toBe(true);
    expect(Object.keys(fineGrained.files())).toEqual(["README.md"]);
  });

  it("initialises an empty repo when a fine-grained token gets 403 instead of 409", async () => {
    const fineGrained = createFakeGitHub({ emptyRepoGitStatus: 403 });
    client = createGitHubClient({ repo: "me/tuning", token: "t", fetch: fineGrained.fetch });

    await client.commitFiles({ files: [{ path: "index.json", text: "{}" }] });
    expect(Object.keys(fineGrained.files()).sort()).toEqual(["README.md", "index.json"]);
  });

  it("deletes files, ignoring ones that don't exist", async () => {
    fake.commitElsewhere({ "a.txt": "a", "b.txt": "b" });
    await client.commitFiles({ files: [{ path: "c.txt", text: "c" }], deletes: ["a.txt", "missing.txt"] });
    expect(Object.keys(fake.files()).sort()).toEqual(["b.txt", "c.txt"]);
  });

  it("answers an unchanged file from its ETag cache with a conditional request", async () => {
    fake.commitElsewhere({ "index.json": '{"v":1}' });

    await client.getJsonFile("index.json");
    const again = await client.getJsonFile("index.json");
    expect(again.json).toEqual({ v: 1 });

    fake.commitElsewhere({ "index.json": '{"v":2}' });
    expect((await client.getJsonFile("index.json")).json).toEqual({ v: 2 });
  });

  it("reads files too big for the contents API through the blob API", async () => {
    const big = "x".repeat(1024 * 1024 + 10);
    fake.commitElsewhere({ "big.txt": big });
    expect((await client.getTextFile("big.txt")).text).toBe(big);
  });

  it("refuses to move the branch past a commit made elsewhere in the meantime", async () => {
    fake.commitElsewhere({ "index.json": "{}" });

    // Let the client read the head, then have "another computer" commit before it updates the ref.
    const originalFetch = fake.fetch;
    let interfered = false;
    const racingClient = createGitHubClient({
      repo: "me/tuning",
      fetch: async (url, init) => {
        if (!interfered && init && init.method === "POST" && url.endsWith("/git/commits")) {
          interfered = true;
          fake.commitElsewhere({ "other.txt": "from elsewhere" });
        }
        return originalFetch(url, init);
      },
    });

    const error = await racingClient.commitFiles({ files: [{ path: "mine.txt", text: "mine" }] }).catch((e) => e);
    expect(error).toBeInstanceOf(GitHubError);
    expect(error.isConflict).toBe(true);
    expect(fake.files()["mine.txt"]).toBeUndefined();
    expect(fake.files()["other.txt"]).toBe("from elsewhere");
  });

  it("flags auth and network failures", async () => {
    const unauthorised = createGitHubClient({
      repo: "me/tuning",
      fetch: async () => ({ status: 401, ok: false, statusText: "Unauthorized", headers: { get: () => null }, text: async () => '{"message":"Bad credentials"}' }),
    });
    const authError = await unauthorised.getJsonFile("index.json").catch((e) => e);
    expect(authError.isAuth).toBe(true);

    fake.setOnline(false);
    const networkError = await client.getJsonFile("index.json").catch((e) => e);
    expect(networkError.isNetwork).toBe(true);
  });
});

describe("a token that can't read branches or build commits (fine-grained quirk)", () => {
  let fake;
  let client;

  beforeEach(() => {
    fake = createFakeGitHub({ branchReadsForbidden: true, gitWritesForbidden: true });
    fake.commitElsewhere({ "README.md": "hi" });
    client = createGitHubClient({ repo: "me/tuning", token: "t", fetch: fake.fetch });
  });

  it("still passes the connection test, saying how it will save", async () => {
    const result = await client.testConnection();
    expect(result.ok).toBe(true);
    expect(result.message).toContain("one file at a time");
  });

  it("saves, updates and deletes files one at a time", async () => {
    await client.commitFiles({
      files: [
        { path: "img.png", base64: "iVBORw0K" },
        { path: "index.json", text: '{"v":1}' },
      ],
    });
    expect(fake.files()["index.json"]).toBe('{"v":1}');
    expect(fake.fileBase64("img.png")).toBe("iVBORw0K");

    const result = await client.commitFiles({ files: [{ path: "index.json", text: '{"v":2}' }], deletes: ["img.png"] });
    expect(fake.files()["index.json"]).toBe('{"v":2}');
    expect(fake.fileBase64("img.png")).toBeUndefined();
    expect(typeof result.shas["index.json"]).toBe("string");
  });

  it("reports a file changed elsewhere mid-save as a conflict", async () => {
    fake.commitElsewhere({ "index.json": '{"v":1}' });

    let interfered = false;
    const racingClient = createGitHubClient({
      repo: "me/tuning",
      fetch: async (url, init) => {
        if (!interfered && init && init.method === "PUT") {
          interfered = true;
          fake.commitElsewhere({ "index.json": '{"v":"elsewhere"}' });
        }
        return fake.fetch(url, init);
      },
    });

    const error = await racingClient.commitFiles({ files: [{ path: "index.json", text: '{"v":2}' }] }).catch((e) => e);
    expect(error.isConflict).toBe(true);
    expect(fake.files()["index.json"]).toBe('{"v":"elsewhere"}');
  });

  it("works on an empty repo too", async () => {
    const empty = createFakeGitHub({ branchReadsForbidden: true, gitWritesForbidden: true, emptyRepoGitStatus: 403 });
    client = createGitHubClient({ repo: "me/tuning", token: "t", fetch: empty.fetch });

    expect((await client.testConnection()).ok).toBe(true);
    await client.commitFiles({ files: [{ path: "index.json", text: "{}" }] });
    expect(empty.files()["index.json"]).toBe("{}");
  });
});
