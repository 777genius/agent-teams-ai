# Codex account login protocol

Immutable provider source [09c2859f932be6eeb6fe26289bb997d8e0a81289](https://github.com/agent-teams-ai/old-provider-implementations/commit/09c2859f932be6eeb6fe26289bb997d8e0a81289), [source PR #8](https://github.com/agent-teams-ai/old-provider-implementations/pull/8).

The archive is the exact retained output of the existing packed-consumer check on Node 24.21.0 / pnpm 11.18.0. Both exact CI Node versions (24.21.0 and 26.11.1) passed `pnpm check`: build, typecheck, 509 source tests and both packed consumers. No vendored dist or archive bytes were edited.

Provider archive SHA-256: `691a7a62cdd5a92e2edb120f2c409790c9ca16215495cdf9daa099b3b8748bd9`. The neutral Session SPI archive remains byte-identical and keeps its prior frontend pin.

Compared with the prior frontend provider archive, only the typed Codex login codec, client methods and type exports change (four changed files, two additions, no removals). `source-receipt.json` records the exact recipe and hashes; `baseline-comparison.json` records the payload comparison.

This proves source/package compatibility only. Native vendor authentication, Host lifecycle, Desktop controls and packaged acceptance require the frontend P01/P10 checks on the integrated SHA. No earlier native PASS is reassigned to these bytes.
