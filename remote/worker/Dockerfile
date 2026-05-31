FROM docker.io/cloudflare/sandbox:0.7.18

# Install git (needed for repo clone operations)
RUN apt-get update && apt-get install -y git && rm -rf /var/lib/apt/lists/*

# Pre-install KimiFlare so it's available immediately in every session.
# --force skips engine checks (ink@7 wants Node >=22, Sandbox has Node 20).
# --ignore-scripts skips native compilation (better-sqlite3) — the worker
# doesn't use the memory/SQLite features so this is safe.
RUN npm install -g --force --ignore-scripts kimiflare
