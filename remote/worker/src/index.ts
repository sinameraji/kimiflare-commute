import { Hono } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import type { Env } from "./types.js";
import { SessionDO } from "./session-do.js";
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
import {
  upsertUser,
  listUserSessions,
  getUserDailyUsage,
} from "./telemetry.js";
import { INDEX_HTML } from "./static.js";

const app = new Hono<{ Bindings: Env }>();

// ── Serve web UI ────────────────────────────────────────────────────
app.get("/", async (c) => {
  return c.html(INDEX_HTML);
});

// ── CORS for web frontend ───────────────────────────────────────────
app.use("/api/*", async (c, next) => {
  c.header("Access-Control-Allow-Origin", c.req.header("Origin") ?? "https://commute.kimiflare.com");
  c.header("Access-Control-Allow-Credentials", "true");
  c.header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  c.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (c.req.method === "OPTIONS") return c.text("", 204);
  await next();
});

app.use("/auth/*", async (c, next) => {
  c.header("Access-Control-Allow-Origin", c.req.header("Origin") ?? "https://commute.kimiflare.com");
  c.header("Access-Control-Allow-Credentials", "true");
  c.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  c.header("Access-Control-Allow-Headers", "Content-Type");
  if (c.req.method === "OPTIONS") return c.text("", 204);
  await next();
});

// ── Auth middleware for API routes ──────────────────────────────────
// Cookie contains ONLY a harmless session ID. The actual encrypted token
// is stored server-side in KV and decrypted on each request.
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

  // Store user in D1
  await upsertUser(c.env.DB, String(user.id), user.login, user.avatar_url);

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
  return c.redirect("https://commute.kimiflare.com");
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

// ── API: Sessions ───────────────────────────────────────────────────
app.post("/api/sessions", async (c) => {
  const auth = await requireAuth(c);
  if (!auth) return c.json({ error: "Unauthorized" }, 401);

  const body = await c.req.json() as {
    prompt: string;
    repo: { owner: string; name: string };
    model?: string;
    maxTurns?: number;
    reasoningEffort?: string;
  };

  const sessionId = crypto.randomUUID();
  const id = c.env.SESSION_DO.idFromName(sessionId);
  const doStub = c.env.SESSION_DO.get(id);

  const res = await doStub.fetch(new Request("http://internal/start", {
    method: "POST",
    body: JSON.stringify({
      ...body,
      githubToken: auth.token,
      userId: auth.userId,
    }),
    headers: { "Content-Type": "application/json" },
  }));

  const data = await res.json();
  return c.json({ ...data, sessionId });
});

app.get("/api/sessions", async (c) => {
  const auth = await requireAuth(c);
  if (!auth) return c.json({ error: "Unauthorized" }, 401);

  const sessions = await listUserSessions(c.env.DB, auth.userId, 20);
  return c.json({ sessions });
});

app.get("/api/sessions/:sessionId", async (c) => {
  const auth = await requireAuth(c);
  if (!auth) return c.json({ error: "Unauthorized" }, 401);

  const sessionId = c.req.param("sessionId");
  const id = c.env.SESSION_DO.idFromName(sessionId);
  const doStub = c.env.SESSION_DO.get(id);

  const res = await doStub.fetch(new Request("http://internal/status", { method: "GET" }));
  return res;
});

app.get("/api/sessions/:sessionId/stream", async (c) => {
  const sessionId = c.req.param("sessionId");
  const id = c.env.SESSION_DO.idFromName(sessionId);
  const doStub = c.env.SESSION_DO.get(id);

  const res = await doStub.fetch(new Request("http://internal/stream", { method: "GET" }));
  return res;
});

app.get("/api/sessions/:sessionId/terminal", async (c) => {
  const sessionId = c.req.param("sessionId");
  const id = c.env.SESSION_DO.idFromName(sessionId);
  const doStub = c.env.SESSION_DO.get(id);

  // Forward the request (including WebSocket upgrade headers)
  const res = await doStub.fetch(new Request("http://internal/terminal", {
    method: "GET",
    headers: c.req.raw.headers,
  }));

  return res;
});

app.post("/api/sessions/:sessionId/cancel", async (c) => {
  const auth = await requireAuth(c);
  if (!auth) return c.json({ error: "Unauthorized" }, 401);

  const sessionId = c.req.param("sessionId");
  const id = c.env.SESSION_DO.idFromName(sessionId);
  const doStub = c.env.SESSION_DO.get(id);

  const res = await doStub.fetch(new Request("http://internal/cancel", { method: "POST" }));
  return res;
});

app.post("/api/sessions/:sessionId/message", async (c) => {
  const auth = await requireAuth(c);
  if (!auth) return c.json({ error: "Unauthorized" }, 401);

  const sessionId = c.req.param("sessionId");
  const id = c.env.SESSION_DO.idFromName(sessionId);
  const doStub = c.env.SESSION_DO.get(id);

  const body = await c.req.json();
  const res = await doStub.fetch(new Request("http://internal/message", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  }));

  return res;
});

// ── API: Admin usage ────────────────────────────────────────────────
app.get("/api/admin/usage", async (c) => {
  const auth = await requireAuth(c);
  if (!auth) return c.json({ error: "Unauthorized" }, 401);

  if (auth.userId !== c.env.ADMIN_GITHUB_ID) {
    return c.json({ error: "Forbidden" }, 403);
  }

  const days = Number(c.req.query("days") ?? "30");
  const usage = await getUserDailyUsage(c.env.DB, auth.userId, days);

  return c.json({ usage });
});

// ── Legacy /remote routes (for CLI compatibility) ───────────────────
app.use("/remote/start", async (c, next) => {
  const auth = c.req.header("Authorization");
  const expected = `Bearer ${c.env.REMOTE_AUTH_SECRET}`;
  if (auth !== expected) return c.json({ error: "Unauthorized" }, 401);
  await next();
});

app.post("/remote/start", async (c) => {
  const body = await c.req.json();
  const sessionId = crypto.randomUUID();
  const id = c.env.SESSION_DO.idFromName(sessionId);
  const doStub = c.env.SESSION_DO.get(id);

  const res = await doStub.fetch(new Request("http://internal/start", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  }));

  const data = await res.json();
  return c.json({ ...data, sessionId });
});

app.get("/remote/stream/:sessionId", async (c) => {
  const sessionId = c.req.param("sessionId");
  const id = c.env.SESSION_DO.idFromName(sessionId);
  const doStub = c.env.SESSION_DO.get(id);
  return doStub.fetch(new Request("http://internal/stream", { method: "GET" }));
});

app.post("/remote/cancel/:sessionId", async (c) => {
  const sessionId = c.req.param("sessionId");
  const id = c.env.SESSION_DO.idFromName(sessionId);
  const doStub = c.env.SESSION_DO.get(id);
  return doStub.fetch(new Request("http://internal/cancel", { method: "POST" }));
});

app.get("/remote/status/:sessionId", async (c) => {
  const sessionId = c.req.param("sessionId");
  const id = c.env.SESSION_DO.idFromName(sessionId);
  const doStub = c.env.SESSION_DO.get(id);
  return doStub.fetch(new Request("http://internal/status", { method: "GET" }));
});

app.post("/progress/:sessionId", async (c) => {
  const sessionId = c.req.param("sessionId");
  const id = c.env.SESSION_DO.idFromName(sessionId);
  const doStub = c.env.SESSION_DO.get(id);
  const body = await c.req.json();
  return doStub.fetch(new Request("http://internal/progress", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  }));
});

app.post("/finalize/:sessionId", async (c) => {
  const sessionId = c.req.param("sessionId");
  const id = c.env.SESSION_DO.idFromName(sessionId);
  const doStub = c.env.SESSION_DO.get(id);
  const body = await c.req.json();
  return doStub.fetch(new Request("http://internal/finalize", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  }));
});

app.post("/relay", async (c) => {
  const sessionId = c.req.header("X-Session-Id");
  if (!sessionId) return c.json({ error: "Missing X-Session-Id header" }, 400);

  const id = c.env.SESSION_DO.idFromName(sessionId);
  const doStub = c.env.SESSION_DO.get(id);
  const body = await c.req.json();
  return doStub.fetch(new Request("http://internal/relay", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  }));
});

// ── Health check ────────────────────────────────────────────────────
app.get("/health", (c) => c.json({ ok: true }));

export default app;
export { SessionDO };
