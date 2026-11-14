# Checked provider archive — 68dca527

Source: [provider PR #8](https://github.com/agent-teams-ai/old-provider-implementations/pull/8), commit `68dca527b779ebb82923f30d7b08441085d8b579`.

This archive includes the preceding OpenCode model-variant and legacy Claude checkpoint corrections. It accepts nullable Codex ChatGPT email and explicitly refuses `humanCommand` and unknown approval kinds before applying automatic approval policy. The Host does not negotiate human-approval capability. Official Codex 0.162.0 and 0.169.0 schemas informed this finite compatibility correction; no real Codex process was executed.

[Exact-source CI](https://github.com/agent-teams-ai/old-provider-implementations/actions/runs/43479531998) completed full source, type and packed-consumer checks on Node 24.21.0 and 26.11.1 with pnpm 11.18.0. These bytes were extracted from checked artifact 14062879890. The ZIP digest, source receipt, both package digests and equality with the independently built local archive were verified.

Provider package: 177100 bytes; SHA-256 `07241cca756e69aa6001df41d6a7408aad5d8ab4c8277f9d70f35d0d66736c73`. Session contracts retain the existing byte-identical archive. Historical archives and receipts remain unchanged.

This is source and packed-consumer qualification. Host/IPC/desktop acceptance records its separate results with protocol emulators. Vendor authentication and native inference are not claimed.
