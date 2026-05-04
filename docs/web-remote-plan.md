# Web Remote Plan: KimiFlare in the Browser

> A terminal-coding agent accessible from any phone browser, powered by Cloudflare Workers, Sandbox, and Artifacts.

---

## 1. Vision & User Journey

### 1.1 The Experience

1. **User opens `https://commute.kimiflare.com` on their phone.**
2. **Sees a landing page** with "Log in with GitHub".
3. **Clicks the button** → GitHub OAuth authorization → redirected back.
4. **Sees a repo picker** (list of their GitHub repos, searchable).
5. **Selects a repo** → the screen transitions to a **terminal UI**.
6. **Types a prompt** (e.g., "Add a dark mode toggle to the settings page").
7. **Behind the scenes:**
   - Worker creates a Cloudflare Artifacts repo (isolated Git server).
   - Worker creates a Cloudflare Sandbox container.
   - Worker clones the selected GitHub repo into the Artifacts repo.
   - Worker installs KimiFlare into the Sandbox (via NPM).
   - Worker starts KimiFlare in the Sandbox, pointing it at the Artifacts repo.
8. **In the terminal UI:**
   - User sees KimiFlare's thinking, tool calls, file edits — streamed in real time.
   - User can send follow-up messages.
9. **When satisfied, user types:** "Create a PR" (or clicks a button).
10. **Worker:**
    - Pushes the branch from Artifacts to GitHub.
    - Opens a pull request against the original repo.
    - Shows the PR URL in the terminal.
11. **Cleanup:** Sandbox is destroyed, Artifacts repo is scheduled for deletion (e.g., 24h later).

---

## 2. High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              User's Phone                                   │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │  Browser (Web Terminal)                                             │   │
│  │  - React/Vue + xterm.js                                             │   │
│  │  - WebSocket or SSE for streaming                                   │   │
│  └──────────────────────┬──────────────────────────────────────────────┘   │
└─────────────────────────┼───────────────────────────────────────────────────┘
                          │ HTTPS / WSS
┌─────────────────────────┼───────────────────────────────────────────────────┐
│  Cloudflare Worker      │                                                   │
│  (Orchestrator + API)   ▼                                                   │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │  Durable Object: SessionDO                                          │   │
│  │  - Per-session state (prompt, repo, branch, status)                 │   │
│  │  - GitHub token (encrypted)                                         │   │
│  │  - SSE/WebSocket client management                                  │   │
│  │  - Sandbox & Artifacts lifecycle                                    │   │
│  └──────────────────────┬──────────────────────────────────────────────┘   │
│                         │                                                   │
│  ┌──────────────────────┴──────────────────────────────────────────────┐   │
│  │  Durable Object: UserDO (optional, v2)                              │   │
│  │  - User profile, GitHub token cache, repo list cache                │   │
│  │  - Session history                                                  │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
└─────────────────────────┬───────────────────────────────────────────────────┘
                          │ Bindings
          ┌───────────────┴───────────────┐
          ▼                               ▼
┌─────────────────────┐         ┌─────────────────────┐
│  Cloudflare Sandbox │         │  Cloudflare Artifacts│
│  (KimiFlare runtime)│         │  (isolated Git repo) │
│  - Node.js 20       │         │  - Fork of GitHub    │
│  - KimiFlare (npm)  │         │    repo              │
│  - Git CLI          │         │  - Write token       │
│  - Workspace        │         │  - Branch:           │
│    /workspace       │         │    kimiflare/web/    │
│                     │         │    <sessionId>       │
└─────────────────────┘         └─────────────────────┘
```

---

## 3. Component Breakdown

### 3.1 Cloudflare Worker (Orchestrator)

**Responsibilities:**
- Serve the web UI (static HTML/JS/CSS, or proxy to a separate frontend).
- Handle GitHub OAuth callback.
- Manage Durable Objects (SessionDO, optionally UserDO).
- Expose REST API for the web UI:
  - `POST /auth/github` — start OAuth
  - `GET /auth/github/callback` — OAuth callback
  - `GET /repos` — list user's GitHub repos
  - `POST /sessions` — create a new session
  - `GET /sessions/:id` — get session status
  - `POST /sessions/:id/message` — send a message to the agent
  - `GET /sessions/:id/stream` — SSE/WebSocket stream of events
  - `POST /sessions/:id/pr` — trigger PR creation
  - `DELETE /sessions/:id` — cancel / cleanup

**Key API Design Decision:**
- **SSE for agent output** (one-way server → client streaming). Simpler than WebSocket, works over HTTP/1.1, auto-reconnects.
- **WebSocket for bidirectional chat** (user can send messages while agent is running). More complex but better UX. Could also use HTTP POST for user messages + SSE for responses.
- **Recommendation:** Start with SSE for agent output + HTTP POST for user input. Simpler, stateless, auto-reconnect. Upgrade to WebSocket later if latency is an issue.

### 3.2 Durable Object: SessionDO

**State (persisted to DO storage):**
```ts
interface SessionState {
  sessionId: string;
  userId: string;           // GitHub user ID
  status: "idle" | "running" | "paused" | "done" | "error" | "cancelled";
  
  // GitHub
  githubToken: string;      // Encrypted OAuth token
  repo: { owner: string; name: string };
  
  // Artifacts
  artifactsRepoName: string;
  artifactsRemote: string;
  artifactsToken: string;   // Encrypted
  
  // Sandbox
  sandboxId: string;
  
  // Session
  prompt: string;
  branch: string;
  messages: ChatMessage[];  // Conversation history
  currentTurn: number;
  maxTurns: number;
  
  // Output
  progressEvents: AgentEvent[];
  prUrl?: string;
  errorMessage?: string;
  
  // Timing
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  ttlMinutes: number;
}
```

**Lifecycle:**
1. **Created** when user selects a repo and submits a prompt.
2. **Spawns Sandbox + Artifacts** in `fetch()` handler.
3. **Runs agent** in background (non-blocking).
4. **Streams events** to connected clients via SSE.
5. **Alarm set** for TTL (e.g., 30 min) + max session duration (e.g., 4 hours).
6. **On completion/error/timeout:**
   - Destroy Sandbox.
   - Schedule Artifacts repo deletion (e.g., 24h).
   - Save final state.

### 3.3 Cloudflare Artifacts

**Usage:**
```ts
// 1. Import the GitHub repo into Artifacts
const imported = await env.ARTIFACTS.import({
  source: {
    url: `https://github.com/${owner}/${repo}.git`,
    branch: "main",
  },
  target: {
    name: `kimiflare-${sessionId}`,
  },
});

// 2. Create a write token for the Sandbox
const repo = await env.ARTIFACTS.get(imported.name);
const token = await repo.createToken("write", 3600 * 4); // 4h TTL

// 3. Pass remote URL + token to Sandbox
const gitRemote = imported.remote.replace(
  "https://",
  `https://x:${token.plaintext}@`
);
```

**Key insight from docs:** Artifacts supports `import()` from an external Git remote. This is perfect — we don't need to clone via the Sandbox. The Worker imports the repo, then the Sandbox pushes commits back to Artifacts.

**Forking consideration:** Artifacts also supports `repo.fork()`. We could fork the imported repo within Artifacts to isolate sessions, but `import()` already gives us an isolated copy. Forking is useful if we want a baseline repo that multiple sessions branch from.

### 3.4 Cloudflare Sandbox

**Usage:**
```ts
import { getSandbox } from "@cloudflare/sandbox";

const sandbox = getSandbox(env.Sandbox, sessionId, {
  keepAlive: true, // Prevent sleep while agent is running
});

// Write files (e.g., pre-configure git)
await sandbox.writeFile("/workspace/.gitconfig", gitConfig);

// Execute KimiFlare
const result = await sandbox.exec("npx", ["kimiflare@latest", "--headless"], {
  cwd: "/workspace",
  env: {
    KIMIFLARE_ARTIFACTS_URL: artifactsRemote,
    KIMIFLARE_GITHUB_TOKEN: githubToken,
    KIMIFLARE_BRANCH: branch,
    KIMIFLARE_PROMPT: prompt,
    // ... other config
  },
  timeout: 1000 * 60 * 30, // 30 min per turn
});
```

**Key insight from docs:**
- `getSandbox()` returns immediately; container starts lazily.
- `keepAlive: true` prevents the 10-minute sleep. Must call `destroy()` when done.
- `exec()` returns `{ stdout, stderr, exitCode, success }`.
- `execStream()` returns a stream of events for real-time output.
- Files can be written directly via `writeFile()` — no need for `echo` hacks.

**Sandbox Image:**
We need a custom container image with:
- Node.js 20+
- Git
- Common build tools (build-essential, python3, etc.)
- KimiFlare pre-installed (or installed via `npm install -g kimiflare`)

The existing `/remote` Dockerfile is a good starting point.

### 3.5 Web Terminal UI

**Tech stack:**
- **Framework:** Plain React (no need for Ink — this is a browser).
- **Terminal rendering:** [xterm.js](https://xtermjs.org/) — the same library VS Code uses. It handles ANSI colors, cursor movement, scrolling, etc.
- **Styling:** Tailwind CSS or plain CSS for the chrome (header, status bar, input area).

**Layout:**
```
┌─────────────────────────────────────┐
│  KimiFlare Web    [Repo: owner/name]│  ← Header
├─────────────────────────────────────┤
│                                     │
│  > Add dark mode toggle             │
│                                     │
│  Thinking...                        │
│  [tool_call] read_file src/App.tsx  │
│  [tool_result] ...                  │
│  [text_delta] I'll add a toggle...  │
│                                     │
│  ── Done ──                         │
│  Branch: kimiflare/web/abc123       │
│  [Create PR]                        │
│                                     │
├─────────────────────────────────────┤
│  > _                                │  ← Input
└─────────────────────────────────────┘
```

**Event streaming:**
- Connect to `GET /sessions/:id/stream` (SSE).
- Parse events: `turn_start`, `text_delta`, `tool_call`, `tool_result`, `usage`, `done`, `error`.
- Render events in the terminal. Tool calls can be collapsible.

**Input modes:**
- **Initial prompt:** User types before session starts.
- **Follow-up:** User can send additional messages while session is running (if agent supports it) or after it pauses.

### 3.6 GitHub Integration

**OAuth Flow (GitHub App vs OAuth App):**

| Aspect | GitHub App | OAuth App |
|--------|-----------|-----------|
| Token type | Installation token | Personal access token |
| Scopes | Fine-grained permissions | Coarse scopes (`repo`) |
| Rate limit | 15,000/hr per installation | 5,000/hr per user |
| Repo access | Can be limited to specific repos | All repos user has access to |
| Webhooks | Supported | Not supported |

**Recommendation:** Start with **OAuth App** for simplicity. A single OAuth App is easier to set up and manage. We can migrate to GitHub App later for better rate limits and fine-grained permissions.

**OAuth flow:**
1. User clicks "Log in with GitHub".
2. Worker redirects to `https://github.com/login/oauth/authorize?client_id=...&redirect_uri=...&scope=repo`.
3. GitHub redirects back with `?code=...`.
4. Worker exchanges code for access token via `POST https://github.com/login/oauth/access_token`.
5. Worker stores token (encrypted) in UserDO or SessionDO.
6. Worker uses token for all GitHub API calls (repo listing, PR creation).

**Token encryption:**
- Use Cloudflare Workers' built-in [Web Crypto API](https://developers.cloudflare.com/workers/runtime-apis/web-crypto/) to encrypt tokens at rest.
- Store the encryption key in a Worker secret (`ENCRYPTION_KEY`).

**Repo listing:**
- `GET /user/repos?sort=updated&per_page=100` — list repos user has access to.
- Cache in UserDO for 5 minutes to reduce API calls.
- Support pagination (infinite scroll in UI).

**PR creation:**
- Push branch from Artifacts to GitHub: `git push https://x:${token}@github.com/owner/repo.git HEAD:branch-name`
- This can be done from the Sandbox or the Worker. Doing it from the Worker is cleaner — the Sandbox just pushes to Artifacts, then the Worker pushes to GitHub.
- Create PR via GitHub API: `POST /repos/{owner}/{repo}/pulls`.

---

## 4. Data Flow

### 4.1 Session Creation

```
User (Browser)          Worker (SessionDO)      Artifacts               Sandbox
    │                         │                      │                      │
    │  POST /sessions         │                      │                      │
    │  { repo, prompt }       │                      │                      │
    │ ───────────────────────>│                      │                      │
    │                         │  1. import() GitHub  │                      │
    │                         │     repo into        │                      │
    │                         │     Artifacts        │                      │
    │                         │ ────────────────────>│                      │
    │                         │  2. createToken()    │                      │
    │                         │ ────────────────────>│                      │
    │                         │  3. getSandbox()     │                      │
    │                         │     keepAlive=true   │                      │
    │                         │                      │                      │
    │                         │  4. writeFile()      │                      │
    │                         │     .gitconfig       │                      │
    │                         │ ───────────────────────────────────────────>│
    │                         │  5. exec("git       │                      │
    │                         │     checkout -b")    │                      │
    │                         │ ───────────────────────────────────────────>│
    │                         │  6. exec("npx       │                      │
    │                         │     kimiflare")      │                      │
    │                         │ ───────────────────────────────────────────>│
    │  { sessionId, streamUrl }                      │                      │
    │ <───────────────────────│                      │                      │
    │                         │                      │                      │
    │  GET /stream (SSE)      │                      │                      │
    │ ───────────────────────>│                      │                      │
    │  [events...]            │                      │                      │
    │ <───────────────────────│                      │                      │
```

### 4.2 Agent Execution (Inside Sandbox)

The Sandbox runs KimiFlare in **headless mode** (no TUI). It communicates with the Worker via HTTP:

1. **KimiFlare calls LLM** → `POST /relay` on Worker → Worker calls Workers AI (Kimi K2.6).
2. **KimiFlare uses tools** → directly in Sandbox (read/write files, exec commands).
3. **KimiFlare reports progress** → `POST /progress` on Worker → Worker broadcasts to SSE clients.
4. **KimiFlare pushes commits** → `git push` to Artifacts repo.

This is the same pattern as the existing `/remote` implementation.

### 4.3 PR Creation

```
User (Browser)          Worker (SessionDO)      Artifacts               GitHub
    │                         │                      │                      │
    │  POST /sessions/:id/pr  │                      │                      │
    │ ───────────────────────>│                      │                      │
    │                         │  1. Push branch from │                      │
    │                         │     Artifacts to     │                      │
    │                         │     GitHub           │                      │
    │                         │  (or have Sandbox    │                      │
    │                         │   do it)             │                      │
    │                         │                      │                      │
    │                         │  2. POST /repos/     │                      │
    │                         │     owner/repo/pulls │                      │
    │                         │ ───────────────────────────────────────────>│
    │                         │                      │                      │
    │  { prUrl }              │                      │                      │
    │ <───────────────────────│                      │                      │
```

---

## 5. Lifecycle & Cleanup

### 5.1 Sandbox Lifecycle

| State | Trigger | Action |
|-------|---------|--------|
| **Created** | User submits prompt | `getSandbox()` with `keepAlive: true` |
| **Running** | Agent is active | Heartbeat every 30s (auto by Sandbox) |
| **Paused** | Agent completes a turn | Sandbox stays alive (keepAlive) |
| **Destroyed** | Session done / error / timeout / cancel | `sandbox.destroy()` |

**Key question: When to destroy?**

**Option A: Destroy immediately on completion**
- Pros: Minimizes cost. Clean.
- Cons: User can't send follow-up messages without re-creating the Sandbox.

**Option B: Keep alive for N minutes after completion**
- Pros: User can send follow-ups. Better UX.
- Cons: Higher cost. Need to manage idle timeout.

**Option C: Destroy on completion, re-create for follow-ups**
- Pros: Cost-efficient.
- Cons: Slower follow-ups (Sandbox cold start ~5-10s).

**Recommendation:** Option B with a **5-minute idle timeout** after completion. If user sends a follow-up within 5 min, reuse the Sandbox. Otherwise, destroy and require re-starting the session. This balances UX and cost.

**Cost estimate (Sandbox):**
- 1 vCPU, 2 GB RAM
- $0.10 per vCPU-hour, $0.10 per GB-hour
- 30 min session: $0.05 + $0.10 = ~$0.15
- 100 sessions/day: ~$15/day

### 5.2 Artifacts Lifecycle

| State | Trigger | Action |
|-------|---------|--------|
| **Created** | Session starts | `artifacts.import()` from GitHub |
| **Active** | Agent pushes commits | Repo exists |
| **PR created** | User requests PR | Branch pushed to GitHub |
| **Scheduled deletion** | PR created / session error | `artifacts.delete()` after TTL |

**Key question: When to delete the Artifacts repo?**

**Option A: Delete immediately after PR creation**
- Pros: Minimal storage cost.
- Cons: If PR needs updates, user must start a new session.

**Option B: Keep for 24 hours after session completion**
- Pros: User can resume and amend. Debugging access.
- Cons: Small storage cost (negligible for small repos).

**Option C: Keep until PR is merged/closed**
- Pros: User can push updates to the same PR.
- Cons: Requires polling GitHub API or webhook. Complex.

**Recommendation:** Option B — **24-hour TTL**. Set a DO alarm for 24h after session completion. If user wants to continue, they can start a new session (which imports from GitHub again, not from the old Artifacts repo).

**Cost estimate (Artifacts):**
- Storage is cheap (~$0.023/GB/month).
- A 100MB repo stored for 24h: ~$0.00008.
- Negligible compared to Sandbox compute.

### 5.3 Session State Persistence

Session state is stored in the Durable Object's SQLite storage. It persists even if the DO is evicted.

**Retention policy:**
- Keep session history for 30 days (for dashboard/review).
- After 30 days, archive or delete.
- Encrypt sensitive fields (GitHub token, Artifacts token).

---

## 6. Security Considerations

### 6.1 Authentication

- **GitHub OAuth:** Use PKCE if possible (GitHub supports it for OAuth Apps). Prevents authorization code interception.
- **Session tokens:** Issue short-lived JWTs to the browser after OAuth. Store in `HttpOnly` cookie or `localStorage` (trade-off: XSS vs CSRF).
  - **Recommendation:** `HttpOnly` cookie with `SameSite=Lax` for session token. More secure against XSS.
- **Worker → DO:** Use Cloudflare's built-in DO routing (no additional auth needed within the same Worker).

### 6.2 Authorization

- **Repo access:** Only allow sessions for repos the user has `push` access to (check via GitHub API).
- **Session isolation:** Each SessionDO is isolated. Users can only access their own sessions.
- **Rate limiting:** Implement per-user rate limiting (e.g., max 5 concurrent sessions, max 1 session per minute).

### 6.3 Secrets

- **GitHub OAuth client secret:** Worker secret.
- **Encryption key:** Worker secret (`ENCRYPTION_KEY`).
- **Workers AI API token:** Worker secret (or use Workers AI binding).
- **Artifacts tokens:** Encrypted in DO storage. Never logged or sent to client.

### 6.4 Sandbox Security

- Sandboxes are isolated containers. Each session gets its own Sandbox.
- No network egress from Sandbox except through Worker relay (if configured).
- User code (via KimiFlare tools) runs inside the Sandbox. This is the same trust model as local KimiFlare.

---

## 7. Error Handling & Resilience

### 7.1 Sandbox Crashes

- **Detection:** `exec()` returns non-zero exit code or throws.
- **Recovery:**
  1. Save current state to DO.
  2. Attempt to restart Sandbox with same `sessionId`.
  3. KimiFlare agent checks Artifacts repo for existing commits.
  4. If commits exist, resume from last commit.
  5. If resumption fails 3 times, mark session as "error".

### 7.2 Artifacts Failures

- **Import fails:** GitHub repo is private and token lacks access, or repo is too large.
  - Return clear error to user.
- **Push fails:** Branch conflict.
  - Worker force-pushes (`--force-with-lease`) after warning.

### 7.3 GitHub API Failures

- **Rate limit:** Return 429 to client with `Retry-After` header.
- **Token expired:** If using OAuth App, token doesn't expire unless revoked. If using GitHub App, refresh installation token.

### 7.4 User Disconnection

- **SSE auto-reconnect:** Browser reconnects with `Last-Event-ID` to resume from last event.
- **Session continues:** Agent keeps running even if user disconnects.
- **User reopens browser:** Can reconnect to active session via session ID.

---

## 8. Open Questions & Trade-offs

### 8.1 Frontend: Monolith or Separate?

| Approach | Pros | Cons |
|----------|------|------|
| **A. Serve from Worker** (HTML/JS in Worker) | Single deploy. No CORS. | Larger Worker bundle. Harder to iterate on UI. |
| **B. Separate static site** (Pages + Worker API) | Better DX for UI. Independent deploys. | CORS handling. Two projects to manage. |
| **C. Worker serves SPA** (React app bundled into Worker) | Good balance. Single deploy. Modern DX. | Need build step to bundle SPA into Worker. |

**Recommendation:** Option C. Use a React SPA built with Vite, then serve the `dist/` files from the Worker (or use Cloudflare Pages with Functions for the API). For simplicity, start by serving the SPA from the Worker — the `index.html` and static assets can be bundled as strings/modules in the Worker.

### 8.2 Real-time Transport: SSE vs WebSocket

| Aspect | SSE | WebSocket |
|--------|-----|-----------|
| Complexity | Low (HTTP) | Higher (upgrade handshake) |
| Reconnection | Built-in (browser) | Manual |
| Bidirectional | No (need separate POST) | Yes |
| Firewall/proxy | Works everywhere | Sometimes blocked |
| DO support | Easy (stream from DO) | Requires hibernation-aware API |

**Recommendation:** SSE for agent output + HTTP POST for user input. Simpler, more reliable, especially on mobile networks. Can upgrade to WebSocket later.

### 8.3 KimiFlare in Sandbox: Pre-installed or Dynamic?

| Approach | Pros | Cons |
|----------|------|------|
| **Pre-installed in image** | Faster startup. No network dependency. | Larger image. Harder to update. |
| **Installed via `npm install`** | Always latest version. Smaller image. | Slower startup (~30s install). Network dependency. |

**Recommendation:** Pre-install in the Docker image, but support overriding with a specific version via env var. The existing `/remote` Dockerfile already does this.

### 8.4 Branch Naming

- `kimiflare/web/<sessionId>` — clear, unique, easy to identify.
- Could also include timestamp or slugified prompt.

### 8.5 Multi-session Support

- **Can a user have multiple active sessions?**
  - Yes, each session is a separate SessionDO.
  - Limit to N concurrent sessions per user (e.g., 3) to control costs.

### 8.6 Follow-up Messages

- **Can the user send follow-up messages after the agent completes?**
  - Yes, if the Sandbox is still alive (within idle timeout).
  - The agent resumes from the last state (conversation history + git state).
  - If Sandbox was destroyed, user must start a new session.

### 8.7 PR Amendments

- **Can the user amend an existing PR?**
  - Not directly in v1. Each session creates a new branch.
  - Workaround: User can reference the PR in a new prompt ("Update PR #123 to also...").
  - v2 could support pushing to the same branch.

---

## 9. Phased Implementation Plan

### Phase 0: Spike & Validation (3–5 days)

**Goal:** Validate the core integration: Worker + Sandbox + Artifacts + GitHub API.

**Tasks:**
1. Create a minimal Worker with Sandbox and Artifacts bindings.
2. Test `artifacts.import()` from a public GitHub repo.
3. Test `getSandbox()` + `exec("git clone")` from Artifacts.
4. Test `sandbox.exec("npx kimiflare")` with a simple prompt.
5. Test pushing a branch from Sandbox to Artifacts, then to GitHub.
6. Test GitHub OAuth flow (manual, not integrated).

**Deliverable:** A working spike that can import a repo, run KimiFlare, and push a branch.

### Phase 1: Web UI + OAuth + Repo Picker (5–7 days)

**Goal:** User can log in, pick a repo, and see a terminal UI.

**Tasks:**
1. Build React SPA with:
   - Landing page with "Log in with GitHub".
   - OAuth callback handler.
   - Repo picker (searchable, paginated).
   - Terminal UI (xterm.js) with input.
2. Worker routes:
   - `GET /` — serve SPA.
   - `GET /auth/github` — redirect to GitHub.
   - `GET /auth/github/callback` — handle callback, set cookie.
   - `GET /api/repos` — list repos (cached).
   - `POST /api/sessions` — create session.
3. SessionDO skeleton:
   - Create DO on session start.
   - Store state.
   - Return session ID + stream URL.

**Deliverable:** User can log in, pick a repo, and submit a prompt. Session is created.

### Phase 2: Agent Execution + Streaming (5–7 days)

**Goal:** Agent runs in Sandbox and streams output to the terminal.

**Tasks:**
1. Integrate Sandbox + Artifacts into SessionDO.
2. Build headless KimiFlare agent for Sandbox (reuse `/remote` agent).
3. Implement SSE stream from SessionDO.
4. Wire progress events (turn_start, text_delta, tool_call, etc.) to SSE.
5. Handle agent completion, errors, and cancellation.
6. Implement idle timeout and Sandbox destruction.

**Deliverable:** User sees KimiFlare working in the terminal, streaming in real time.

### Phase 3: PR Creation + Cleanup (3–5 days)

**Goal:** User can create a PR and resources are cleaned up.

**Tasks:**
1. Implement `POST /api/sessions/:id/pr`.
2. Push branch from Artifacts to GitHub.
3. Create PR via GitHub API.
4. Show PR URL in terminal.
5. Implement cleanup:
   - Destroy Sandbox on completion.
   - Schedule Artifacts deletion (24h TTL).
   - Archive session state.

**Deliverable:** End-to-end flow: prompt → agent → PR.

### Phase 4: Polish & Scale (5–7 days)

**Goal:** Production-ready.

**Tasks:**
1. Error handling and retry logic.
2. Rate limiting and abuse prevention.
3. Session dashboard (list past sessions, view logs).
4. Mobile UX polish (touch-friendly input, responsive layout).
5. Cost monitoring and alerts.
6. Documentation and onboarding.

**Deliverable:** Public beta.

---

## 10. Reuse from Existing `/remote`

The existing `kimiflare-remote` branch has significant work we can reuse:

| Component | Existing Code | Reuse Strategy |
|-----------|--------------|----------------|
| **Remote agent** | `remote/agent/src/remote-agent.ts` | Reuse as-is. It's already headless. |
| **Worker session DO** | `remote/worker/src/session-do.ts` | Adapt. Replace CLI auth with web auth. Add SSE instead of internal relay. |
| **GitHub API** | `remote/worker/src/github.ts` | Reuse `createPullRequest`, `getDefaultBranch`, etc. |
| **Worker types** | `remote/worker/src/types.ts` | Reuse and extend. |
| **Dockerfile** | `remote/Dockerfile` | Reuse as-is for Sandbox image. |
| **Progress reporter** | `remote/agent/src/progress-reporter.ts` | Reuse. Same event format. |
| **Headless permission** | `remote/agent/src/headless-permission.ts` | Reuse. Auto-approve tools in headless mode. |

**What needs to be built new:**
- Web UI (React + xterm.js).
- GitHub OAuth flow in Worker.
- Repo picker API and UI.
- SSE streaming to browser.
- Session dashboard.
- Mobile-responsive design.

---

## 11. Cost Estimate (Monthly, 1000 sessions)

| Service | Unit Cost | Usage | Total |
|---------|-----------|-------|-------|
| **Workers** | $5/million requests | ~1M requests | ~$5 |
| **Durable Objects** | $0.12/million requests + storage | ~1M requests + 1GB storage | ~$15 |
| **Sandbox** | $0.10/vCPU-hr + $0.10/GB-hr | 1000 sessions × 30 min × 1vCPU × 2GB | ~$200 |
| **Artifacts** | $0.023/GB/month | ~50GB (avg 100MB × 500 active) | ~$1 |
| **Workers AI** | Per token | Depends on usage | ~$100–500 |
| **Total** | | | **~$320–720/month** |

*Note: Sandbox is the dominant cost. Optimizations: shorter sessions, smaller instances, spot/preemptible if available.*

---

## 12. Questions for You

1. **GitHub App vs OAuth App:** Do you have a preference? OAuth App is simpler; GitHub App is more scalable.
2. **Repo scope:** Should we support only repos the user owns, or also org repos they have write access to?
3. **Private repos:** Is supporting private repos a v1 requirement? (Requires `repo` scope.)
4. **Follow-up messages:** How important is the ability to send follow-ups after the agent completes? This affects Sandbox idle timeout strategy.
5. **PR amendments:** Should v1 support updating an existing PR, or is creating a new PR per session acceptable?
6. **Custom Sandbox image:** The existing Dockerfile installs Rust, Go, Python, etc. Do we need all of these, or can we start with a smaller image (Node + Git + build-essential)?
7. **Domain:** Do you have a domain in mind (e.g., `kimiflare.dev`), or should we use `*.workers.dev` for the beta?
8. **Billing/cost limits:** Should we implement per-user session limits or spending caps to prevent abuse?

---

## 13. Session Limits (Final)

| Resource | Hard Limit | Rationale |
|----------|-----------|-----------|
| **Sandbox active time** | 4 hours | DO alarm cap. Prevents runaway costs. |
| **Sandbox idle grace** | 5 minutes after agent completes | Time for user to read response and type follow-up. |
| **Sandbox sleep timeout** | 10 minutes (auto) after keepAlive=false | Cloudflare default. Free while sleeping. |
| **Sandbox destroy timeout** | 1 hour after sleep starts | Clean up resources. |
| **Artifacts token TTL** | 4 hours | Match Sandbox cap. |
| **Artifacts repo deletion** | 24 hours after session completion | Debugging window. |
| **D1 session retention** | 90 days | For dashboard/history. |

**Sleep logic:**
- Agent running (LLM call or tools executing) → `keepAlive: true`
- Agent completed, waiting for user → `keepAlive: true` for 5 min
- No user input for 5 min → `keepAlive: false` → sleep after 10 min
- Sleeping for 1 hour → `destroy()`
- 4-hour total active cap → `destroy()` regardless of state

---

## 14. Final Architecture Decisions

| Decision | Choice |
|----------|--------|
| **Domain** | `commute.kimiflare.com` |
| **Worker** | One persistent Worker, extend existing `/remote` |
| **Sessions** | One active per user (v1). Parallel in v2. |
| **Terminal** | Real PTY via `sandbox.terminal()` + xterm.js |
| **Git remotes** | `origin` → GitHub, `artifacts` → Artifacts |
| **Instance type** | `standard-1` default, `basic` for small repos |
| **Auth** | GitHub OAuth App + whitelist (v1) |
| **Telemetry DB** | D1 |
| **Agent memory persistence** | R2 backup/restore of SQLite |
| **Billing** | Tracked in D1 from v1 |

---

## 15. Implementation Order

1. Update plan doc (this file)
2. Set up D1 schema and Wrangler bindings
3. Add GitHub OAuth to Worker
4. Extend SessionDO with terminal() support
5. Build web UI (React + xterm.js)
6. Add repo picker and session history
7. Wire end-to-end: OAuth → session → terminal → PR
8. Add telemetry and admin usage endpoint
