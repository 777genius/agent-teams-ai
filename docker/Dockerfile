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
  && apt-get install -y --no-install-recommends chromium python3 make g++ \
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
  && node scripts/ci/hosted-browser-event-stream-runtime-proof.mjs --root /app \
  && node scripts/ci/hosted-browser-event-stream-runtime-negative-controls.mjs /app \
  && pnpm exec tsx scripts/hosted-web/seed-official-opencode-runtime.ts \
  && mkdir -p /app/bin \
  && node scripts/hosted-web/build-instance-lock.mjs \
    --output /app/bin/agent-teams-instance-lock

# =============================================================================
# Agent team-tools MCP bundle for host-local agents
#
# It never runs in this container: the host launcher copies it out of the same
# Product image digest, so MCP and Product versions always match.
# =============================================================================
FROM base AS mcp-builder

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY patches ./patches
COPY vendor/terminal-platform/sdk ./vendor/terminal-platform/sdk
COPY vendor/terminal-platform/terminal-platform-node-stub ./vendor/terminal-platform/terminal-platform-node-stub
COPY agent-teams-controller/package.json ./agent-teams-controller/package.json
COPY mcp-server/package.json ./mcp-server/package.json
RUN pnpm install --frozen-lockfile --ignore-scripts --filter agent-teams-mcp...

# Sources only: a host node_modules or dist must not replace the installed tree.
COPY agent-teams-controller/src ./agent-teams-controller/src
COPY mcp-server/src ./mcp-server/src
COPY mcp-server/tsconfig.json mcp-server/tsup.config.ts ./mcp-server/
COPY scripts/hosted-web/build-agent-teams-mcp-artifact.mjs ./scripts/hosted-web/
RUN node scripts/hosted-web/build-agent-teams-mcp-artifact.mjs

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
COPY scripts/ci/verify-hosted-no-terminal-artifact.mjs scripts/ci/hosted-browser-event-stream-proof.mjs scripts/ci/hosted-browser-event-stream-proof-graph.mjs scripts/ci/hosted-browser-event-stream-proof-html.mjs scripts/ci/hosted-browser-event-stream-proof-syntax.mjs /app/scripts/ci/
RUN pnpm install --frozen-lockfile --prod --ignore-scripts \
  && pnpm rebuild better-sqlite3 \
  && node /app/scripts/ci/verify-hosted-no-terminal-artifact.mjs --root /app --prune --require-better-sqlite3

# =============================================================================
# Production stage - minimal image with only runtime dependencies and built output
# =============================================================================
FROM base

COPY --from=prod-deps /app/package.json ./
COPY --from=prod-deps /app/node_modules ./node_modules
RUN rm -f /app/node_modules/agent-teams-controller
COPY --from=builder /app/agent-teams-controller ./node_modules/agent-teams-controller
COPY --from=builder /app/bin/agent-teams-instance-lock ./bin/agent-teams-instance-lock
COPY --from=mcp-builder /app/mcp-server/dist/index.js /app/mcp-server/dist/index.js.sha256 ./agent-teams-mcp/

# Copy built standalone server and renderer output
COPY --from=builder /app/dist-standalone ./dist-standalone
COPY --from=builder /app/out/renderer ./out/renderer
COPY --from=builder /app/opencode-hosted-runtime.lock.json ./opencode-hosted-runtime.lock.json
COPY --from=builder /app/official-opencode-runtime ./official-opencode-runtime
COPY scripts/hosted-auth-cli.mjs ./scripts/hosted-auth-cli.mjs
# Keep the one-shot recovery CLI and its descriptor-bound I/O module together.
# The production dependency layer already contains its native better-sqlite3 driver.
COPY scripts/hosted-web/phase-10/state-compatibility/stopped-stack-recovery.mjs scripts/hosted-web/phase-10/state-compatibility/recovery-descriptor-io.mjs ./scripts/hosted-web/phase-10/state-compatibility/
COPY scripts/ci/verify-hosted-no-terminal-artifact.mjs scripts/ci/hosted-browser-event-stream-proof.mjs scripts/ci/hosted-browser-event-stream-proof-graph.mjs scripts/ci/hosted-browser-event-stream-proof-html.mjs scripts/ci/hosted-browser-event-stream-proof-syntax.mjs /app/scripts/ci/
COPY docker/hosted-volume-init.sh /usr/local/bin/hosted-volume-init
COPY docker/hosted-entrypoint.sh /usr/local/bin/hosted-entrypoint

# Create data directory for Claude session mount
RUN test -f /app/dist-standalone/index.cjs \
  && test -s /app/opencode-hosted-runtime.lock.json \
  && test -s /app/official-opencode-runtime/opencode-linux-$(node -p 'process.arch').tar.gz \
  && test "$(stat -c '%u:%g:%a' /app/official-opencode-runtime/opencode-linux-$(node -p 'process.arch').tar.gz)" = '0:0:444' \
  && test -s /app/dist-standalone/state-compatibility/manifest.json \
  && test -s /app/dist-standalone/state-compatibility/manifest.json.sha256 \
  && test -f /app/dist-standalone/assets/internal-storage-worker.cjs \
  && (cd /app/agent-teams-mcp && sha256sum -c --strict index.js.sha256) \
  && chown -R root:root /app/agent-teams-mcp \
  && chmod 0444 /app/agent-teams-mcp/index.js /app/agent-teams-mcp/index.js.sha256 \
  && chmod 0555 /app/agent-teams-mcp \
  && node -e "require.resolve('agent-teams-controller')" \
  && node --check /app/scripts/hosted-web/phase-10/state-compatibility/stopped-stack-recovery.mjs \
  && node --check /app/scripts/hosted-web/phase-10/state-compatibility/recovery-descriptor-io.mjs \
  && node --input-type=module -e "await import('/app/scripts/hosted-web/phase-10/state-compatibility/stopped-stack-recovery.mjs'); const { default: Database } = await import('better-sqlite3'); const database = new Database(':memory:'); if (database.pragma('integrity_check', { simple: true }) !== 'ok') process.exit(1); database.close()" \
  && node /app/scripts/ci/verify-hosted-no-terminal-artifact.mjs --root /app --require-better-sqlite3 --require-hosted-renderer-graph \
  && rm -r /app/scripts/ci \
  && mkdir -p /data/.claude /data/.agent-teams/data /data/.agent-teams/instance-lock /run/agent-teams /run/agent-teams-oidc /run/agent-teams-lifecycle-trust /caddy-trust /var/lib/agent-teams/lifecycle-owner-high-water \
  && install -o root -g root -m 0444 /dev/null /data/.agent-teams/instance-lock/instance.lock \
  && chown root:root /app/bin/agent-teams-instance-lock /data/.agent-teams/instance-lock \
  && chown root:node /data/.agent-teams \
  && chown node:node /data/.agent-teams/data \
  && chmod 0555 /app/bin/agent-teams-instance-lock /data/.agent-teams/instance-lock \
  && chmod 1770 /data/.agent-teams \
  && chmod 0700 /data/.agent-teams/data \
  && test -z "$(ls -A /data/.agent-teams/data)" \
  && chown node:node /run/agent-teams /run/agent-teams-oidc /run/agent-teams-lifecycle-trust /caddy-trust /var/lib/agent-teams/lifecycle-owner-high-water \
  && chmod 700 /run/agent-teams /run/agent-teams-oidc /run/agent-teams-lifecycle-trust /caddy-trust /var/lib/agent-teams/lifecycle-owner-high-water \
  && install -o node -g node -m 0600 /dev/null /run/agent-teams-oidc/oidc-client-secret \
  && install -o node -g node -m 0600 /dev/null /run/agent-teams-lifecycle-trust/trust-anchor \
  && install -o node -g node -m 0600 /dev/null /run/agent-teams-lifecycle-trust/release-owner-pin.json \
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
ENV HOSTED_LIFECYCLE_ORCHESTRATOR_HIGH_WATER_ROOT=/var/lib/agent-teams/lifecycle-owner-high-water

USER node

EXPOSE 3456

ENTRYPOINT ["/usr/local/bin/hosted-entrypoint"]
CMD ["/usr/local/bin/node", "/app/dist-standalone/index.cjs"]
