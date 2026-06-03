# KimiFlare Commute — Self-hosted Cloudflare Worker

Run [KimiFlare](https://github.com/sinameraji/kimiflare) (Kimi-K2.6 coding agent) in a Cloudflare Sandbox, directly from your browser. Pick any GitHub repo, get an instant terminal sandbox with KimiFlare pre-installed and ready to code.

## What this is

- A Cloudflare Worker that serves a web UI
- GitHub OAuth for login
- Cloudflare Sandboxes (containers) for ephemeral dev environments
- Cloudflare Artifacts for fast repo cloning
- KimiFlare CLI pre-installed in every sandbox
- Your own Cloudflare Workers AI account — you bring the API token

## Prerequisites

- [Node.js](https://nodejs.org/) ≥ 20
- A [Cloudflare](https://dash.cloudflare.com) account with **Cloudflare Sandbox** enabled
- A [GitHub](https://github.com) account
- [Wrangler](https://developers.cloudflare.com/workers/wrangler/install-and-update/) CLI ≥ **4.90.0** installed and authenticated:
  ```bash
  npm install -g wrangler
  wrangler login
  ```

> **Cloudflare Sandbox & Artifacts:** This worker uses [Cloudflare Sandbox](https://developers.cloudflare.com/sandbox/) (containers for secure code execution) and [Cloudflare Artifacts](https://developers.cloudflare.com/artifacts/) (repo storage). Sandbox reached General Availability in April 2026 and is available to all Cloudflare Workers customers. Artifacts may still require beta access. If Artifacts is not available, the worker automatically falls back to cloning directly from GitHub — everything still works, just slightly slower on first setup. See [Troubleshooting](#artifacts-binding-not-available) for details.

## Local development

To run the worker locally before deploying:

```bash
cd remote/worker
cp .dev.vars.example .dev.vars
# Edit .dev.vars and fill in your secrets
npm install
npm run dev
```

Open `http://localhost:8787` in your browser.

> **Note:** For local dev, Wrangler reads secrets from `.dev.vars` (not from the cloud secret store). The `.dev.vars` file is already in `.gitignore` so it won't be committed.

## Quick deploy

### 1. Clone this repo

```bash
git clone https://github.com/sinameraji/kimiflare-commute.git
cd kimiflare-commute/remote/worker
```

### 2. Create a GitHub OAuth app

1. Go to [GitHub → Settings → Developer settings → OAuth Apps](https://github.com/settings/developers)
2. Click **New OAuth App**
3. Fill in:
   - **Application name**: `KimiFlare Commute` (or whatever you want)
   - **Homepage URL**: `https://kimiflare-commute.<your-subdomain>.workers.dev`
   - **Authorization callback URL**: `https://kimiflare-commute.<your-subdomain>.workers.dev/auth/github/callback`
4. Click **Register application**
5. Copy the **Client ID** and generate a **Client Secret**

> **Tip:** If you don't know your worker subdomain yet, you can update the callback URL later. Or use `workers_dev = true` and Wrangler will give you a `*.workers.dev` subdomain automatically.

### 3. Create a Cloudflare API token

1. Go to [Cloudflare dash → My Profile → API Tokens](https://dash.cloudflare.com/profile/api-tokens)
2. Click **Create Token**
3. Use the **Custom token** template
4. Permissions:
   - **Account** → **Workers AI** → **Read**
   - **Account** → **Cloudflare Pages** → **Read** (optional, for Artifacts)
5. Account Resources: include your account
6. Click **Continue to summary** → **Create token**
7. **Copy the token** — you won't see it again

### 4. Create the KV namespace

```bash
wrangler kv:namespace create OAUTH_KV
```

Copy the `id` from the output and paste it into `wrangler.toml` under `[[kv_namespaces]]`.

### 5. Create the R2 backup bucket (optional)

This enables 1–3s repo restore for repeat visits instead of re-cloning:

```bash
wrangler r2 bucket create kimiflare-commute-backups
```

The bucket name must match `wrangler.toml` (`bucket_name = "kimiflare-commute-backups"`).
If you skip this step, the worker falls back to full clone — no breaking change.

### 6. Set secrets

Run these one by one. Wrangler will prompt you for the value each time:

```bash
wrangler secret put GITHUB_OAUTH_CLIENT_ID
# paste your GitHub OAuth Client ID

wrangler secret put GITHUB_OAUTH_CLIENT_SECRET
# paste your GitHub OAuth Client Secret

wrangler secret put ACCOUNT_ID
# paste your Cloudflare Account ID (from the right sidebar of any Cloudflare dash page)

wrangler secret put CF_API_TOKEN
# paste your Cloudflare API token from step 3

wrangler secret put ENCRYPTION_KEY
# generate one with: openssl rand -base64 32
```

Optional secrets:

```bash
wrangler secret put ALLOWED_GITHUB_IDS
# comma-separated GitHub user IDs (numbers, not usernames)
# leave unset to allow any GitHub user

wrangler secret put ADMIN_GITHUB_ID
# a single GitHub user ID with admin privileges
```

### 7. Deploy

```bash
wrangler deploy
```

Wrangler will print your worker URL, e.g.:

```
https://kimiflare-commute.your-subdomain.workers.dev
```

### 8. Update GitHub OAuth callback URL

If you used a placeholder in step 2, go back to your GitHub OAuth app settings and update the **Authorization callback URL** to match your actual worker URL + `/auth/github/callback`.

### 9. Use it

Open your worker URL in a browser, log in with GitHub, pick a repository, and wait for the setup steps to complete. You'll get a terminal into a Cloudflare Sandbox with KimiFlare ready to go.

## Architecture

```
Browser ──► Cloudflare Worker (Hono)
                │
                ├── GitHub OAuth (login)
                ├── KV (sessions, OAuth state)
                ├── Session DO (per-user session state)
                ├── Artifacts (repo storage)
                └── Sandbox DO (container terminal)
                            │
                            └── KimiFlare CLI ──► Cloudflare Workers AI
                                                  (your account, your billing)
```

## Files

| File | Purpose |
|------|---------|
| `src/index.ts` | Hono worker — routes, auth, API, WebSocket proxy |
| `src/auth.ts` | GitHub OAuth flow, session encryption |
| `src/session-do.ts` | Durable Object — repo import, sandbox setup, progress tracking |
| `src/static.ts` | Single-page app HTML/CSS/JS (repo picker, progress UI, terminal) |
| `src/types.ts` | TypeScript interfaces |
| `wrangler.toml` | Worker config — bindings, secrets, containers |
| `Dockerfile` | Container image for the sandbox (uses the public `docker.io/cloudflare/sandbox` base image) |

## Costs

You pay Cloudflare directly for:
- **Workers AI** — per-token usage (Kimi-K2.6 pricing)
- **Sandbox containers** — per-second CPU/memory usage
- **Artifacts** — storage and egress
- **Workers** — negligible for this use case

See [Cloudflare pricing](https://developers.cloudflare.com/workers-ai/pricing/) for current rates.

## Troubleshooting

### "ARTIFACTS binding not available"

This can happen for two reasons:

1. **Wrangler is too old.** The `[[artifacts]]` table in `wrangler.toml` requires Wrangler ≥ 4.90.0. Upgrade with:
   ```bash
   npm install -g wrangler@latest
   ```
   Then redeploy: `wrangler deploy`

2. **Your Cloudflare account doesn't have Artifacts beta access.** The worker will automatically fall back to cloning directly from GitHub using your OAuth token. Everything works — the only difference is that repo cloning happens inside the sandbox instead of via the fast Artifacts import path.

### "Not authorized" after GitHub login

Check that `ALLOWED_GITHUB_IDS` is either unset (allows everyone) or contains your numeric GitHub user ID. Find your ID at `https://api.github.com/users/<your-username>`.

### Sandbox takes a long time to start

First startup pulls the container image. Subsequent startups are faster. Large repos also take longer to clone — the progress UI shows each step.

## License

MIT — see the root [LICENSE](../../LICENSE).
