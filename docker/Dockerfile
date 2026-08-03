# =============================================================================
# Agent Teams standalone Docker image
#
# Runs the HTTP server without Electron, serving the full UI over HTTP.
# Mount your ~/.claude directory to make session data available.
#
# Build:  docker build -t agent-teams-ai .
# Run:    docker run -p 3456:3456 -v ~/.claude:/data/.claude:ro agent-teams-ai
# =============================================================================

ARG NODE_VERSION=24.16.0
ARG NODE_IMAGE_DIGEST

FROM node:${NODE_VERSION}-slim@${NODE_IMAGE_DIGEST} AS base

WORKDIR /app

# Enable corepack for pnpm
RUN corepack enable

FROM base AS builder

# Native dependencies such as node-pty may need source builds on slim images.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

# Install dependencies first (better layer caching)
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY patches ./patches
COPY vendor/terminal-platform/sdk ./vendor/terminal-platform/sdk
COPY vendor/terminal-platform/terminal-platform-node-stub ./vendor/terminal-platform/terminal-platform-node-stub
COPY scripts/ci/enforce-pnpm-install.mjs ./scripts/ci/enforce-pnpm-install.mjs
COPY scripts/ensure-electron-install.cjs ./scripts/ensure-electron-install.cjs
RUN pnpm install --frozen-lockfile

# Copy source and build
COPY . .
RUN AGENT_TEAMS_DISABLE_SOURCEMAPS=1 pnpm standalone:build

# =============================================================================
# Production dependencies stage
# =============================================================================
FROM base AS prod-deps

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

# Install production-only dependencies
# (fastify, @fastify/cors, @fastify/static are externalized from the bundle)
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY patches ./patches
COPY vendor/terminal-platform/sdk ./vendor/terminal-platform/sdk
COPY vendor/terminal-platform/terminal-platform-node-stub ./vendor/terminal-platform/terminal-platform-node-stub
COPY scripts/ci/verify-hosted-no-terminal-artifact.mjs /tmp/verify-hosted-no-terminal-artifact.mjs
RUN pnpm install --frozen-lockfile --prod --ignore-scripts \
  && pnpm rebuild better-sqlite3 \
  && node /tmp/verify-hosted-no-terminal-artifact.mjs --root /app --prune --require-better-sqlite3

# =============================================================================
# Production stage - minimal image with only runtime dependencies and built output
# =============================================================================
FROM base

RUN apt-get update \
  && apt-get install -y --no-install-recommends gosu \
  && rm -rf /var/lib/apt/lists/*

COPY --from=prod-deps /app/package.json ./
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=builder /app/agent-teams-controller ./agent-teams-controller

# Copy built standalone server and renderer output
COPY --from=builder /app/dist-standalone ./dist-standalone
COPY --from=builder /app/out/renderer ./out/renderer
COPY scripts/hosted-auth-cli.mjs ./scripts/hosted-auth-cli.mjs
COPY scripts/ci/verify-hosted-no-terminal-artifact.mjs /tmp/verify-hosted-no-terminal-artifact.mjs

# Create data directory for Claude session mount
RUN test -f /app/dist-standalone/index.cjs \
  && test -f /app/dist-standalone/assets/internal-storage-worker.cjs \
  && node /tmp/verify-hosted-no-terminal-artifact.mjs --root /app --require-better-sqlite3 --require-hosted-renderer-graph \
  && rm /tmp/verify-hosted-no-terminal-artifact.mjs \
  && mkdir -p /data/.claude /data/.agent-teams /run/agent-teams \
  && chown node:node /data/.agent-teams /run/agent-teams \
  && chmod 700 /data/.agent-teams /run/agent-teams

ENV NODE_ENV=production
ENV CLAUDE_ROOT=/data/.claude
ENV HOST=0.0.0.0
ENV PORT=3456
ENV AUTH_DATA_DIR=/data/.agent-teams
ENV PAIRING_CODE_FILE=/run/agent-teams/pairing.json
ENV AUTH_CONTROL_SOCKET=/run/agent-teams/control.sock
ENV AUTH_DRAIN_EVIDENCE_FILE=/run/agent-teams/drain-proof.json

USER node

EXPOSE 3456

CMD ["node", "dist-standalone/index.cjs"]
