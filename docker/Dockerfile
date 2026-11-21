# =============================================================================
# Agent Teams standalone Docker image
#
# Runs the HTTP server without Electron, serving the full UI over HTTP.
# Mount your ~/.claude directory to make session data available, and keep a
# volume on /data/app-data so the app's own data (saved team templates and
# other internal storage) survives container replacement.
#
# Build:  docker build -t agent-teams-ai .
# Run:    docker run -p 3456:3456 -v ~/.claude:/data/.claude:ro -v agent-teams-app-data:/data/app-data agent-teams-ai
# =============================================================================

ARG NODE_VERSION=26.11.1
# Keep in sync with "packageManager" in package.json.
ARG PNPM_VERSION=11.22.0

FROM node:${NODE_VERSION}-slim AS base

ARG PNPM_VERSION

WORKDIR /app

# Node.js 26 does not bundle corepack, so install the pinned pnpm explicitly
RUN npm install --global --ignore-scripts pnpm@${PNPM_VERSION}

FROM base AS builder

# Native dependencies such as node-pty may need source builds on slim images.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

# The frozen install needs the whole workspace: pnpm-workspace.yaml (overrides,
# patchedDependencies, allowBuilds), workspace package manifests, vendor SDK
# tarballs, patches, and the root preinstall/postinstall scripts.
COPY . .
# The standalone build only needs Node-built dependencies, not the Electron
# binary or an Electron ABI rebuild (same install profile as CI).
RUN AGENT_TEAMS_INSTALL_PROFILE=node-ci ELECTRON_SKIP_BINARY_DOWNLOAD=1 \
  pnpm install --frozen-lockfile
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
# The full workspace is required for the frozen lockfile config to match.
# Lifecycle scripts stay disabled, so root preinstall/postinstall do not run.
COPY . .
RUN pnpm install --frozen-lockfile --prod --ignore-scripts \
  && pnpm rebuild node-pty cpu-features ssh2 better-sqlite3

# =============================================================================
# Production stage - minimal image with only runtime dependencies and built output
# =============================================================================
FROM base

COPY --from=prod-deps /app/package.json /app/pnpm-lock.yaml ./
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=builder /app/agent-teams-controller ./agent-teams-controller

# Copy built standalone server and renderer output
COPY --from=builder /app/dist-standalone ./dist-standalone
COPY --from=builder /app/out/renderer ./out/renderer
# The internal-storage SQLite worker is built by electron-vite into
# dist-electron/main, which is not shipped in this image. Copy it next to the
# standalone bundle so InternalStorageWorkerClient resolves it co-located
# (candidate #1) instead of reporting unavailable storage for template writes.
# The worker requires its shared chunks (relative ./chunks/*.cjs requires, with
# content-hashed names that change per build), so the whole chunks directory
# travels with it.
COPY --from=builder /app/dist-electron/main/internal-storage-worker.cjs ./dist-standalone/internal-storage-worker.cjs
COPY --from=builder /app/dist-electron/main/chunks ./dist-standalone/chunks

# Create data directory for Claude session mount and the persistent app-data
# volume (internal storage: saved templates and friends).
RUN mkdir -p /data/.claude /data/app-data

ENV NODE_ENV=production
ENV CLAUDE_ROOT=/data/.claude
ENV APP_DATA_DIR=/data/app-data
ENV HOST=0.0.0.0
ENV PORT=3456

EXPOSE 3456

CMD ["node", "dist-standalone/index.cjs"]
