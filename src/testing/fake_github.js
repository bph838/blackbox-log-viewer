// An in-memory stand-in for the parts of the GitHub REST API github_client.js uses, for tests:
// pass `fake.fetch` as createGitHubClient's `fetch` option. Models a single repo with real
// commit/tree/blob/ref semantics - including refusing a non-fast-forward ref update, ETag/304
// handling, a 1 MB inline limit on the contents API, and 409 for an empty repo.

import { utf8ToBase64, base64ToUtf8 } from "../github_client.js";

const INLINE_LIMIT = 1024 * 1024;

// canWrite: whether the token can write. userCanWrite: what the repo's `permissions` field says -
// for a fine-grained token that's the *user's* access, so it can say "push" when the token can't.
export function createFakeGitHub({
  owner = "me",
  repo = "tuning",
  defaultBranch = "main",
  canWrite = true,
  userCanWrite = true,
  isPrivate = true,
  // What the Git Data API answers for an empty repo: 409 for classic tokens, but a fine-grained
  // token gets 403 "Resource not accessible by personal access token".
  emptyRepoGitStatus = 409,
  // As seen with a real fine-grained token: every way of reading a branch's head answers 403...
  branchReadsForbidden = false,
  // ...and so does building a commit through the Git Data API (blobs are still allowed).
  gitWritesForbidden = false,
} = {}) {
  let counter = 0;
  const nextSha = () => (++counter).toString(16).padStart(40, "0");

  const blobs = new Map(); // sha -> base64
  const trees = new Map(); // sha -> Map(path -> blobSha)
  const commits = new Map(); // sha -> { tree, parents, message }
  const refs = new Map(); // branch -> commitSha
  const requests = [];
  let online = true;

  function response(status, data, headers = {}) {
    const text = data === undefined ? "" : JSON.stringify(data);
    return {
      status,
      ok: status >= 200 && status < 300,
      statusText: String(status),
      headers: { get: (name) => headers[name] || headers[name.toLowerCase()] || null },
      text: async () => text,
    };
  }

  function treeOf(branch) {
    const head = refs.get(branch);
    return head ? trees.get(commits.get(head).tree) : null;
  }

  function writeCommit(branch, changes, message) {
    const base = treeOf(branch);
    const tree = new Map(base || []);
    for (const [path, base64] of Object.entries(changes)) {
      if (base64 === null) {
        tree.delete(path);
      } else {
        const blobSha = nextSha();
        blobs.set(blobSha, base64);
        tree.set(path, blobSha);
      }
    }
    const treeSha = nextSha();
    trees.set(treeSha, tree);
    const commitSha = nextSha();
    commits.set(commitSha, { tree: treeSha, parents: refs.has(branch) ? [refs.get(branch)] : [], message });
    refs.set(branch, commitSha);
    return commitSha;
  }

  async function fetch(url, init = {}) {
    const method = init.method || "GET";
    const headers = init.headers || {};
    const body = init.body ? JSON.parse(init.body) : undefined;
    const parsed = new URL(url);
    const path = decodeURIComponent(parsed.pathname);
    requests.push({ method, path, query: parsed.search });

    if (!online) throw new TypeError("Failed to fetch");

    const prefix = `/repos/${owner}/${repo}`;
    if (!path.startsWith(prefix)) return response(404, { message: "Not Found" });
    const rest = path.slice(prefix.length);

    if (rest === "" && method === "GET") {
      return response(200, {
        full_name: `${owner}/${repo}`,
        private: isPrivate,
        default_branch: defaultBranch,
        size: refs.size ? 1 : 0,
        permissions: { pull: true, push: userCanWrite, admin: false },
      });
    }

    let m;

    if ((rest === "/contents" || rest === "/contents/") && method === "GET") {
      if (!refs.size && emptyRepoGitStatus === 403) {
        return response(403, { message: "Resource not accessible by personal access token" });
      }
      return refs.size ? response(200, []) : response(404, { message: "This repository is empty." });
    }

    const forbidden = () => response(403, { message: "Resource not accessible by personal access token" });

    if (
      branchReadsForbidden &&
      method === "GET" &&
      (/^\/branches\//.test(rest) || /^\/git\/ref\//.test(rest) || /^\/commits\//.test(rest))
    ) {
      return forbidden();
    }

    if (
      gitWritesForbidden &&
      ((method === "POST" && (rest === "/git/trees" || rest === "/git/commits")) ||
        (method === "PATCH" && rest.startsWith("/git/refs/")))
    ) {
      return forbidden();
    }

    if ((m = /^\/commits\/(.+)$/.exec(rest)) && method === "GET") {
      if (!refs.size) return response(409, { message: "Git Repository is empty." });
      const sha = refs.get(m[1]);
      if (!sha) return response(422, { message: `No commit found for SHA: ${m[1]}` });
      return response(200, { sha, commit: { tree: { sha: commits.get(sha).tree } } });
    }

    if ((m = /^\/contents\/(.+)$/.exec(rest))) {
      const filePath = m[1];
      const branch = parsed.searchParams.get("ref") || (body && body.branch) || defaultBranch;

      if (method === "GET") {
        if (!refs.size) return response(409, { message: "Git Repository is empty." });
        const tree = treeOf(branch);
        if (!tree) return response(404, { message: "No commit found for the ref" });
        const blobSha = tree.get(filePath);
        if (!blobSha) return response(404, { message: "Not Found" });

        const etag = `"${blobSha}"`;
        if (headers["If-None-Match"] === etag) return response(304);

        const base64 = blobs.get(blobSha);
        const tooBig = base64.length * 0.75 > INLINE_LIMIT;
        return response(
          200,
          { type: "file", path: filePath, sha: blobSha, encoding: tooBig ? "none" : "base64", content: tooBig ? "" : base64 },
          { ETag: etag },
        );
      }

      if (method === "PUT" || method === "DELETE") {
        if (!canWrite) return forbidden();
        const tree = treeOf(branch);
        const existingSha = tree && tree.get(filePath);

        if (method === "DELETE") {
          if (!existingSha) return response(404, { message: "Not Found" });
          if (body.sha !== existingSha) return response(409, { message: `${filePath} does not match ${body.sha}` });
          writeCommit(branch, { [filePath]: null }, body.message);
          return response(200, { commit: {} });
        }

        if (existingSha && !body.sha) return response(422, { message: 'Invalid request.\n\n"sha" wasn\'t supplied.' });
        if (existingSha && body.sha !== existingSha) {
          return response(409, { message: `${filePath} does not match ${body.sha}` });
        }
        writeCommit(branch, { [filePath]: body.content }, body.message);
        return response(existingSha ? 200 : 201, { content: { path: filePath, sha: treeOf(branch).get(filePath) } });
      }
    }

    if ((m = /^\/git\/ref\/heads\/(.+)$/.exec(rest)) && method === "GET") {
      if (!refs.size) {
        return emptyRepoGitStatus === 403
          ? response(403, { message: "Resource not accessible by personal access token" })
          : response(409, { message: "Git Repository is empty." });
      }
      const sha = refs.get(m[1]);
      return sha ? response(200, { object: { sha } }) : response(404, { message: "Not Found" });
    }

    if ((m = /^\/branches\/(.+)$/.exec(rest)) && method === "GET") {
      const sha = refs.get(m[1]);
      if (!sha && !refs.size && emptyRepoGitStatus === 403) {
        return response(403, { message: "Resource not accessible by personal access token" });
      }
      if (!sha) return response(404, { message: "Branch not found" });
      return response(200, { name: m[1], commit: { sha, commit: { tree: { sha: commits.get(sha).tree } } } });
    }

    if ((m = /^\/git\/commits\/(\w+)$/.exec(rest)) && method === "GET") {
      const commit = commits.get(m[1]);
      return commit ? response(200, { sha: m[1], tree: { sha: commit.tree } }) : response(404, { message: "Not Found" });
    }

    if ((m = /^\/git\/blobs\/(\w+)$/.exec(rest)) && method === "GET") {
      const base64 = blobs.get(m[1]);
      return base64 !== undefined ? response(200, { sha: m[1], content: base64, encoding: "base64" }) : response(404, { message: "Not Found" });
    }

    if (!canWrite && method !== "GET") {
      return response(403, { message: "Resource not accessible by personal access token" });
    }

    if (rest === "/git/blobs" && method === "POST") {
      if (!refs.size && emptyRepoGitStatus !== 403) return response(409, { message: "Git Repository is empty." });
      const sha = nextSha();
      blobs.set(sha, body.encoding === "base64" ? body.content : utf8ToBase64(body.content));
      return response(201, { sha });
    }

    if (rest === "/git/trees" && method === "POST") {
      const tree = new Map(trees.get(body.base_tree) || []);
      for (const item of body.tree) {
        if (item.sha === null) {
          if (!tree.has(item.path)) return response(422, { message: "GitRPC::BadObjectState" });
          tree.delete(item.path);
        } else {
          tree.set(item.path, item.sha);
        }
      }
      const sha = nextSha();
      trees.set(sha, tree);
      return response(201, { sha });
    }

    if (rest === "/git/commits" && method === "POST") {
      const sha = nextSha();
      commits.set(sha, { tree: body.tree, parents: body.parents, message: body.message });
      return response(201, { sha });
    }

    if ((m = /^\/git\/refs\/heads\/(.+)$/.exec(rest)) && method === "PATCH") {
      const current = refs.get(m[1]);
      const commit = commits.get(body.sha);
      if (!body.force && current && !(commit && commit.parents.includes(current))) {
        return response(422, { message: "Update is not a fast forward" });
      }
      refs.set(m[1], body.sha);
      return response(200, { object: { sha: body.sha } });
    }

    return response(404, { message: `Fake GitHub: unhandled ${method} ${rest}` });
  }

  return {
    fetch,
    requests,
    setOnline(value) {
      online = value;
    },
    /** Every file on a branch as { path: text }. */
    files(branch = defaultBranch) {
      const tree = treeOf(branch);
      const result = {};
      for (const [path, sha] of tree || []) {
        result[path] = base64ToUtf8(blobs.get(sha));
      }
      return result;
    },
    /** Raw base64 of one file, or undefined. */
    fileBase64(path, branch = defaultBranch) {
      const tree = treeOf(branch);
      const sha = tree && tree.get(path);
      return sha ? blobs.get(sha) : undefined;
    },
    /** Commits a change as if made elsewhere (another computer). changes: { path: text | null } */
    commitElsewhere(changes, branch = defaultBranch) {
      const encoded = {};
      for (const [path, text] of Object.entries(changes)) {
        encoded[path] = text === null ? null : utf8ToBase64(text);
      }
      return writeCommit(branch, encoded, "Changed elsewhere");
    },
    commitCount(branch = defaultBranch) {
      let count = 0;
      let sha = refs.get(branch);
      while (sha) {
        count++;
        sha = commits.get(sha).parents[0];
      }
      return count;
    },
  };
}
