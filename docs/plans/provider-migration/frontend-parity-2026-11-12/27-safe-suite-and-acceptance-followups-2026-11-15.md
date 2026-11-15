# Completed safe frontend suite and acceptance follow-ups

## Frozen evidence and publication scope

This evidence cut records actual CI for completion source
`32c2af517766f86116b4b6441e686e493ad1c9c8` on Draft PR #1192.
The independently published documentation commit
`93e4d174eed9679aad8fbfb7807a783a30b586c0` adds plans 25 and 26 and changes
no executable source. This cut preserves those documents and their ancestry;
their proposed integration and verification are not treated as completed by
this report.

The current parent PR #1186 remains
`def734338f13bcc3209e78079a0cedbc48f05a5b`.
The checked provider source remains
`421fee918811b8a0b0c73d0ff3e761b9a1c5ecb0`, with checked archive SHA-256
`91350f829b72f83e613505bb444ff0d9ef98fb0835e3e438b918bbea8d930f94`.
No provider archive, production process owner, native oracle or launch deadline
changes in this acceptance follow-up.

## Full safe frontend suite completed

All four jobs of the existing frozen safe suite completed successfully on 32c2.
These are complete CI processes with final Vitest footers, not the earlier
interrupted local processes. The workspace runner is Node 26.12.1; the captured
Host remains Node 24.21.0.

| Shard | Original job | Files passed / skipped | Tests passed / skipped |
| --- | --- | --- | --- |
| 1 | [132623749792](https://github.com/777genius/agent-teams-ai/actions/runs/43652467156/job/132623749792) | 537 / 0 | 6,168 / 6 |
| 2 | [132623749763](https://github.com/777genius/agent-teams-ai/actions/runs/43652467156/job/132623749763) | 535 / 2 | 6,662 / 18 |
| 3 | [132623749826](https://github.com/777genius/agent-teams-ai/actions/runs/43652467156/job/132623749826) | 534 / 3 | 6,135 / 7 |
| 4 | [132623749614](https://github.com/777genius/agent-teams-ai/actions/runs/43652467156/job/132623749614) | 534 / 2 | 6,552 / 7 |
| Total | Four complete, disjoint shards | 2,140 / 7 | 25,517 / 38 |

There are 2,147 files and 25,555 tests in the complete inventory, zero failed
files and zero failed tests. Both independent reviewers inspected the decoded
final logs. This closes the earlier uncertainty about the interrupted full
local sweep for this exact source. It does not qualify changed source bytes,
Desktop UI, native custody, or the complete PR aggregate.

## Desktop results on 32c2

[Original Desktop workflow](https://github.com/777genius/agent-teams-ai/actions/runs/43652467156).

| Original lane | Job | Result and first relevant finding |
| --- | --- | --- |
| Codex login | 132623749710 | PASS |
| Taskboard | 132623749759 | PASS |
| Review | 132623749848 | PASS, including the job's final cleanup assertions |
| Processes | 132623749869 | PASS, including the job's final cleanup assertions |
| OpenCode runtime | 132623749715 | FAIL: no sole runtime capture after original Launch |
| Saved import | 132623749758 | FAIL: saved model preflight did not become ready |
| Collaboration | 132623749769 | FAIL: driver required visible Add text on the original icon button |
| Extensions | 132623749812 | FAIL: finite wrapper rejected the original auth status request |
| Team | 132623749844 | FAIL: JSON test-table inference introduced an optional undefined during workspace types |
| V2 management | 132623749862 | FAIL: driver used the former provider accordion ID |
| Codex installer | 132623749870 | FAIL: original first getStatus rejected; cause not established by retained console data |
| Codex runtime | 132623749871 | FAIL: complete local cost report visibility not established |
| Skills | 132623749878 | FAIL: created card center was not hittable; missing reveal step found in the driver |
| Claude lifecycle | 132623749885 | FAIL: original single-holder CDP assertion |
| Management | 132623749908 | FAIL: two holders of the same original CDP listener |
| Cross-Team | 132623749909 | Initial Taskboard journey PASS; required owner-routing continuation FAIL at CDP ownership |
| Source selection | 132623749938 | FAIL: original single-holder CDP assertion |
| Claude runtime | 132623750048 | FAIL: original completed standalone history row not hittable after expansion |

The four passed jobs are actual job conclusions. The latest artifact ZIPs were
not independently downloaded or visually inspected after the executor became
unavailable. GitHub's upload metadata/digests are available; they are not a
substitute for an independent byte digest or screenshot review.

## Reviewed source corrections

- Contextually type the two existing runtime metadata fixtures as `JsonValue[]`.
  Preserve both original cases and every production schema.
- Select the original collaboration Add button by its existing `aria-label`.
  Use the actual provider directory IDs for both V2 selection controls.
- Admit only `auth status --json` in the existing isolated finite Extensions
  peer. Exercise it through the original authentication coordinator and reject
  login, logout and extra arguments. Do not claim real vendor authentication.
- Retain the original plugin inventory read and record its actual synchronous
  child PID, executable digest and parent. Verify this single read is the
  original harness child; all other provider births must remain original Host
  children. Every observed child remains in the cleanup census.
- Admit the finite Codex standalone empty MCP policy only without Team
  credentials. Require its original ephemeral thread before status or input,
  return the required empty MCP status, and refuse foreign thread IDs.
  Regression tests exercise the actual child and the original provider policy
  encoder, terminal result and no-MCP/no-tool effects.
- Load the existing MCP SDK only when the finite peer actually connects to MCP.
  The short version/catalog paths retain their original commands, output,
  process counts, authorization checks and deadlines. Any Windows ARM timing
  benefit remains unproved until native CI.
- Resolve the packaged embedded Host admission module dynamically from the same
  selected verified package closure as the other existing Host imports.
  This avoids initializing its CommonJS controller dependency relative to a
  relocated TEST harness after the original source has been hidden.
  It introduces no source fallback or packaging allowlist exception.
- Locate the Codex cost card by the canonical receipt message ID, expand its
  original header if collapsed, and use the existing complete-body visibility
  assertion. Reveal the original Claude completed-run row and exact Skills card
  with ordinary bounded wheel input before their original hit-tested clicks.
  Missing physical reveal is source-supported; the exact failing viewport was
  not inferred as an independently inspected screenshot.

## Passive diagnostics for unresolved failures

These additions observe the existing failing operation; they do not retry a
business mutation, increase a deadline or change an acceptance result.

- Windows source preparation records the original owner/witness/complete phase
  and whether the root and witness were captured. Standalone completion logs
  only the last existing phase, cleanup and exit-code observations.
- CDP failure correlation classifies the already-read command-line completeness
  and executable basename into closed categories. It publishes them only after
  the existing birth/socket fence, preserves the original failed census
  byte-for-byte, and never admits the second holder. The required owner-routing
  continuation now prints the same bounded original failure projection.
- The installer failure projects a closed error class/code and a fixed allowlist
  of existing public status errors. It rethrows the original error and adds no
  status call, retries or timing budget.
- Failed saved-import/OpenCode readiness summaries project only fixed terms,
  booleans, phases and bounded counts from existing retained snapshots. They
  expose no raw dialog/error text, inputs, paths, URLs, arguments or credentials.
  One regression checks privacy, no getter execution, mode gating and overflow.
- The native V2 credentials fixture emits its already-written failure receipt
  through the existing bounded diagnostic helper. Unknown cleanup and the
  original Host exit failure remain failures.

## Platform and packaged evidence

[Host process workflow](https://github.com/777genius/agent-teams-ai/actions/runs/43652467278):
Linux x64, Darwin x64 and Darwin ARM64 jobs PASS. Windows x64 and ARM64 FAIL.
On x64, A/B readiness and B management/probe passed, then the standalone path
failed. On ARM64, original Team-A readiness exceeded its existing 15-second
budget; cleanup subsequently lacked a root or witness. This is not confirmed
cleanup and the new diagnostic is not itself a fix.

[OpenCode V2 workflow](https://github.com/777genius/agent-teams-ai/actions/runs/43652467204):
both Windows embedded Host jobs PASS; both static jobs, the native V2.0.21 SPI
job and the published durable-HTTP discovery job PASS. The latter is not a
Host/model certificate. Linux's main embedded business journey and no-tool
catalog/model-probe cases passed, then the credentials recovery fixture failed
because the original Host exited 1 after deliberate verification timeout.
Darwin jobs retain the unresolved executable-image/script-consumption gate.

[Packaged workflow](https://github.com/777genius/agent-teams-ai/actions/runs/43652467187):
Darwin ARM64 reached actual packaged Host qualification and failed because the
relocated bundled harness could not resolve `agent-teams-controller`. The
selected-closure import correction above addresses that source-proven cause.
The other four platform jobs and the final gate were cancelled by the external
documentation update before completing. General CI was also cancelled.
Cancelled or queued jobs are not passed checks.

## Verification required for this follow-up

The offline executor prevented local compilation, lint or execution of these
new edits. The fixes and negative cases were reviewed against immutable source
by separate owners. There is no claimed local PASS for this follow-up.
Original CI must execute the exact newly published head, including workspace
types, typed lint, affected finite child tests, all Desktop journeys and native
Windows/platform gates. The full safe suite on 32c2 remains prior-source evidence.

Real Codex and Claude Code remain prohibited, including version commands and
localhost inference. Finite peers and actual Host/Main/Electron in disposable
TEST state are allowed; OpenCode can use local/free inference. Keep PR #1192
Draft. No main merge, release, default activation or Stage 2 advancement.
P09 section 75 remains an unresolved authority/compatibility boundary; no
successful business journey, diagnostic or process absence converts its
original failed native oracle or unknown cleanup into PASS.
