FROM docker.io/cloudflare/sandbox:0.7.18

# Install git (needed for repo clone operations)
RUN apt-get update && apt-get install -y git && rm -rf /var/lib/apt/lists/*

# Pre-install KimiFlare so it's available immediately in every session.
# --force skips engine checks: the Cloudflare Sandbox image ships Node 20,
# but some deps (e.g. ink@7) declare >=22. The code runs fine on Node 20.
RUN npm install -g --force kimiflare
