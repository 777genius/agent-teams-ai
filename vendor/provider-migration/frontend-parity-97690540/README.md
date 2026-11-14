# Checked provider archive — 97690540

Source: [provider PR #8](https://github.com/agent-teams-ai/old-provider-implementations/pull/8), commit `976905403b40078c3c2cfae3c442d5ec91056fc2`.

This revision handles Codex configuration warnings and remote-control status as private connection observations. Malformed known notices still refuse the original connection and retain an unknown pending outcome. It adds no Session event, approval or replay.

[Source and packed CI 43510761520](https://github.com/agent-teams-ai/old-provider-implementations/actions/runs/43510761520) passed 525 source tests plus two packed consumers on each pinned Node version, 24.21.0 and 26.11.1. The original checked receipt remains unchanged beside this file.

Provider package: 178265 bytes; SHA-256 `73dbbfba5e8fed6719ccdeaae499a47284b72ac831c33a2c7206fbf2799f77b8`. ZIP: 185401 bytes; SHA-256 `f6c7f2a5d609e9ddf651b4cccffd83c7027e3d37c4560613e3d6a8537aaf90d9`. Both were independently rehashed. Contracts are byte-identical to the selected existing archive. The tar census changes only four Codex compiled files; Claude and OpenCode bytes are unchanged.

The separate OpenCode native SPI workflow passed its applicable checks on five operating systems, including expected-negative HOLD cases. Its receipts do not qualify frontend Host, packaged Electron or unsupported variants. Existing native qualification flags remain false; no actual Codex or Claude was run for this update.
