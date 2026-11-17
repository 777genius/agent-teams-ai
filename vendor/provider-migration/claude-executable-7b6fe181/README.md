# Captured Claude executable selection

Immutable provider source [7b6fe18170ee51bf7d679a9ba85801963e07271a](https://github.com/agent-teams-ai/old-provider-implementations/commit/7b6fe18170ee51bf7d679a9ba85801963e07271a), [source PR #8](https://github.com/agent-teams-ai/old-provider-implementations/pull/8).

Exact checked-consumer archive retained on Node 24.21.0 / pnpm 11.18.0. Full `pnpm check` passed on Node 24.21.0 and 26.11.1. No archive bytes were edited; the neutral Session SPI stays byte-identical.

Provider SHA-256: `c035a09d5b6795e5f440b0d5ffef52d23604f31618232a36356c7133f63b11e6`.

The private Claude configuration now forwards the captured absolute `executablePath` to the actual SDK's `pathToClaudeCodeExecutable`. Existing callers that omit the field preserve their prior compatibility fingerprint; selecting a different path changes checkpoint compatibility. The Host still verifies the exact executable identity before launch.

This fixes the mismatch exposed by the genuine Linux SDK qualification: the SDK previously requested its bundled binary while custody required the explicitly selected private binary. The existing focused test observes the real SDK launch request without spawning a process. Native Host and packaged Electron qualification remain separate pending gates.
