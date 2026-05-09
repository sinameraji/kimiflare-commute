import { Hono } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import type { Env } from "./types.js";
import { SessionDO } from "./session-do.js";
import { WarmPool } from "@cloudflare/sandbox/bridge";
import { Sandbox, getSandbox } from "@cloudflare/sandbox";
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

function log(label: string, data: unknown) {
  console.log(`[Worker] ${label}:`, JSON.stringify(data, null, 2));
}

// ── Request logging middleware ──────────────────────────────────────
app.use("*", async (c, next) => {
  const start = Date.now();
  const url = new URL(c.req.url);
  log("→ REQUEST", {
    method: c.req.method,
    path: url.pathname,
    query: Object.fromEntries(url.searchParams),
    headers: {
      "content-type": c.req.header("content-type"),
      "user-agent": c.req.header("user-agent")?.slice(0, 50),
    },
  });
  await next();
  const duration = Date.now() - start;
  log("← RESPONSE", {
    method: c.req.method,
    path: url.pathname,
    status: c.res.status,
    durationMs: duration,
  });
});

// ── Serve web UI ────────────────────────────────────────────────────
app.get("/", async (c) => {
  return c.html(INDEX_HTML);
});

// ── Auth middleware for API routes ──────────────────────────────────
async function requireAuth(c: import("hono").Context<{ Bindings: Env }>) {
  const sessionId = getCookie(c, "session");
  log("requireAuth", { sessionId: sessionId ? "present" : "missing" });

  if (!sessionId) {
    log("requireAuth — FAIL", "No session cookie");
    return null;
  }

  const session = await getSession(c.env.OAUTH_KV, c.env.ENCRYPTION_KEY, sessionId);
  if (!session) {
    log("requireAuth — FAIL", "Session not found in KV");
    return null;
  }

  log("requireAuth — OK", { userId: session.userId, login: session.login });
  return session;
}

// ── GitHub OAuth ────────────────────────────────────────────────────
app.get("/auth/github", async (c) => {
  const redirectUri = `${new URL(c.req.url).origin}/auth/github/callback`;
  const state = crypto.randomUUID();

  log("/auth/github", { redirectUri, state });

  // Store state in KV (5 min TTL)
  await c.env.OAUTH_KV.put(`oauth:state:${state}`, redirectUri, { expirationTtl: 300 });

  const url = getOAuthUrl(c.env, redirectUri, state);
  return c.redirect(url);
});

app.get("/auth/github/callback", async (c) => {
  const code = c.req.query("code");
  const state = c.req.query("state");

  log("/auth/github/callback", { code: code ? "present" : "missing", state: state ? "present" : "missing" });

  if (!code || !state) {
    return c.json({ error: "Missing code or state" }, 400);
  }

  // Verify state
  const storedRedirect = await c.env.OAUTH_KV.get(`oauth:state:${state}`);
  if (!storedRedirect) {
    log("/auth/github/callback — FAIL", "Invalid or expired state");
    return c.json({ error: "Invalid or expired state" }, 400);
  }
  await c.env.OAUTH_KV.delete(`oauth:state:${state}`);

  // Exchange code for token
  let accessToken: string;
  try {
    accessToken = await exchangeCode(c.env, code);
    log("/auth/github/callback — token exchanged", { tokenLength: accessToken.length });
  } catch (err) {
    log("/auth/github/callback — token exchange FAIL", err instanceof Error ? err.message : String(err));
    return c.json({ error: err instanceof Error ? err.message : "OAuth failed" }, 400);
  }

  // Fetch user
  let user: import("./auth.js").GitHubUser;
  try {
    user = await fetchGitHubUser(accessToken);
    log("/auth/github/callback — user fetched", { id: user.id, login: user.login });
  } catch (err) {
    log("/auth/github/callback — user fetch FAIL", err instanceof Error ? err.message : String(err));
    return c.json({ error: err instanceof Error ? err.message : "Failed to fetch user" }, 400);
  }

  // Whitelist check
  if (!isUserAllowed(c.env, user.id)) {
    log("/auth/github/callback — FAIL", `User ${user.id} not in ALLOWED_GITHUB_IDS`);
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

  log("/auth/github/callback — SUCCESS", { sessionId, userId: user.id });

  // Redirect to app
  return c.redirect("/");
});

app.post("/auth/logout", async (c) => {
  const sessionId = getCookie(c, "session");
  log("/auth/logout", { sessionId: sessionId ? "present" : "missing" });
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

  log("/api/repos", { userId: auth.userId, page, perPage });

  try {
    const repos = await listGitHubRepos(auth.token, page, perPage);
    log("/api/repos — OK", { count: repos.length });
    return c.json({ repos });
  } catch (err) {
    log("/api/repos — FAIL", err instanceof Error ? err.message : String(err));
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

  log("/api/setup", { owner: body.owner, name: body.name, userId: auth.userId });

  // Log env bindings at the worker level
  log("/api/setup — env bindings", {
    SESSION_DO: !!c.env.SESSION_DO,
    SANDBOX: !!c.env.SANDBOX,
    ARTIFACTS: !!c.env.ARTIFACTS,
    OAUTH_KV: !!c.env.OAUTH_KV,
    envKeys: Object.keys(c.env as Record<string, unknown>),
  });

  const sessionId = crypto.randomUUID();
  const id = c.env.SESSION_DO.idFromName(sessionId);
  const doStub = c.env.SESSION_DO.get(id);

  log("/api/setup — DO stub created", { sessionId, doId: id.toString() });

  let res: Response;
  try {
    res = await doStub.fetch(new Request("http://internal/setup", {
      method: "POST",
      body: JSON.stringify({
        owner: body.owner,
        name: body.name,
        githubToken: auth.token,
        userId: auth.userId,
        sessionId,
      }),
      headers: { "Content-Type": "application/json" },
    }));
    log("/api/setup — DO response", { status: res.status, ok: res.ok });
  } catch (err) {
    log("/api/setup — DO fetch FAIL", err instanceof Error ? err.message : String(err));
    return c.json({ error: err instanceof Error ? err.message : "Session DO unreachable" }, 500);
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "Setup failed");
    log("/api/setup — DO error body", text);
    return c.json({ error: text }, res.status as 500);
  }

  const data = (await res.json()) as { success: boolean; output?: string; error?: string };
  log("/api/setup — result", data);
  return c.json(data);
});

// ── WebSocket: Terminal into sandbox ────────────────────────────────
app.get("/ws/:sessionId", async (c) => {
  const auth = await requireAuth(c);
  if (!auth) return c.json({ error: "Unauthorized" }, 401);

  const sessionId = c.req.param("sessionId");
  log("/ws/:sessionId", { sessionId, userId: auth.userId });

  // Verify the session belongs to this user
  const doId = c.env.SESSION_DO.idFromName(sessionId);
  const doStub = c.env.SESSION_DO.get(doId);
  let verifyRes: Response;
  try {
    verifyRes = await doStub.fetch(new Request("http://internal/verify"));
    log("/ws/:sessionId — verify response", { status: verifyRes.status });
  } catch (err) {
    log("/ws/:sessionId — verify FAIL", err instanceof Error ? err.message : String(err));
    return c.json({ error: "Session unreachable" }, 500);
  }
  if (!verifyRes.ok) {
    log("/ws/:sessionId — verify NOT FOUND");
    return c.json({ error: "Session not found" }, 404);
  }
  const verify = (await verifyRes.json()) as { userId: string; sessionId: string };
  if (verify.userId !== auth.userId) {
    log("/ws/:sessionId — verify FORBIDDEN", { expected: auth.userId, got: verify.userId });
    return c.json({ error: "Forbidden" }, 403);
  }

  // Use the SDK session-based terminal API so the container session is
  // properly initialised before the PTY handshake.
  const cols = Number(c.req.query("cols") ?? "120");
  const rows = Number(c.req.query("rows") ?? "30");

  log("/ws/:sessionId — connecting terminal", { sessionId, cols, rows });

  try {
    const sandbox = getSandbox(c.env.SANDBOX as any, sessionId);
    const containerSessionId = `sandbox-${sessionId}`;
    const session = await sandbox.getSession(containerSessionId);
    log("/ws/:sessionId — terminal session obtained", { containerSessionId });
    return await session.terminal(c.req.raw, { cols, rows });
  } catch (err) {
    log("/ws/:sessionId — terminal ERROR", err instanceof Error ? err.message : String(err));
    console.error("Terminal connection error:", err);
    return c.json(
      { error: err instanceof Error ? err.message : "Terminal connection failed" },
      500
    );
  }
});

// ── Health check ────────────────────────────────────────────────────
app.get("/health", (c) => {
  log("/health", { ok: true });
  return c.json({ ok: true });
});

export default app;
export { SessionDO, Sandbox, WarmPool };
