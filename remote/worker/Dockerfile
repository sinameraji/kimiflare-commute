FROM docker.io/cloudflare/sandbox:0.10.0

# Install git and curl (needed for repo operations)
USER root
RUN apt-get update && apt-get install -y git curl && rm -rf /var/lib/apt/lists/*

# Install pnpm globally
RUN npm install -g pnpm

# Ensure workspace exists
RUN mkdir -p /workspace && chown -R 1000:1000 /workspace

# Documents the ports this application uses (standard Docker convention)
EXPOSE 8080
