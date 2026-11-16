
### Original General CI terminal snapshots for c28, 76a, a02 and 3957 — evidence only

The four saved structured API snapshots below each contain exactly 15 distinct jobs for the stated source/run. Every job is terminal: 12 are `cancelled` and three are `skipped`; none is a PASS. These are job-status observations, not test counts or proof that a cancelled job performed no partial work. The records do not identify who initiated cancellation. No new API poll or workflow action was performed while preparing this appendix.

| Exact source head | General run | Snapshot UTC | Retained job statuses |
| --- | --- | --- | --- |
| `c28f1aa890c909c7b981254c5e30b874cbc84287` | `43759098083` | `2026-11-15T21:07:29Z` | 15 completed: 12 cancelled, 3 skipped |
| `76a227d283ee9ee4d55d894c2b5d11dde64453e3` | `43761509999` | `2026-11-15T21:18:44Z` | 15 completed: 12 cancelled, 3 skipped |
| `a02ab70edfdcb4169627e804f0337c9ad6b52af6` | `43762390594` | `2026-11-15T21:40:30Z` | 15 completed: 12 cancelled, 3 skipped |
| `3957f2b28417647578d71a465cd61d4e09b5deb9` | `43764802866` | `2026-11-15T21:49:49Z` | 15 completed: 12 cancelled, 3 skipped |

The three skipped rows in each snapshot are the existing Stage 1 process tuple diagnostic, source Desktop and current-tuple process/packed qualification jobs. All twelve remaining rows, including `plan` and `Full qualification`, retain their cancelled conclusions. No cancelled aggregate, missing log/step payload or skipped Stage 1 job is promoted to native/Desktop/general qualification. These historical snapshots do not establish the current 4dc cohort state.

Exact unmodified snapshot identities (each 4,846 bytes) are:

- `general-c28-terminal-jobs.json` — blob `c55b1dcaf6e77d3c8caa4f4efaec926765e1a323`, SHA256 `207ed30b651c9281a7b46ef90c3f65c5dd88aa0302ebd9b1448cb7c580c3e359`.
- `general-76-terminal-jobs.json` — blob `e7ac25bae843b9ce4b57dd0187234667d5b90ee4`, SHA256 `3a646585699932bbf91c2afa74573f5ed70a14a13a8b5cc59abeebfffb27c214`.
- `general-a02-terminal-jobs.json` — blob `daee3c336113b980f5f27dbaf7d6fbb6b82e68a4`, SHA256 `4080f8990048651cca324363ec08ad5c8c5618731921cb442875d1c0afa55883`.
- `general-3957-terminal-jobs.json` — blob `4be7ecc053fc5a71d1a690a29c29f8bb5d470be9`, SHA256 `c131d766c204b9f1f9ff47b739f050258bdf7aae00ffbeb66ef9806e3005d531`.

Publish those exact files with the accompanying explicit path inventory. Preserve all earlier queued/running observations as their historical snapshots; these later terminal records refine their disposition without changing source-bound failures, prerequisites, Draft/base policy or remaining resulting-source acceptance. The remaining c28/76 cancelled-partial artifact checkpoint is not yet independently ready and is deferred to a later evidence-only publication; it is not implied by these General metadata records.
