# KIMI.md — @kimiflare/remote-worker

## Project
Cloudflare Worker that powers **commute.kimiflare.com** — a mobile-friendly remote coding agent. Users log in via GitHub, pick a repo, and run a KimiFlare agent inside a Cloudflare Sandbox. TypeScript / Hono / Durable Objects / D1 / KV.

## Build / test / run
```bash
npm install
npm run typecheck      # tsc --noEmit
npm run dev            # wrangler dev
npm run deploy         # wrangler deploy
```
No test suite exists yet.

## Layout
```
src/
  index.ts       Hono app — routes, auth middleware, API surface
  types.ts       Shared interfaces (Env, SessionState, Artifacts, Sandbox bindings)
  auth.ts        GitHub OAuth flow, KV session store, AES-GCM token encryption
  github.ts      GitHub API helpers (PR creation, branch default, token validation)
  telemetry.ts   D1 DB ops — users, sessions, daily usage, cost estimation
  session-do.ts  SessionDO Durable Object — agent lifecycle, SSE/WebSocket, sandbox orchestration
  static.ts      Inline HTML/CSS/JS for the single-page web UI
schema.sql       D1 schema (users, sessions, daily_usage)
wrangler.toml    Worker config — DO, D1, KV, Artifacts, Sandbox bindings
```

## Conventions
- **ES modules** (`"type": "module"`).
- **Import extensions**: always use `.js` for local TS imports (`"./types.js"`) — `moduleResolution: bundler` requires it.
- **Naming**: camelCase in TS; snake_case in D1 columns.
- **Routing**: Hono with typed `Bindings: Env`.
- **State**: session runtime state lives in `SessionDO` (Durable Object); durable history/telemetry goes to D1.
- **Secrets**: `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `ENCRYPTION_KEY` are env secrets (not in repo).
- **Frontend**: the entire web UI is a single inline string in `src/static.ts` — no frontend build step.

## Do / Don't
- **Do** run `npm run typecheck` before deploying — strict TS is enabled.
- **Do** update `schema.sql` and apply D1 migrations if you change the DB schema.
- **Don't** add a frontend bundler without discussion — the inline HTML approach is intentional for zero build complexity.
- **Don't** store raw GitHub tokens in KV — use `encryptToken` / `decryptToken` from `auth.ts`.
- **Don't** rely on `github.ts` `pushBranch` for actual git pushes — it is a stub; the Sandbox handles git operations via short-lived tokens.
- **Don't** forget that `SessionDO` has hard TTLs: 7 days max life, 4 hours max session duration, 1 hour destroy-after-sleep.
