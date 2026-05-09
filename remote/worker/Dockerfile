FROM docker.io/cloudflare/sandbox:0.7.18

# Install git (needed for repo clone operations)
RUN apt-get update && apt-get install -y git && rm -rf /var/lib/apt/lists/*

# Pre-install KimiFleur so it's available immediately in every session
RUN npm install -g kimiflare
