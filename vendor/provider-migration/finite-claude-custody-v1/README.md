# Finite Claude management cleanup

Selected Stage 1 provider packages. The provider source remains in the isolated
`runtime-provider-legacy-host` checkout; these archives are immutable build inputs.

| Archive | SHA-256 |
| --- | --- |
| `agent-teams-provider-implementations-0.0.0.tgz` | `066ab48bef0704f9e90e4aa2f12ddd86b607b4aedb70d98a29e4a26cfc0be36a` |
| `agent-teams-provider-session-contracts-0.0.0.tgz` | `2a6e0e2cc61d7513b6de352d5cc7e2dba6ade8749e76fb4558520b1ea99bbf2e` |

Only four archive members differ from `bounded-codex-questions-v1`: finite Claude
metadata/probe implementations and the native-management configuration JS/types.
The caller confirms its owned process cleanup before SDK input/iterator teardown;
false or failed cleanup remains an explicit failure. The provider adds no process
owner. SDK 0.3.305 and all registry dependency versions remain unchanged.

Focused provider tests pass (16/16); Desktop/Host integration is verified separately.
These archives alone do not establish complete Stage 1 or real authentication parity.
