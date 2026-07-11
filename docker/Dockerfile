# =============================================================================
# Agent Teams hosted startup Docker image
#
# Runs the non-Electron hosted startup shell server and serves the renderer
# build over HTTP. Desktop/runtime APIs are intentionally not launched here.
#
# Build:  docker build -f docker/Dockerfile -t agent-teams-ai-hosted .
# Local host access:
#   docker run --rm -e HOST=0.0.0.0 -e HOSTED_ALLOW_REMOTE=1 -p 127.0.0.1:3456:3456 agent-teams-ai-hosted
# Remote exposure is not the default. To expose beyond host loopback, publish an
# explicit non-loopback port only on a trusted network.
# =============================================================================

ARG NODE_VERSION=24.16.0

FROM node:${NODE_VERSION}-slim AS base

WORKDIR /app

# Enable corepack for pnpm
RUN corepack enable

FROM base AS builder

# Native dependencies such as node-pty may need source builds on slim images.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

# Install dependencies first (better layer caching). Workspace package manifests
# are copied because the root package pins workspace dependencies.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY agent-teams-controller/package.json ./agent-teams-controller/package.json
COPY landing/package.json ./landing/package.json
COPY mcp-server/package.json ./mcp-server/package.json
COPY packages/agent-graph/package.json ./packages/agent-graph/package.json
COPY vendor/terminal-platform/manifest.json ./vendor/terminal-platform/manifest.json
COPY vendor/terminal-platform/sdk ./vendor/terminal-platform/sdk
COPY vendor/terminal-platform/terminal-platform-node-stub ./vendor/terminal-platform/terminal-platform-node-stub
COPY patches ./patches
COPY scripts/ci/enforce-pnpm-install.mjs ./scripts/ci/enforce-pnpm-install.mjs
COPY scripts/ensure-electron-install.cjs ./scripts/ensure-electron-install.cjs
RUN pnpm install --frozen-lockfile

# Copy source and build
COPY . .
RUN AGENT_TEAMS_DISABLE_SOURCEMAPS=1 pnpm hosted:build

# =============================================================================
# Production stage - minimal image with only the built hosted startup output
# =============================================================================
FROM base

# Copy built hosted shell server and renderer output
COPY --from=builder /app/dist-hosted ./dist-hosted
COPY --from=builder /app/out/renderer ./out/renderer

ENV NODE_ENV=production
ENV HOST=127.0.0.1
ENV PORT=3456

EXPOSE 3456

CMD ["node", "dist-hosted/server.cjs"]
