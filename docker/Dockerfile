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
ARG KEYCLOAK_VERSION=26.3.2
ARG KEYCLOAK_IMAGE_DIGEST

# =============================================================================
# Keycloak production stages
#
# Keep the Keycloak augmentation in a pinned, separate target. The runtime
# stage starts only the pre-built PostgreSQL shape with --optimized, so the
# read-only service never attempts a runtime augmentation.
# =============================================================================
FROM quay.io/keycloak/keycloak:${KEYCLOAK_VERSION}@${KEYCLOAK_IMAGE_DIGEST} AS keycloak-build

RUN /opt/keycloak/bin/kc.sh build --db=postgres --health-enabled=true

FROM quay.io/keycloak/keycloak:${KEYCLOAK_VERSION}@${KEYCLOAK_IMAGE_DIGEST} AS keycloak-runtime

USER root

COPY --from=keycloak-build /opt/keycloak/ /opt/keycloak/

RUN mkdir -p /caddy-trust \
  && touch /caddy-trust/root.crt \
  && chown 1000:1000 /caddy-trust /caddy-trust/root.crt \
  && chmod 0700 /caddy-trust \
  && chmod 0600 /caddy-trust/root.crt

USER 1000

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
RUN AGENT_TEAMS_DISABLE_SOURCEMAPS=1 pnpm standalone:build \
  && mkdir -p /app/bin \
  && node scripts/hosted-web/build-instance-lock.mjs \
    --output /app/bin/agent-teams-instance-lock

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

COPY --from=prod-deps /app/package.json ./
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=builder /app/agent-teams-controller ./agent-teams-controller
COPY --from=builder /app/bin/agent-teams-instance-lock ./bin/agent-teams-instance-lock

# Copy built standalone server and renderer output
COPY --from=builder /app/dist-standalone ./dist-standalone
COPY --from=builder /app/out/renderer ./out/renderer
COPY scripts/hosted-auth-cli.mjs ./scripts/hosted-auth-cli.mjs
COPY scripts/ci/verify-hosted-no-terminal-artifact.mjs /tmp/verify-hosted-no-terminal-artifact.mjs
COPY docker/hosted-volume-init.sh /usr/local/bin/hosted-volume-init
COPY docker/hosted-entrypoint.sh /usr/local/bin/hosted-entrypoint

# Create data directory for Claude session mount
RUN test -f /app/dist-standalone/index.cjs \
  && test -f /app/dist-standalone/assets/internal-storage-worker.cjs \
  && node /tmp/verify-hosted-no-terminal-artifact.mjs --root /app --require-better-sqlite3 --require-hosted-renderer-graph \
  && rm /tmp/verify-hosted-no-terminal-artifact.mjs \
  && mkdir -p /data/.claude /data/.agent-teams/data /data/.agent-teams/instance-lock /run/agent-teams /run/agent-teams-oidc /caddy-trust \
  && install -o root -g root -m 0444 /dev/null /data/.agent-teams/instance-lock/instance.lock \
  && chown root:root /app/bin/agent-teams-instance-lock /data/.agent-teams/instance-lock \
  && chown root:node /data/.agent-teams \
  && chown node:node /data/.agent-teams/data \
  && chmod 0555 /app/bin/agent-teams-instance-lock /data/.agent-teams/instance-lock \
  && chmod 1770 /data/.agent-teams \
  && chmod 0700 /data/.agent-teams/data \
  && chown node:node /run/agent-teams /run/agent-teams-oidc /caddy-trust \
  && chmod 700 /run/agent-teams /run/agent-teams-oidc /caddy-trust \
  && install -o node -g node -m 0600 /dev/null /run/agent-teams-oidc/oidc-client-secret \
  && install -o node -g node -m 0600 /dev/null /caddy-trust/root.crt \
  && chmod 0555 /usr/local/bin/hosted-volume-init /usr/local/bin/hosted-entrypoint

ENV NODE_ENV=production
ENV CLAUDE_ROOT=/data/.claude
ENV HOST=0.0.0.0
ENV PORT=3456
ENV AUTH_DATA_DIR=/data/.agent-teams/data
ENV PAIRING_CODE_FILE=/run/agent-teams/pairing.json
ENV AUTH_CONTROL_SOCKET=/run/agent-teams/control.sock
ENV AUTH_DRAIN_EVIDENCE_FILE=/run/agent-teams/drain-proof.json

USER node

EXPOSE 3456

ENTRYPOINT ["/usr/local/bin/hosted-entrypoint"]
CMD ["/usr/local/bin/node", "/app/dist-standalone/index.cjs"]
