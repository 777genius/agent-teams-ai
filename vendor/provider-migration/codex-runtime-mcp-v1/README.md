# Codex runtime MCP endpoint compatibility artifact

Immutable provider0.0.0 built from canonical standalone commit
[`7573a50842c3eeacb473f9d97d40f3ddf6ac0cf9`](https://github.com/agent-teams-ai/old-provider-implementations/commit/7573a50842c3eeacb473f9d97d40f3ddf6ac0cf9).
SHA-256: `e3a45cde75062840a74ac0b036b0ccc074654adfd5b46bf19e384eb62c34f3f3`.
Integrity: `sha512-449IqHZZm3Hv+Vjx5wGX0WzB309HO237efxtle0lESK/f8fFXzjT5VEICNI2IUuE4UcVIxTw3Lu5ZI1TR9PvZA==`.

Relative to retained `readonly-probe-metadata-v1`, only private Codex
`driver-config.js` and its declaration change. The archive retains 209 regular
files / 206 dist files, exact package metadata, dependencies and public exports.
All Claude/OpenCode bytes and Session SPI are unchanged.

The optional `runtimeMcpServer` driver-config selector allows only its selected
HTTP server URL to vary in checkpoint compatibility. The stable trusted binding,
selector, catalog, foreign policy, auth fields, tools and other configuration
remain exact. The live/native policy still verifies the actual current URL.
Without the selector, old compatibility bytes are preserved; opting in does not
implicitly migrate old unmarked checkpoints. Host lifecycle and authority remain
consumer-owned. No Team-specific provider logic or Session SPI change is added.

Full owning checks passed with pnpm11.18.0 on Node24.21.0 and26.11.1: 355 source
tests and both packed consumers on each runtime. Frontend isolated candidate
checks passed the complete 796-test Host unit gate. These are controlled package/
Host checks, not new native/Desktop, vendor-authentication, packed P7/M17 or
original M19 custody qualification. Old archives and evidence remain immutable.
