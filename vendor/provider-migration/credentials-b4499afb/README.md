# Native V2 keys and finite Claude sessions

Immutable provider source [b4499afb7a48c4efb67e4a494690aca0921672ef](https://github.com/agent-teams-ai/old-provider-implementations/commit/b4499afb7a48c4efb67e4a494690aca0921672ef), [source PR #8](https://github.com/agent-teams-ai/old-provider-implementations/pull/8).

This is the exact retained archive from the existing packed-consumer check on Node 26.11.1 / pnpm 11.18.0. The combined source passed full `pnpm check` on Node 24.21.0 and 26.11.1 with pnpm 11.18.0. The archive was not edited after packing.

Provider archive SHA-256: `659039aad0693903555be363ce055bf0c50864b385486f8313f6f3b6600a1cc2`. The neutral Session SPI remains byte-identical at its existing frontend pin.

The source adds the pinned OpenCode 2.1.4 integration key client with bounded request/cleanup ownership, exact native readback and rollback of only its observed new credential. Claude can explicitly opt out of native session persistence and checkpoint/restore for finite Host runs. Omission preserves the previous default and compatibility digest.

The source receipt lists every changed archive member and the verified official OpenCode client reference. Source and packed-consumer checks do not qualify native Host, credential publication, scheduled model execution or packaged Electron. Those integration gates remain required on the combined frontend head.
