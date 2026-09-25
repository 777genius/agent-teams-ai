# Hosted Core v1 live sandbox driver

This runner accepts only Linux x64 root on a disposable Docker host. It creates a new
workspace under `/tmp/hosted-core-issuer-*`, runs the **production** Product/Caddy Compose
services with signed external Owner admission, and drives Chromium against the HTTPS UI.
It never selects an existing user project. The Owner image is built from an exact clean
Owner commit and remains separate from the Product image.

Required environment:

- `CORE_LIVE_OWNER_REPO`: clean absolute Owner checkout at `CORE_LIVE_OWNER_COMMIT`.
- `CORE_LIVE_OWNER_COMMIT`: reviewed 40-hex Owner SHA.
- `CORE_LIVE_REGISTRY_IMAGE`: digest-pinned `registry:2` image.
- `CORE_LIVE_BUN_IMAGE`: digest-pinned `oven/bun:<owner packageManager version>` image.
- `CORE_LIVE_OPENCODE_BINARY`: official Linux x64 OpenCode v1.18.32 executable. The issuer
  verifies its SHA-256 against `513f500a1a5ea1dc7d865547ac87b32a8936334e8d5abd5b3ff585c45a170080`.
- `CORE_LIVE_LOCAL_PROVIDER_BASE_URL`: test-only, reachable loopback OpenAI-compatible
  endpoint (`http://127.0.0.1:<port>/v1`) serving `qwen3-8b`.
- `CORE_LIVE_AGENT_TEAMS_MCP_ENTRY`, `CORE_LIVE_AGENT_TEAMS_MCP_SHA256`: the agent team-tools
  MCP bundle for host-local agents. Build it from this checkout with
  `node scripts/hosted-web/build-agent-teams-mcp-artifact.mjs`, which prints `{entry, sha256}`
  (`mcp-server/dist/index.js` and its `.sha256`). The issuer stages the file root-owned
  next to a Node 24 binary taken from `node:<Dockerfile NODE_VERSION>-slim@NODE_IMAGE_DIGEST`,
  so the MCP never runs under whatever `node` is on the host PATH. The Product image ships
  the same build at `/app/agent-teams-mcp/index.js` (+ `.sha256`); the runner requires both
  it and the image's `/usr/local/bin/node` to match the staged bytes.
- `NODE_IMAGE_DIGEST`, `KEYCLOAK_IMAGE_DIGEST`, `CADDY_IMAGE_DIGEST`,
  `POSTGRES_IMAGE_DIGEST`: audited production Compose digests.
- `CORE_LIVE_EVIDENCE_DIR`: exact existing directory
  `/srv/worker-state/jobs/agent-teams-ai/hosted-web-v1/operator-evidence/core-live-20260924`.

Run `node scripts/e2e/hosted-v1-core-live/run.mjs` with these environment values.
The runner prints `core-live-evidence:<CORE_LIVE_EVIDENCE_DIR>/<unique-project>/evidence.json`.
It archives the source manifest, two screenshots, JSON evidence, and a sanitized
phase log there, then removes its unique `/tmp/hosted-core-live-*` scratch after
verified teardown. The archive is staged privately and published atomically;
`evidence.json` records `passed` only after teardown, archival and scratch removal
have succeeded. The durable directory must be root-owned mode `0700`; the runner
verifies the exact owner, mode and inode of every ancestor before archival.
Host supervisor UID 999/GID 987 can write an ancestor of this root-owned directory;
that supervisor is inside the trusted host boundary. Owner UID 1000/GID 1000 cannot
write the evidence directory. The driver rechecks ancestor custody before publishing.

A `passed` result requires the
created and published team, signed Owner rotation to its Product-issued ID,
browser-observed task/message completion, and a completed `local-llama/qwen3-8b`
assistant message in the official OpenCode SQLite session. The browser sends a fresh
`printf` command after launch; proof requires its file effect in the sandbox workspace,
a completed OpenCode shell tool receipt, and a later peer reply with the same nonce.
Incomplete runtime, command or provider evidence exits nonzero. Screenshots contain
only the new sandbox UI. The Product gets only the issuer's sandbox-project directory
bound at the same absolute host path used in Owner's signed workspace declaration.
Before each browser phase the runner compares Product's Docker bind and device/inode
with the host directory; a mismatched path cannot pass acceptance.
The evidence includes a SHA-256 manifest of all tracked and untracked, nonignored
Product source files, including this driver and the issuer. The manifest is checked
again after teardown. CPU, memory and host load are sampled at start and completion.

The runner tears down only its randomly named Compose project and issuer-owned
Owner/image state. If Docker cannot prove the Product stopped, it preserves the
Owner and marks cleanup incomplete in evidence for operator inspection. Any cleanup
failure vetoes `passed` and exits nonzero.
