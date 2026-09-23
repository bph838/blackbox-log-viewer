// A minimal GitHub client for keeping Tuning Logs in a repo of the user's choosing (Settings ->
// Cloud Storage), talking to the REST API directly from the browser with the user's own
// fine-grained personal access token - stored locally, never sent anywhere but api.github.com.
//
// Reads are single files by path (never a clone/download of the repo), with ETag caching so
// re-checking an unchanged file is a cheap "304 Not Modified" that doesn't count against the rate
// limit. Writes go through the Git Data API so any number of files - new images, a log, the index -
// land together in one commit, and the branch only moves forward if nobody else committed in the
// meantime (otherwise a GitHubError with isConflict is thrown, and the caller re-reads, merges and
// tries again).

const API = "https://api.github.com";

export const PERMISSION_HELP =
  'Edit the token on GitHub (Settings -> Developer settings -> Fine-grained tokens), make sure this ' +
  'repository is selected under "Repository access", and set "Contents" to "Read and write".';

export class GitHubError extends Error {
  constructor(message, { status = 0, network = false, conflict = false, permission = false } = {}) {
    super(message);
    this.name = "GitHubError";
    this.status = status;
    this.isNetwork = network;
    // 403 is also used for rate limiting, so only 401 reliably means a bad token.
    this.isAuth = status === 401;
    // The token is valid but isn't allowed to do this (e.g. Contents is read-only).
    this.isPermission = permission;
    this.isNotFound = status === 404;
    // The branch moved on since we read it (commitFiles' non-fast-forward ref update was refused).
    this.isConflict = conflict;
  }
}

/**
 * Accepts "owner/repo", "https://github.com/owner/repo", "git@github.com:owner/repo.git", etc.
 * Returns { owner, repo } or null if it doesn't look like a repo.
 */
export function parseRepo(text) {
  const cleaned = String(text || "")
    .trim()
    .replace(/^(https?:\/\/)?(www\.)?github\.com[/:]/i, "")
    .replace(/^git@github\.com:/i, "")
    .replace(/\.git$/i, "")
    .replace(/\/+$/, "");

  const match = /^([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)$/.exec(cleaned);
  return match ? { owner: match[1], repo: match[2] } : null;
}

export function utf8ToBase64(text) {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export function base64ToUtf8(base64) {
  const binary = atob(String(base64 || "").replace(/\s/g, ""));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new TextDecoder().decode(bytes);
}

function encodePath(path) {
  return path.split("/").map(encodeURIComponent).join("/");
}

/**
 * options: { repo: "owner/repo" (any form parseRepo accepts), branch (blank = the repo's default
 * branch), token, fetch (for tests) }
 */
export function createGitHubClient(options) {
  const parsed = parseRepo(options.repo);
  if (!parsed) {
    throw new GitHubError(`"${options.repo || ""}" isn't a GitHub repository - use the form owner/repo.`);
  }

  const { owner, repo } = parsed;
  const fetchImpl = options.fetch || globalThis.fetch.bind(globalThis);
  const token = (options.token || "").trim();
  let branch = (options.branch || "").trim() || null;

  // path -> { etag, value } for conditional GETs.
  const etagCache = new Map();

  async function request(method, path, { body, etagKey } = {}) {
    const headers = {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (body !== undefined) headers["Content-Type"] = "application/json";

    const cached = etagKey && etagCache.get(etagKey);
    if (cached) headers["If-None-Match"] = cached.etag;

    let response;
    try {
      response = await fetchImpl(`${API}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        // ETags are handled here, so the browser's own HTTP cache must not answer for GitHub.
        cache: "no-store",
      });
    } catch (error) {
      throw new GitHubError(`Could not reach GitHub (${error.message || "network error"}).`, { network: true });
    }

    if (response.status === 304 && cached) {
      return { status: 304, data: cached.value, cached: true };
    }

    let data = null;
    const text = await response.text();
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }
    }

    if (!response.ok) {
      const detail = (data && data.message) || response.statusText || "request failed";
      if (response.status === 403 && /not accessible by (personal access|integration)/i.test(detail)) {
        throw new GitHubError(
          `GitHub: the access token isn't allowed to ${method === "GET" ? "read" : "write to"} ${owner}/${repo} ` +
            `(${method} ${path.replace(/\?.*$/, "").replace(/^\/repos\/[^/]+\/[^/]+/, "") || "/"}). ${PERMISSION_HELP}`,
          {
            status: 403,
            permission: true,
          },
        );
      }
      throw new GitHubError(`GitHub: ${detail} (${response.status}, ${method} ${owner}/${repo})`, {
        status: response.status,
      });
    }

    const etag = response.headers.get("ETag");
    if (etagKey && etag) {
      etagCache.set(etagKey, { etag, value: data });
    }

    return { status: response.status, data, cached: false };
  }

  const repoPath = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;

  async function getRepoInfo() {
    const { data } = await request("GET", repoPath, { etagKey: "repo" });
    return data;
  }

  async function resolveBranch() {
    if (!branch) {
      branch = (await getRepoInfo()).default_branch || "main";
    }
    return branch;
  }

  /**
   * Checks the repo exists and that the token can really read and write it. (The repo's own
   * `permissions` field reflects the *user's* access, not a fine-grained token's, so writing is
   * tested by doing one: creating an unreferenced blob, which GitHub discards - or, in a repo with
   * no commits yet, creating the README the first sync would otherwise create.)
   * Resolves { ok, message, canWrite, isPrivate, branch }.
   */
  async function testConnection() {
    let info;
    try {
      info = await getRepoInfo();
    } catch (error) {
      if (error.isNotFound) {
        return {
          ok: false,
          message: `Repository ${owner}/${repo} wasn't found - check the name, and that the token has access to it.`,
        };
      }
      if (error.isAuth) {
        return { ok: false, message: "GitHub rejected the token - it may be wrong or expired." };
      }
      return { ok: false, message: error.message };
    }

    const useBranch = branch || info.default_branch || "main";
    const result = { ok: false, canWrite: false, isPrivate: !!info.private, branch: useBranch };

    try {
      await getFileBase64("index.json");
    } catch (error) {
      if (error.isNetwork) return { ...result, message: error.message };
      return { ...result, message: `Connected to ${info.full_name}, but the token can't read its files. ${PERMISSION_HELP}` };
    }

    try {
      await request("POST", `${repoPath}/git/blobs`, { body: { content: "", encoding: "utf-8" } });
    } catch (error) {
      if (error.status === 409) {
        // Empty repo - the Git Data API needs a first commit.
        try {
          await initialiseBranch(useBranch);
        } catch (initError) {
          return writeFailure(result, info, initError);
        }
      } else {
        return writeFailure(result, info, error);
      }
    }

    // Look up the branch exactly as a save does (creating it with a first commit in an empty repo),
    // so this can't pass while saving would fail.
    let note = "";
    try {
      const head = (await getHead(useBranch)) || (await initialiseBranch(useBranch));
      if (!head) {
        return { ...result, message: `Connected to ${info.full_name}, but couldn't find or create branch "${useBranch}".` };
      }
    } catch (error) {
      if (!error.isPermission) {
        return {
          ...result,
          message: `Connected to ${info.full_name}, but couldn't use branch "${useBranch}": ${error.message}`,
        };
      }
      // It can read and write files but not branch details: saves go one file at a time instead.
      note = " (saving one file at a time - this token can't read branch details)";
    }

    return {
      ...result,
      ok: true,
      canWrite: true,
      message: `Connected to ${info.full_name} (${info.private ? "private" : "public"}, branch ${useBranch}) - can read and write${note}.`,
    };
  }

  function writeFailure(result, info, error) {
    if (error.isPermission || error.status === 403 || error.status === 404) {
      return { ...result, message: `Connected to ${info.full_name}, but the token can't write to it. ${PERMISSION_HELP}` };
    }
    return { ...result, message: error.message };
  }

  async function getBlobBase64(sha) {
    // Blobs never change for a given sha, and images are cached locally - no ETag cache needed.
    const { data } = await request("GET", `${repoPath}/git/blobs/${sha}`);
    return String(data.content || "").replace(/\s/g, "");
  }

  /**
   * Reads one file. Resolves { sha, base64 } or null if it doesn't exist (including when the
   * repo or branch is still empty). Unchanged files are served from the ETag cache.
   */
  async function getFileBase64(path) {
    const ref = await resolveBranch();

    let result;
    try {
      result = await request("GET", `${repoPath}/contents/${encodePath(path)}?ref=${encodeURIComponent(ref)}`, {
        etagKey: `contents:${ref}:${path}`,
      });
    } catch (error) {
      // 404: no such file/branch. 409: the repo has no commits at all yet.
      if (error.isNotFound || error.status === 409) return null;
      throw error;
    }

    const data = result.data;
    if (Array.isArray(data) || data.type !== "file") {
      throw new GitHubError(`GitHub: ${path} isn't a file.`);
    }

    // The contents API only inlines files up to 1 MB - fetch bigger ones as a blob by sha.
    const base64 = data.encoding === "base64" && data.content ? data.content.replace(/\s/g, "") : await getBlobBase64(data.sha);

    return { sha: data.sha, base64 };
  }

  /**
   * Reads a UTF-8 text file. Resolves { sha, text } or null if it doesn't exist.
   */
  async function getTextFile(path) {
    const file = await getFileBase64(path);
    return file ? { sha: file.sha, text: base64ToUtf8(file.base64) } : null;
  }

  /**
   * Reads and parses a JSON file. Resolves { sha, json } or null if it doesn't exist.
   */
  async function getJsonFile(path) {
    const file = await getTextFile(path);
    if (!file) return null;

    try {
      return { sha: file.sha, json: JSON.parse(file.text) };
    } catch {
      throw new GitHubError(`GitHub: ${path} isn't valid JSON.`);
    }
  }

  /**
   * The branch's latest commit and its tree: { sha, treeSha }, or null if the branch doesn't exist
   * yet (e.g. the repo has no commits). Some fine-grained tokens are refused (403) by one or more
   * of GitHub's ways of reading a branch even with "Contents: Read and write", so each is tried in
   * turn; if every one is refused, throws a GitHubError with isPermission (commitFiles then saves
   * through the contents API instead, which doesn't need to know the head).
   */
  async function getHead(ref) {
    const lookups = [
      [
        "commits",
        async () => {
          const { data } = await request("GET", `${repoPath}/commits/${encodePath(ref)}`);
          return { sha: data.sha, treeSha: data.commit.tree.sha };
        },
      ],
      [
        "branches",
        async () => {
          const { data } = await request("GET", `${repoPath}/branches/${encodePath(ref)}`);
          return { sha: data.commit.sha, treeSha: data.commit.commit.tree.sha };
        },
      ],
      [
        "git/ref",
        async () => {
          const { data } = await request("GET", `${repoPath}/git/ref/heads/${encodePath(ref)}`);
          const { data: commit } = await request("GET", `${repoPath}/git/commits/${data.object.sha}`);
          return { sha: data.object.sha, treeSha: commit.tree.sha };
        },
      ],
    ];

    const refusedBy = [];
    for (const [name, lookup] of lookups) {
      try {
        return await lookup();
      } catch (error) {
        // 404: no such branch. 409: the repo has no commits. 422: no commit for that ref.
        if (error.isNotFound || error.status === 409 || error.status === 422) return null;
        if (!error.isPermission) throw error;
        refusedBy.push(name);
      }
    }

    if (await isRepoEmpty()) return null;

    throw new GitHubError(
      `GitHub: the access token can't read branch "${ref}" of ${owner}/${repo} (refused by: ${refusedBy.join(", ")}).`,
      { status: 403, permission: true },
    );
  }

  /**
   * Whether the repo has no commits yet - the contents API says "This repository is empty" (404)
   * for one. (The repo's `size` isn't reliable for this: it stays 0 for a while after a commit.)
   */
  async function isRepoEmpty() {
    try {
      await request("GET", `${repoPath}/contents/`);
      return false;
    } catch (error) {
      return error.isNotFound || error.status === 409;
    }
  }

  /**
   * Makes the first commit in a repo/branch that has none, so the Git Data API (which can't
   * write to an empty repo) has something to build on. Resolves the new head (see getHead).
   */
  async function initialiseBranch(ref) {
    try {
      await request("PUT", `${repoPath}/contents/README.md`, {
        body: {
          message: "Create tuning log storage",
          content: utf8ToBase64(
            "# Rotorflight tuning logs\n\nTuning logs saved by Rotorflight Blackbox Explorer. " +
              "Edit with care - the app keeps index.json in step with the logs under crafts/.\n",
          ),
          branch: ref,
        },
      });
    } catch (error) {
      // 422 "sha wasn't supplied": README.md is already there, so the branch exists after all.
      if (error.status !== 422) throw error;
    }
    return getHead(ref);
  }

  /**
   * Writes several files in a single commit on top of the current branch head, through the Git
   * Data API. Throws a GitHubError with isConflict if the branch moved on meanwhile.
   */
  async function commitFilesAtomically({ files, deletes, message }) {
    const ref = await resolveBranch();

    let head = await getHead(ref);
    if (!head) {
      head = await initialiseBranch(ref);
      if (!head) {
        throw new GitHubError(`GitHub: couldn't create branch "${ref}" in ${owner}/${repo}.`);
      }
    }
    const headSha = head.sha;

    const shas = {};
    const tree = [];

    for (const file of files) {
      const content = file.base64 !== undefined ? file.base64 : utf8ToBase64(file.text);
      const { data: blob } = await request("POST", `${repoPath}/git/blobs`, {
        body: { content, encoding: "base64" },
      });
      shas[file.path] = blob.sha;
      tree.push({ path: file.path, mode: "100644", type: "blob", sha: blob.sha });
    }

    for (const path of deletes) {
      if (!(await getFileBase64(path).catch(() => null))) continue;
      tree.push({ path, mode: "100644", type: "blob", sha: null });
    }

    if (!tree.length) {
      return { commitSha: headSha, shas };
    }

    const { data: newTree } = await request("POST", `${repoPath}/git/trees`, {
      body: { base_tree: head.treeSha, tree },
    });

    const { data: commit } = await request("POST", `${repoPath}/git/commits`, {
      body: { message: message || "Update tuning logs", tree: newTree.sha, parents: [headSha] },
    });

    try {
      await request("PATCH", `${repoPath}/git/refs/heads/${encodePath(ref)}`, {
        body: { sha: commit.sha, force: false },
      });
    } catch (error) {
      if (error.status === 409 || error.status === 422) {
        throw conflictError(error);
      }
      throw error;
    }

    return { commitSha: commit.sha, shas };
  }

  function conflictError(error) {
    return new GitHubError("GitHub: the tuning logs were changed elsewhere while saving.", {
      status: error.status,
      conflict: true,
    });
  }

  /**
   * The fallback for tokens the Git Data API refuses: writes each file with the contents API
   * (one commit per file). Files are written in the order given, so callers put the files that
   * point at others (log.json, then index.json) last. A file changed elsewhere since it was read
   * here makes GitHub refuse the write (409), reported as a conflict like the atomic path.
   */
  async function commitFilesOneByOne({ files, deletes, message }) {
    const ref = await resolveBranch();
    const shas = {};
    const commitMessage = message || "Update tuning logs";

    for (const file of files) {
      const content = file.base64 !== undefined ? file.base64 : utf8ToBase64(file.text);
      const existing = await getFileBase64(file.path);
      if (existing && existing.base64 === content) {
        shas[file.path] = existing.sha;
        continue;
      }

      try {
        const { data } = await request("PUT", `${repoPath}/contents/${encodePath(file.path)}`, {
          body: { message: commitMessage, content, branch: ref, ...(existing ? { sha: existing.sha } : {}) },
        });
        shas[file.path] = data.content.sha;
      } catch (error) {
        if (error.status === 409 || (error.status === 422 && /sha/i.test(error.message))) {
          throw conflictError(error);
        }
        throw error;
      }
    }

    for (const path of deletes) {
      const existing = await getFileBase64(path).catch(() => null);
      if (!existing) continue;
      await request("DELETE", `${repoPath}/contents/${encodePath(path)}`, {
        body: { message: commitMessage, sha: existing.sha, branch: ref },
      });
    }

    return { commitSha: null, shas };
  }

  // Set once the Git Data API refuses this token, so later saves go straight to the fallback.
  let saveOneByOne = false;

  /**
   * Writes several files - in a single commit when the token allows it, otherwise one at a time.
   *   files:   [{ path, text }] or [{ path, base64 }]
   *   deletes: [path] - paths to remove (ignored if they don't exist)
   * Resolves { commitSha, shas: { path: blobSha } }. Throws a GitHubError with isConflict if the
   * files were changed elsewhere while this was being prepared - re-read, merge and try again.
   */
  async function commitFiles({ files = [], deletes = [], message }) {
    const options = { files, deletes, message };
    if (saveOneByOne) return commitFilesOneByOne(options);

    try {
      return await commitFilesAtomically(options);
    } catch (error) {
      if (!error.isPermission) throw error;
      saveOneByOne = true;
      return commitFilesOneByOne(options);
    }
  }

  return {
    owner,
    repo,
    get branch() {
      return branch;
    },
    testConnection,
    getFileBase64,
    getTextFile,
    getJsonFile,
    commitFiles,
  };
}
