# The Great Deletion

> A minimal, coherent plan to rebuild KimiFlare Web from a clusterfuck into a working product.
> One milestone at a time. Small steps. No confusion.

---

## The Goal

A user goes to `https://commute.kimiflare.com`, sees their GitHub repos, clicks one, and we:
1. Create a Cloudflare Artifact (Git server) seeded from that repo
2. Create a Cloudflare Sandbox VM
3. Clone the Artifact into the Sandbox
4. Run `git log --oneline -5` in the Sandbox
5. Show the output in the browser as proof it worked

That's it. No terminal UI. No AI agent. No PR creation. No telemetry. No usage tracking.

---

## Result: IT WORKS 🎉

**Deployed to:** `https://kimiflare-commute.sina-b35.workers.dev`

The full flow is live and tested:
- User logs in with GitHub
- Sees a searchable list of their repos
- Clicks a repo
- Backend imports it to Artifacts, spins up a Sandbox, clones the repo, runs `git log --oneline -5`
- User sees "Connected to `<owner>/<repo>`" with the commit history

**Key fixes discovered along the way:**
- Sandbox IDs must be ≤63 characters. `DurableObjectId.toString()` is 64 chars. Use `crypto.randomUUID()` instead.
- Artifacts tokens may contain special characters (`/`, `+`, `=`). Always `encodeURIComponent()` the token before embedding in a git HTTPS URL.

---

## Milestone 1: The Great Deletion (Strip to Skeleton) ✅

**Goal:** Delete everything we don't need. Get a compiling, minimal Worker.

### Deleted entirely:
- `remote/worker/src/telemetry.ts`
- `remote/worker/src/vendor/xterm/` (whole directory)
- `remote/worker/src/static-new.html`
- `web/index.html` (whole `web/` directory)
- `remote/worker/src/github.ts` (we only need repo *listing*, which is in `auth.ts`)
- `remote/dist/` and `remote-agent.mjs`
- `remote/worker/schema.sql`

### Simplified:
- `remote/worker/wrangler.toml` — removed D1 binding, `WARM_POOL` DO, migrations. Kept `SESSION_DO`, `SANDBOX`, `ARTIFACTS`, `OAUTH_KV`.
- `remote/worker/src/types.ts` — stripped to `Env`, `ArtifactsRegistry`, and minimal `SessionState`
- `remote/worker/src/index.ts` — removed all telemetry, session history, xterm routes, WarmPool references. Kept only: `/`, `/auth/*`, `/api/me`, `/api/repos`, `/api/setup`, `/health`
- `remote/worker/src/static.ts` — replaced 30KB inlined HTML with a minimal 3-screen SPA (landing, repo picker, result)
- `remote/worker/Dockerfile` — removed pnpm, kept only git

### Verified:
- `cd remote/worker && npm run typecheck` passes.

---

## Milestone 2: Minimal Orchestrator DO ✅

**Goal:** Rewrite `session-do.ts` from 912 lines to ~80 lines. It does one thing: set up a repo and run `git log`.

The DO has exactly one method:
```ts
async handleSetup(request: Request): Promise<Response>
```

Steps inside:
1. `ARTIFACTS.import({ source: { url: githubUrl, branch: "main" }, target: { name: sessionId } })`
2. `ARTIFACTS.get(sessionId).createToken("read-write", 3600)`
3. `getSandbox(env.SANDBOX, sessionId)` → get sandbox instance
4. `sandbox.exec("git clone <artifact-remote> /workspace/repo")`
5. `sandbox.exec("cd /workspace/repo && git log --oneline -5")` → return stdout
6. `sandbox.destroy()`

No event streaming. No heartbeats. No idle timeouts. No PRs. No AI. Just git.

---

## Milestone 3: Minimal Frontend ✅

**Goal:** A dead-simple HTML UI served from `static.ts`. Three screens, no dependencies.

1. **Landing:** "Log in with GitHub" button → redirects to `/auth/github`
2. **Repo Picker:** Fetches `/api/repos`, shows searchable list. Clicking a repo calls `/api/setup` with `owner` and `name`.
3. **Result:** Shows a loading spinner while waiting, then either:
   - **Success:** "Connected to `<owner>/<repo>`" + `<pre>` block with `git log --oneline -5` output
   - **Error:** Red text with what failed

No xterm. No terminal. No WebSocket. No SSE. Just `fetch()` and DOM updates.

---

## Milestone 4: Wire & Test Locally ✅

**Goal:** Make the full flow work end-to-end.

- `/api/setup` endpoint validates auth, creates a `SessionDO` stub, calls `handleSetup`
- Returns `{ success: true, output: string }` or `{ success: false, error: string }`
- Basic error handling for each step (artifact import fail, sandbox provision fail, git clone fail)

**Bugs found and fixed during testing:**
- Sandbox ID limit (63 chars) — fixed by using `crypto.randomUUID()`
- Artifacts token URL encoding — fixed by `encodeURIComponent(token)` before embedding in git URL

---

## Milestone 5: Deploy & Validate ✅

**Goal:** Deploy and prove it works with a real repo.

- `wrangler deploy` succeeded
- Full flow tested end-to-end with a real GitHub repo
- User sees `git log --oneline -5` output proving the sandbox has the repo

**Note:** `WarmPool` remains as a harmless unused export because Cloudflare's migration system wouldn't allow a `deleted_classes` migration. This is a cosmetic leftover and does not affect functionality.

---

## Final Codebase Stats

| File | Lines | Role |
|------|-------|------|
| `index.ts` | ~150 | HTTP routes (/, /auth/*, /api/*, /health) |
| `session-do.ts` | ~80 | One method: import → clone → git log |
| `static.ts` | ~200 | Inline 3-screen SPA |
| `auth.ts` | ~260 | GitHub OAuth + repo listing (unchanged) |
| `types.ts` | ~40 | Minimal types |
| `sandbox.d.ts` | ~30 | Sandbox type declarations |
| `sandbox-types.d.ts` | ~5 | WarmPool stub |
| **Total source** | **~765** | (was ~3,500+) |

---

## Files Changed / Deleted Summary

| Action | Files |
|--------|-------|
| **Deleted** | `telemetry.ts`, `vendor/xterm/`, `static-new.html`, `web/`, `github.ts`, `remote/dist/`, `remote-agent.mjs`, `schema.sql` |
| **Rewritten** | `session-do.ts` (912 → ~80 lines), `static.ts` (30KB → ~200 lines), `types.ts` |
| **Edited** | `index.ts`, `wrangler.toml`, `Dockerfile`, `sandbox-types.d.ts` |
| **Kept as-is** | `auth.ts`, `sandbox.d.ts`, `package.json`, `tsconfig.json` |
