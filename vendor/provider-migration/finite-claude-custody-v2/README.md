# Claude Session cleanup ordering

Immutable provider build input from the isolated `runtime-provider-legacy-host`
worktree. Its source remains the single editable owner.

| Archive | SHA-256 |
| --- | --- |
| `agent-teams-provider-implementations-0.0.0.tgz` | `6c3561b0005e344876b52679aa3c929738b38a694674a5f39984d01fe6f7ecc0` |

Only Claude `session.js` and `session.d.ts` differ from v1 (209 archive files).
Session close seals inputs/interactions, asks the original process owner to stop
before SDK EOF/close/iterator teardown, and joins concurrent closes. False,
throwing or timed-out cleanup remains unknown; timeout is not physical stop proof.
The existing output-limit shutdown uses the same close path. No owner, permission,
stop budget, SDK version or public Session SPI changed.

Controlled ordering regressions: four original failures, four passes after the
fix; actual provider Claude suite 91/91 and strict TS7 pass. Live Desktop and
packed qualification are separate. The Session SPI stays the exact v1 archive
with SHA256 `2a6e0e2cc61d7513b6de352d5cc7e2dba6ade8749e76fb4558520b1ea99bbf2e`.
