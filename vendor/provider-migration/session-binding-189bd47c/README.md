# Selected tool rules and native account binding

Immutable provider source [189bd47ccd33edd9d5abedf7075f3e53dd38bb42](https://github.com/agent-teams-ai/old-provider-implementations/commit/189bd47ccd33edd9d5abedf7075f3e53dd38bb42), [source PR #8](https://github.com/agent-teams-ai/old-provider-implementations/pull/8).

This is the exact retained archive installed by the packed-consumer check on Node 26.11.1 / pnpm 11.18.0. The combined source passed full `pnpm check` on Node 24.21.0 and 26.11.1 with pnpm 11.18.0. The archive was not edited after packing.

Provider archive SHA-256: `cbd2b267b97f9ae758dfeb2fff8d02e2ef31ca31dfe4bbf0aca1fb428638b13a`. The neutral Session SPI remains byte-identical at its existing frontend pin.

Claude accepts selected, bounded `disallowedTools` through the SDK configuration, including immutable snapshots and checkpoint compatibility. Generic argv cannot override this policy. OpenCode V2 carries only the selected account equality witness in native session metadata. Create/readback compare the exact witness; arbitrary metadata stays unavailable. The exact native 2.1.4 source persists metadata separately from model requests. Its actual cold/native qualification harness now asserts that the witness survives restart and never appears in inference requests. The native catalog also retains the model's tools capability for existing connection/model selection behavior.

The receipt lists every changed archive member and the verified official OpenCode core reference. Source and packed-consumer checks are not native Host or packaged Electron qualification. Native account operations, scheduling and Desktop checks remain required on the combined frontend commit.
