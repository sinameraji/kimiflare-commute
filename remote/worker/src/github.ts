/**
 * GitHub REST API helpers for the worker execute mode.
 *
 * Runs inside a Cloudflare Worker (no git CLI / filesystem), so branches and
 * commits are created via the Git Data API over plain HTTP.
 */

const API = "https://api.github.com";

function headers(token: string): Record<string, string> {
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "kimiflare-worker",
    "Content-Type": "application/json",
  };
}

async function ghFetch(url: string, token: string, init?: RequestInit): Promise<unknown> {
  const res = await fetch(url, { ...init, headers: { ...headers(token), ...(init?.headers ?? {}) } });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`GitHub API ${init?.method ?? "GET"} ${url} failed: ${res.status} ${text.slice(0, 300)}`);
  }
  return res.json();
}

/** Get the tip commit SHA of a branch. */
export async function getRef(opts: {
  owner: string;
  repo: string;
  branch: string;
  token: string;
}): Promise<string> {
  const data = (await ghFetch(
    `${API}/repos/${opts.owner}/${opts.repo}/git/ref/heads/${opts.branch}`,
    opts.token,
  )) as { object: { sha: string } };
  return data.object.sha;
}

/** Create a new branch ref pointing at the given SHA. */
export async function createRef(opts: {
  owner: string;
  repo: string;
  branch: string;
  sha: string;
  token: string;
}): Promise<void> {
  await ghFetch(`${API}/repos/${opts.owner}/${opts.repo}/git/refs`, opts.token, {
    method: "POST",
    body: JSON.stringify({ ref: `refs/heads/${opts.branch}`, sha: opts.sha }),
  });
}

/** Create a blob from UTF-8 content; returns the blob SHA. */
export async function createBlob(opts: {
  owner: string;
  repo: string;
  content: string;
  token: string;
}): Promise<string> {
  const data = (await ghFetch(`${API}/repos/${opts.owner}/${opts.repo}/git/blobs`, opts.token, {
    method: "POST",
    body: JSON.stringify({ content: opts.content, encoding: "utf-8" }),
  })) as { sha: string };
  return data.sha;
}

/** Create a tree from a base tree + file entries; returns the tree SHA. */
export async function createTree(opts: {
  owner: string;
  repo: string;
  baseTreeSha: string;
  files: Array<{ path: string; blobSha: string }>;
  token: string;
}): Promise<string> {
  const tree = opts.files.map((f) => ({
    path: f.path,
    mode: "100644" as const,
    type: "blob" as const,
    sha: f.blobSha,
  }));
  const data = (await ghFetch(`${API}/repos/${opts.owner}/${opts.repo}/git/trees`, opts.token, {
    method: "POST",
    body: JSON.stringify({ base_tree: opts.baseTreeSha, tree }),
  })) as { sha: string };
  return data.sha;
}

/** Create a commit; returns the commit SHA. */
export async function createCommit(opts: {
  owner: string;
  repo: string;
  message: string;
  treeSha: string;
  parentShas: string[];
  token: string;
}): Promise<string> {
  const data = (await ghFetch(`${API}/repos/${opts.owner}/${opts.repo}/git/commits`, opts.token, {
    method: "POST",
    body: JSON.stringify({ message: opts.message, tree: opts.treeSha, parents: opts.parentShas }),
  })) as { sha: string };
  return data.sha;
}

/** Fast-forward a branch ref to a new commit SHA. */
export async function updateRef(opts: {
  owner: string;
  repo: string;
  branch: string;
  sha: string;
  token: string;
}): Promise<void> {
  await ghFetch(`${API}/repos/${opts.owner}/${opts.repo}/git/refs/heads/${opts.branch}`, opts.token, {
    method: "PATCH",
    body: JSON.stringify({ sha: opts.sha, force: false }),
  });
}

/** Open a pull request; returns its URL and number. */
export async function createPullRequest(opts: {
  owner: string;
  repo: string;
  title: string;
  body: string;
  head: string;
  base: string;
  token: string;
}): Promise<{ html_url: string; number: number }> {
  return (await ghFetch(`${API}/repos/${opts.owner}/${opts.repo}/pulls`, opts.token, {
    method: "POST",
    body: JSON.stringify({ title: opts.title, body: opts.body, head: opts.head, base: opts.base }),
  })) as { html_url: string; number: number };
}
