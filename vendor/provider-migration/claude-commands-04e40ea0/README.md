# Captured Claude native commands

Immutable provider source [04e40ea05f93ca6fd1b73010d680f579ff14a9d0](https://github.com/agent-teams-ai/old-provider-implementations/commit/04e40ea05f93ca6fd1b73010d680f579ff14a9d0), [source PR #8](https://github.com/agent-teams-ai/old-provider-implementations/pull/8).

Exact checked-consumer archive retained on Node 24.21.0 / pnpm 11.18.0. Full `pnpm check` passed on Node 24.21.0 and 26.11.1. Archive bytes are unmodified; the neutral Session SPI stays byte-identical.

Provider SHA-256: `dc3c3d50ab47fe54985436e3647e85c62987dfce6fc11da58ecbe317d82d92ec`.

The optional private `observeCommands` callback projects bounded metadata from the same live SDK Query, including native aliases and subsequent command changes. Raw slash input is admitted only while its command still exists. Native local-command output requires the original echoed user UUID, matching command and successful result. The reserved output namespace cannot be forged by an ordinary assistant message. The Host remains responsible for actor and command policy; no Session SPI control method or second effect ledger is introduced.

Two focused tests cover changing metadata, alias precedence, disappearing commands and foreign or forged output. Actual native Host and Desktop qualification remain separate pending gates.
