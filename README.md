# KimiFlare Web

Browser-based terminal for [KimiFlare](https://github.com/sinameraji/kimiflare), orchestrated by Cloudflare Workers and executing in Cloudflare Sandbox.

## Architecture

- **Cloudflare Worker** (`remote/worker/`) — Auth, session management, LLM relay, telemetry
- **Cloudflare Sandbox** — Containerized execution environment
- **Cloudflare Artifacts** — Git repo storage per session
- **Web UI** (`web/`) — xterm.js terminal in the browser

## Development

```bash
cd remote/worker
npm install
npm run dev        # wrangler dev
npm run deploy     # wrangler deploy
```

## Environment Variables

Set via `wrangler secret put`:

- `GITHUB_OAUTH_CLIENT_ID`
- `GITHUB_OAUTH_CLIENT_SECRET`
- `ENCRYPTION_KEY`
- `ALLOWED_GITHUB_IDS`
- `CF_API_TOKEN`
- `CF_ACCOUNT_ID`
- `KIMI_API_KEY`

## Docs

See `docs/web-remote-plan.md` for full architecture.
