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

## Milestone 1: The Great Deletion (Strip to Skeleton)

**Goal:** Delete everything we don't need. Get a compiling, minimal Worker.

### Delete entirely:
- `remote/worker/src/telemetry.ts`
- `remote/worker/src/vendor/xterm/` (whole directory)
- `remote/worker/src/static-new.html`
- `web/index.html` (whole `web/` directory)
- `remote/worker/src/github.ts` (we only need repo *listing*, which is in `auth.ts`)
- `remote/dist/` and `remote-agent.mjs`

### Simplify:
- `remote/worker/wrangler.toml` — remove D1 binding, remove `WARM_POOL` DO, remove `[[migrations]]`, keep only `SESSION_DO` and `SANDBOX`
- `remote/worker/src/types.ts` — strip to `Env`, `ArtifactsRegistry`, and a minimal `SessionState` (repo name + git output)
- `remote/worker/src/index.ts` — remove all telemetry, session history, xterm routes, WarmPool references. Keep only: `/`, `/auth/*`, `/api/repos`, `/api/setup`
- `remote/worker/src/static.ts` — replace the 30KB inlined HTML with a minimal 3-screen SPA (landing, repo picker, result)

### Verify:
- `cd remote/worker && npm run typecheck` passes.

---

## Milestone 2: Minimal Orchestrator DO

**Goal:** Rewrite `session-do.ts` from 912 lines to ~100 lines. It does one thing: set up a repo and run `git log`.

The DO has exactly one method:
```ts
async setupRepo(githubToken: string, owner: string, repo: string): Promise<string>
```

Steps inside:
1. `ARTIFACTS.import({ source: { url: githubUrl, branch: "main" }, target: { name: sessionId } })`
2. `ARTIFACTS.get(sessionId).createToken("read-write", 3600)`
3. `getSandbox(env.SANDBOX, sessionId)` → get sandbox instance
4. `sandbox.exec("git clone <artifact-remote> /workspace/repo")`
5. `sandbox.exec("cd /workspace/repo && git log --oneline -5")` → return stdout
6. `sandbox.destroy()` (or keep alive briefly, then destroy)

No event streaming. No heartbeats. No idle timeouts. No PRs. No AI. Just git.

---

## Milestone 3: Minimal Frontend

**Goal:** A dead-simple HTML UI served from `static.ts`. Three screens, no dependencies.

1. **Landing:** "Log in with GitHub" button → redirects to `/auth/github`
2. **Repo Picker:** Fetches `/api/repos`, shows searchable list. Clicking a repo calls `/api/setup` with `owner` and `repo`.
3. **Result:** Shows a loading spinner while waiting, then either:
   - **Success:** "Connected to `<owner>/<repo>`" + `<pre>` block with `git log --oneline -5` output
   - **Error:** Red text with what failed

No xterm. No terminal. No WebSocket. No SSE. Just `fetch()` and DOM updates.

---

## Milestone 4: Wire & Test Locally

**Goal:** Make the full flow work end-to-end in `wrangler dev`.

- `/api/setup` endpoint:
  - Validates GitHub auth cookie
  - Gets or creates a `SessionDO` stub
  - Calls `sessionDO.setupRepo(token, owner, repo)`
  - Returns `{ success: true, output: string }` or `{ success: false, error: string }`
- Add basic error handling for each step (artifact import fail, sandbox provision fail, git clone fail)
- Test locally with `wrangler dev` against a public test repo

---

## Milestone 5: Deploy & Validate

**Goal:** Deploy and prove it works with a real repo.

- `wrangler deploy`
- Set secrets if needed (`GITHUB_OAUTH_CLIENT_ID`, `GITHUB_OAUTH_CLIENT_SECRET`, `ENCRYPTION_KEY`)
- Walk through the full flow:
  1. Open page → GitHub OAuth
  2. See repo list
  3. Click a repo
  4. See "Setting up..."
  5. See `git log --oneline -5` output proving the sandbox has the repo

---

## Files to Change / Delete Summary

| Action | Files |
|--------|-------|
| **Delete** | `telemetry.ts`, `vendor/xterm/`, `static-new.html`, `web/`, `github.ts`, `remote/dist/`, `remote-agent.mjs` |
| **Rewrite** | `session-do.ts` (912 → ~100 lines), `static.ts` (30KB inline → ~200 lines minimal), `types.ts` |
| **Edit** | `index.ts`, `wrangler.toml`, `Dockerfile` (remove pnpm, keep git) |
| **Keep mostly as-is** | `auth.ts`, `sandbox.d.ts`, `sandbox-types.d.ts`, `package.json`, `tsconfig.json` |
