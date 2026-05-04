import type { Env } from "./types.js";

const GITHUB_OAUTH_AUTHORIZE = "https://github.com/login/oauth/authorize";
const GITHUB_OAUTH_ACCESS_TOKEN = "https://github.com/login/oauth/access_token";
const GITHUB_API_USER = "https://api.github.com/user";
const GITHUB_API_REPOS = "https://api.github.com/user/repos";

export interface GitHubUser {
  id: number;
  login: string;
  avatar_url: string;
  name?: string;
}

export interface GitHubRepo {
  id: number;
  full_name: string;
  name: string;
  owner: { login: string };
  private: boolean;
  description: string | null;
  updated_at: string;
  permissions?: { admin: boolean; push: boolean; pull: boolean };
}

/**
 * Build the GitHub OAuth authorization URL.
 */
export function getOAuthUrl(env: Env, redirectUri: string, state: string): string {
  const params = new URLSearchParams({
    client_id: env.GITHUB_OAUTH_CLIENT_ID,
    redirect_uri: redirectUri,
    scope: "repo",
    state,
  });
  return `${GITHUB_OAUTH_AUTHORIZE}?${params.toString()}`;
}

/**
 * Exchange OAuth code for access token.
 */
export async function exchangeCode(env: Env, code: string): Promise<string> {
  const res = await fetch(GITHUB_OAUTH_ACCESS_TOKEN, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      client_id: env.GITHUB_OAUTH_CLIENT_ID,
      client_secret: env.GITHUB_OAUTH_CLIENT_SECRET,
      code,
    }),
  });

  if (!res.ok) {
    throw new Error(`GitHub token exchange failed: ${res.status}`);
  }

  const data = await res.json() as { access_token?: string; error?: string; error_description?: string };
  if (data.error) {
    throw new Error(`GitHub OAuth error: ${data.error} - ${data.error_description}`);
  }

  if (!data.access_token) {
    throw new Error("GitHub OAuth response missing access_token");
  }

  return data.access_token;
}

/**
 * Fetch GitHub user profile.
 */
export async function fetchGitHubUser(token: string): Promise<GitHubUser> {
  const res = await fetch(GITHUB_API_USER, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });

  if (!res.ok) {
    throw new Error(`Failed to fetch GitHub user: ${res.status}`);
  }

  return res.json() as Promise<GitHubUser>;
}

/**
 * List GitHub repos the user has push access to.
 */
export async function listGitHubRepos(token: string, page = 1, perPage = 100): Promise<GitHubRepo[]> {
  const params = new URLSearchParams({
    sort: "updated",
    direction: "desc",
    per_page: String(perPage),
    page: String(page),
  });

  const res = await fetch(`${GITHUB_API_REPOS}?${params.toString()}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });

  if (!res.ok) {
    throw new Error(`Failed to list GitHub repos: ${res.status}`);
  }

  const repos = await res.json() as GitHubRepo[];
  // Filter to repos where user has push access
  return repos.filter((r) => r.permissions?.push === true);
}

/**
 * Check if a user is allowed (whitelist check).
 */
export function isUserAllowed(env: Env, githubId: number): boolean {
  // If no whitelist is set, allow all (for open beta)
  if (!env.ALLOWED_GITHUB_IDS) {
    return true;
  }

  const allowed = env.ALLOWED_GITHUB_IDS.split(",").map((id) => id.trim());
  return allowed.includes(String(githubId));
}

export interface SessionData {
  userId: string;
  login: string;
  encryptedToken: string;
  createdAt: number;
}

/**
 * Create a new session in KV. Returns the session ID (harmless UUID).
 * The actual encrypted token is stored server-side in KV.
 */
export async function createSession(
  kv: KVNamespace,
  key: string,
  userId: string,
  login: string,
  githubToken: string
): Promise<string> {
  const sessionId = crypto.randomUUID();
  const encryptedToken = await encryptToken(githubToken, key);

  const session: SessionData = {
    userId,
    login,
    encryptedToken,
    createdAt: Date.now(),
  };

  // Store in KV with 7-day TTL
  await kv.put(`session:${sessionId}`, JSON.stringify(session), {
    expirationTtl: 7 * 24 * 60 * 60,
  });

  return sessionId;
}

/**
 * Look up a session by ID and return decrypted user info.
 */
export async function getSession(
  kv: KVNamespace,
  key: string,
  sessionId: string
): Promise<{ userId: string; login: string; token: string } | null> {
  const raw = await kv.get(`session:${sessionId}`);
  if (!raw) return null;

  try {
    const session = JSON.parse(raw) as SessionData;
    const token = await decryptToken(session.encryptedToken, key);
    return { userId: session.userId, login: session.login, token };
  } catch {
    return null;
  }
}

/**
 * Delete a session from KV (logout / revoke).
 */
export async function deleteSession(kv: KVNamespace, sessionId: string): Promise<void> {
  await kv.delete(`session:${sessionId}`);
}

/**
 * Encrypt a token using AES-GCM via Web Crypto.
 */
export async function encryptToken(token: string, key: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(token);

  // Derive a 256-bit key from the secret string
  const keyData = encoder.encode(key);
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    keyData,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );

  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    cryptoKey,
    data
  );

  // Combine IV + ciphertext and base64 encode
  const combined = new Uint8Array(iv.length + encrypted.byteLength);
  combined.set(iv);
  combined.set(new Uint8Array(encrypted), iv.length);

  return btoa(String.fromCharCode(...combined));
}

/**
 * Decrypt a token using AES-GCM via Web Crypto.
 */
export async function decryptToken(encryptedToken: string, key: string): Promise<string> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();

  // Decode base64
  const combined = Uint8Array.from(atob(encryptedToken), (c) => c.charCodeAt(0));

  // Extract IV (first 12 bytes) and ciphertext
  const iv = combined.slice(0, 12);
  const ciphertext = combined.slice(12);

  // Derive key
  const keyData = encoder.encode(key);
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    keyData,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );

  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv },
    cryptoKey,
    ciphertext
  );

  return decoder.decode(decrypted);
}
