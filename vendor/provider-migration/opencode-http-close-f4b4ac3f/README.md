# Checked provider archive — f4b4ac3f

Immutable source [f4b4ac3f6fa4284091aca333e114778a8e84acd7](https://github.com/agent-teams-ai/old-provider-implementations/commit/f4b4ac3f6fa4284091aca333e114778a8e84acd7), [source PR #8](https://github.com/agent-teams-ai/old-provider-implementations/pull/8).

This candidate includes the Claude native command catalog correction and the fixed `Connection: close` header in OpenCode V2's existing execution, control, and credential HTTP transports. It preserves complete response-body consumption, original mutation admission, and the existing no-replay handling of uncertain writes.

The official [source and packed-consumer checks](https://github.com/agent-teams-ai/old-provider-implementations/actions/runs/43358959567) passed on Node 24.21.0 and 26.11.1 with pnpm 11.18.0. The retained package comes from the Node 24 checked artifact `14007975151`; `source-receipt.json` records its source, exact sizes, hashes, and integrity values.

Provider archive: `agent-teams-provider-implementations-0.0.0.tgz`, 174003 bytes, SHA-256 `73c7034aef1283ee694114d2a31d12383370286b45c18120958ca0edef789957`.

The session-contracts archive remains byte-identical to the existing pin (`aaf9506473f6a2868a375a6087e1b4edc561b38f34101ef7a8703a73bb2674db`). Existing provider archives and historical fixture inputs remain retained at their original paths.

Qualification is source and packed consumer only. Frontend native Bun, Host, Desktop, and packaged Electron acceptance are recorded by their own exact-candidate checks; this receipt does not certify those gates.
