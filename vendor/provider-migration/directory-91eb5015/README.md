# Native provider inventory and finite Codex threads

Immutable provider source [91eb501568286b4c99135271c88f335a6136928b](https://github.com/agent-teams-ai/old-provider-implementations/commit/91eb501568286b4c99135271c88f335a6136928b), [source PR #8](https://github.com/agent-teams-ai/old-provider-implementations/pull/8).

This is the exact archive installed and retained by the existing packed-consumer check on Node 26.11.1 / pnpm 11.18.0. The combined source passed full `pnpm check` on Node 24.21.0 and 26.11.1. No archive bytes were edited.

Provider archive SHA-256: `9ec9000471ce7beb1d8e2501f361a5d4d9d9c25465dacf99bda506105d1eb739`. The neutral Session SPI keeps its byte-identical existing pin.

OpenCode V2 exposes a bounded native provider/model/integration directory using four existing GETs, without configuration, headers, connection records or key values. The selected-model catalog retains validated variant IDs. Codex admits the selected boolean `ephemeral` field under its existing captured MCP policy, preserving the policy checks. The pinned native 0.162.0 stable ThreadStartParams supports that field; a controlled transport verifies it reaches thread/start.

These are source and installed-package results. The existing native SPI harness now checks real OpenCode directory and private-account witness behavior; actual Host, scheduled model execution and Desktop qualification remain separate required gates.
