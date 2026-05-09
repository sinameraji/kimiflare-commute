import { Hono } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import type { Env } from "./types.js";
import { SessionDO } from "./session-do.js";
import { WarmPool } from "@cloudflare/sandbox/bridge";
import { Sandbox, proxyTerminal } from "@cloudflare/sandbox";
import {
  getOAuthUrl,
  exchangeCode,
  fetchGitHubUser,
  listGitHubRepos,
  isUserAllowed,
  createSession,
  getSession,
  deleteSession,
} from "./auth.js";
import { INDEX_HTML } from "./static.js";

const app = new Hono<{ Bindings: Env }>();

// ── Serve web UI ────────────────────────────────────────────────────
app.get("/", async (c) => {
  return c.html(INDEX_HTML);
});

// ── Auth middleware for API routes ──────────────────────────────────
async function requireAuth(c: import("hono").Context<{ Bindings: Env }>) {
  const sessionId = getCookie(c, "session");
  if (!sessionId) return null;

  const session = await getSession(c.env.OAUTH_KV, c.env.ENCRYPTION_KEY, sessionId);
  if (!session) return null;

  return session;
}

// ── GitHub OAuth ────────────────────────────────────────────────────
app.get("/auth/github", async (c) => {
  const redirectUri = `${new URL(c.req.url).origin}/auth/github/callback`;
  const state = crypto.randomUUID();

  // Store state in KV (5 min TTL)
  await c.env.OAUTH_KV.put(`oauth:state:${state}`, redirectUri, { expirationTtl: 300 });

  const url = getOAuthUrl(c.env, redirectUri, state);
  return c.redirect(url);
});

app.get("/auth/github/callback", async (c) => {
  const code = c.req.query("code");
  const state = c.req.query("state");

  if (!code || !state) {
    return c.json({ error: "Missing code or state" }, 400);
  }

  // Verify state
  const storedRedirect = await c.env.OAUTH_KV.get(`oauth:state:${state}`);
  if (!storedRedirect) {
    return c.json({ error: "Invalid or expired state" }, 400);
  }
  await c.env.OAUTH_KV.delete(`oauth:state:${state}`);

  // Exchange code for token
  let accessToken: string;
  try {
    accessToken = await exchangeCode(c.env, code);
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : "OAuth failed" }, 400);
  }

  // Fetch user
  let user: import("./auth.js").GitHubUser;
  try {
    user = await fetchGitHubUser(accessToken);
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : "Failed to fetch user" }, 400);
  }

  // Whitelist check
  if (!isUserAllowed(c.env, user.id)) {
    return c.json({ error: "Not authorized" }, 403);
  }

  // Create server-side session (encrypted token stored in KV)
  const sessionId = await createSession(
    c.env.OAUTH_KV,
    c.env.ENCRYPTION_KEY,
    String(user.id),
    user.login,
    accessToken
  );

  // Cookie contains ONLY the harmless session ID
  setCookie(c, "session", sessionId, {
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
    maxAge: 7 * 24 * 60 * 60,
    path: "/",
  });

  // Redirect to app
  return c.redirect("/");
});

app.post("/auth/logout", async (c) => {
  const sessionId = getCookie(c, "session");
  if (sessionId) {
    await deleteSession(c.env.OAUTH_KV, sessionId);
  }
  deleteCookie(c, "session");
  return c.json({ ok: true });
});

// ── API: Current user ───────────────────────────────────────────────
app.get("/api/me", async (c) => {
  const auth = await requireAuth(c);
  if (!auth) return c.json({ error: "Unauthorized" }, 401);

  return c.json({
    userId: auth.userId,
    login: auth.login,
  });
});

// ── API: GitHub repos ───────────────────────────────────────────────
app.get("/api/repos", async (c) => {
  const auth = await requireAuth(c);
  if (!auth) return c.json({ error: "Unauthorized" }, 401);

  const page = Number(c.req.query("page") ?? "1");
  const perPage = Number(c.req.query("per_page") ?? "100");

  try {
    const repos = await listGitHubRepos(auth.token, page, perPage);
    return c.json({ repos });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : "Failed to list repos" }, 500);
  }
});

// ── API: Setup repo in sandbox ──────────────────────────────────────
app.post("/api/setup", async (c) => {
  const auth = await requireAuth(c);
  if (!auth) return c.json({ error: "Unauthorized" }, 401);

  const body = await c.req.json() as {
    owner: string;
    name: string;
  };

  const sessionId = crypto.randomUUID();
  const id = c.env.SESSION_DO.idFromName(sessionId);
  const doStub = c.env.SESSION_DO.get(id);

  let res: Response;
  try {
    res = await doStub.fetch(new Request("http://internal/setup", {
      method: "POST",
      body: JSON.stringify({
        owner: body.owner,
        name: body.name,
        githubToken: auth.token,
        userId: auth.userId,
      }),
      headers: { "Content-Type": "application/json" },
    }));
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : "Session DO unreachable" }, 500);
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "Setup failed");
    return c.json({ error: text }, res.status as 500);
  }

  const data = (await res.json()) as { success: boolean; output?: string; error?: string };
  return c.json(data);
});

// ── WebSocket: Terminal into sandbox ────────────────────────────────
app.get("/ws/:sessionId", async (c) => {
  const auth = await requireAuth(c);
  if (!auth) return c.json({ error: "Unauthorized" }, 401);

  const sessionId = c.req.param("sessionId");

  // Verify the session belongs to this user
  const doId = c.env.SESSION_DO.idFromName(sessionId);
  const doStub = c.env.SESSION_DO.get(doId);
  let verifyRes: Response;
  try {
    verifyRes = await doStub.fetch(new Request("http://internal/verify"));
  } catch {
    return c.json({ error: "Session unreachable" }, 500);
  }
  if (!verifyRes.ok) {
    return c.json({ error: "Session not found" }, 404);
  }
  const verify = (await verifyRes.json()) as { userId: string; sessionId: string };
  if (verify.userId !== auth.userId) {
    return c.json({ error: "Forbidden" }, 403);
  }

  // Forward WebSocket upgrade to the Sandbox DO so the container PTY
  // handshake happens inside the DO (required by the runtime).
  const cols = Number(c.req.query("cols") ?? "120");
  const rows = Number(c.req.query("rows") ?? "30");

  const sandboxId = c.env.SANDBOX.idFromName(sessionId);
  const sandbox = c.env.SANDBOX.get(sandboxId);
  const containerSessionId = `sandbox-${sessionId}`;

  return proxyTerminal(sandbox, containerSessionId, c.req.raw, { cols, rows });
});

// ── Health check ────────────────────────────────────────────────────
app.get("/health", (c) => c.json({ ok: true }));

export default app;
export { SessionDO, Sandbox, WarmPool };
