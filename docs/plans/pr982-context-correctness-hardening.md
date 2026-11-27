# PR #982: context and usage correctness

## Scope

Repair the existing behavior in `feat/provider-migration-stage-1` without adding
MCP tools, changing provider contracts, updating pinned provider archives, or
introducing a new usage analytics subsystem. The reviewed starting tree is
`38bb47e53a80c697d29fccc41d63597c19475ea2` (published head
`dee94bf14ddbe81143ed2c3c9029a74e66158e1e`). Keep the PR open and unmerged.

## Changes and estimates

Estimates are changed production lines and regression-test lines, not total file
sizes. Scores are out of 10; higher complexity means more difficult, while higher
confidence/reliability means stronger evidence. Reliability is a target until
the validation below is complete.

| Existing defect                                                               | Minimal correction                                                                                                            | Production / tests | Complexity | Confidence | Reliability target |
| ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | -----------------: | ---------: | ---------: | -----------------: |
| A large task board blocks the next input after compaction                     | Replace only oversized advisory board/roster snapshots with existing canonical read instructions; keep mandatory rules intact |   80–160 / 160–240 |          5 |          8 |                  9 |
| The 128 retained context epochs become a lifetime limit                       | Retire only represented epochs, preserving exact durable proofs and duplicate/conflict detection                              |  180–300 / 220–320 |          7 |          8 |                  9 |
| Bootstrap clipping can lose both operating context and its truncation warning | Reserve an indivisible recovery instruction within the existing budget and retrieve complete context only after readiness     |   80–130 / 100–180 |          4 |          9 |                  9 |
| Raw Codex usage counts cached input twice                                     | Normalize raw inclusive input separately from canonical disjoint input; preserve stable ledger identities                     |    25–45 / 100–180 |          3 |          9 |                  9 |
| Host statistics present Codex's last usage slice as a complete aggregate      | Mark unavailable aggregates explicitly using captured source identity, including retained historical events                   |    35–55 / 120–180 |          5 |          8 |                  9 |
| An oversized Codex log looks like an empty, successfully refreshed source     | Use the existing degraded-refresh path and preserve the last successful usage timestamp and ledger                            |      10–20 / 30–60 |          3 |          9 |                  9 |

## Invariants

- The immutable admitted input, binding, operation identity and preparation
  fingerprints remain unchanged. Recovery must never create a second native
  submit or an additional model turn.
- An epoch can leave the bounded active list only after its representation is
  durably recorded. Exact duplicate observations remain idempotent; conflicting,
  corrupt or missing proof material must hold safely.
- A crash between archive persistence and active-state persistence is recoverable
  without accepting a different proof or dropping a pending epoch.
- One proof covering 120–128 resets must not overflow the unchanged 1 MiB Team
  state limit. Retirement also responds to byte pressure, and candidate-only
  state can reconcile with a represented archive only through the exact original
  Runtime proof, never through ordinary observation or validation.
- Standing prompts, roles, workflows and action-mode restrictions are never
  silently truncated. The small-context reminder stays compatible.
- Bootstrap recovery does not prove readiness, start work during bootstrap, or
  change task completion/message delivery semantics.
- Raw Codex inclusive usage and canonical assistant disjoint usage remain
  distinct. Reimport replaces the same ledger event rather than duplicating it.
- An oversized source marks the existing refresh as degraded; it must not advance
  the successful usage timestamp or erase previously imported usage.
- Provider classification follows the captured runtime lineage, not the current
  provider of a reused member name. Claude statistics and known costs survive.

## Deliberate boundaries

A saved mandatory prompt/workflow can itself exceed the existing 64 KiB reminder
budget. Current paged Team reads do not expose all saved standing instructions.
Until a complete bounded recovery route exists, this case must continue to hold
explicitly instead of silently dropping instructions. The board fallback does
not claim to fix this separate capacity mismatch.

The pinned Codex adapter does not expose enough information to reconstruct
reliable cumulative input/output totals. This patch must show incomplete data
rather than invent totals or modify the external provider contract.

Existing bad ledger rows are corrected when their original JSONL is successfully
reimported. Missing or oversized source logs cannot be safely reconstructed from
the old metadata. Previously published command receipts remain immutable.

MCP response slimming, role-specific tool catalogs, new task-detail views,
broader reasoning-token chart semantics, and performance optimizations belong to
separate work. No stacked optimization PR is required for these corrections.

## Review and verification

1. Review the proposed recovery/retention design independently before editing.
2. Add targeted failing regressions for the confirmed defects.
3. Review the exact patch for crash recovery, multi-epoch proofs, identity reuse,
   historical source classification, Unicode boundaries and byte/character caps.
4. Build with pinned Node 24.21.0 and native TypeScript 7.0.2; run affected Host
   tests, bootstrap/importer tests, type checks, lint and applicable source guards.
5. Recheck the live PR head before publishing. Publish only the reviewed changes
   to the existing PR branch using a non-forced update with an expected-head
   lease; preserve concurrent changes.

All fixtures use isolated TEST data. Native provider launches and full desktop
E2E qualification are outside this local regression pass; do not report them as
passing without corresponding evidence.

## Results

The initial correction kept public APIs, provider pins, dependencies and compiler
options unchanged. Independent reviews covered the context-retirement protocol, bootstrap
recovery instructions and Codex accounting/provider lineage. Root review also
found and corrected the 120/128-epoch single-proof byte-pressure failure and
removed unnecessary roster-history pagination from the recovery instruction.

Completed checks on Node 24.21.0 / TypeScript 7.0.2:

- Host production build passed, including the task-change-ledger prerequisite.
- Bootstrap/native/OpenCode focused cohort: 22 tests passed.
- Codex importer, real JSON ledger and analytics service: 32 tests passed.
- Context recovery/retention, activity reads, session history and the corrected
  OpenCode fixture suites passed their focused executions. Coverage includes real
  filesystem persistence, cold reads and injected partial publication failures.
- A strict, affected-file typecheck of all six changed Host test files and their
  transitive dependencies passed using the unchanged project compiler options.
- Fast lint, targeted formatting, diff whitespace, source-size, provisioning
  architecture and runtime-artifact checks passed.

The broad Host Node run reported 1,847 passing tests, two existing skips, and two
test-file workers that failed without assertion diagnostics. A serial TAP
recheck passed all 16 group-chat tests; the Team-snapshot worker was terminated
with `SIGKILL`. This is not a successful full-suite qualification.

The complete root typecheck and type-aware lint were terminated with exit 137 /
`SIGKILL` in this environment. The first complete Host test typecheck was also
terminated, but a subsequent full Host test typecheck passed after restoring the
exact reviewed source and correcting the cost-proof fixture's inferred row type.
An earlier Host
test typecheck did produce actionable diagnostics: the new fixture lacked
`teamName`, and existing OpenCode/session-history fixtures had invalid types.
Those fixtures were corrected using complete values and actual discriminants,
without suppressions or relaxed compiler settings; the affected-file typecheck
then passed. Temporary validation configs were removed.

## Follow-up correctness review

The next pass starts at published head
`f3bbca99f4e1ed07009f60338c3ffdf6f15a91ad` and remains inside PR #982.

### Interrupted context publication across Restart

A partial archive publication can leave candidate-only Team rows after Runtime
has durably claimed the original proof. A fresh Restart generation does not
carry that original proof in its new request. Overwriting the old candidate
would strand the successor before its ordinary input could proceed.

Preparation now reconciles archived preparations before replacing candidates.
Recovery verifies the original logical backend/team/member identity, the whole
proof epoch set, the complete candidate digest including authority revision, and
the original binding. Ordinary observation/validation still cannot promote an
unrepresented candidate. Pending, mixed, corrupt or mismatched batches hold.
The immutable input and exact original Runtime proof remain authoritative; no
new submit or model turn is introduced.

The focused context cohort passed **33/33** tests. Coverage includes real Team
and Runtime owners with filesystem stores, injected partial publication, a new
Restart generation, 129 compactions followed by ordinary dispatch, replay with
no additional submit, and revoked/mixed/missing-proof negative cases. This is
controlled-provider evidence, not genuine vendor qualification.

The production correction changes 31 lines and removes one; regression coverage
adds 303 lines. Estimated implementation complexity: **6/10**.

### Bounded queued-message confirmation

Review reproduced a P1 failure in the existing `team.queue.read`: 30 accepted
messages of 40,000 ASCII characters produced a response over the 1 MiB Host
limit and closed the transport with `priority_overflow` before Discard Queued
confirmation. This read's current consumer needs message identities and count;
message text is already displayed through the existing activity feed.

The existing operation now returns an identity inventory and accepts an optional
cursor. Canonical queue rows remain untouched. Larger inventories use whole-ID
pages bounded to 240 KiB, with the existing 4096-ID overall limit. Continuations
bind the captured full owner/scope/handle, principal, member, current admin grant
revision, full queue snapshot revision, and current Host composition. Current
authority is rechecked across the asynchronous queue read.

The renderer assembles all pages at the originally captured target before
returning the inventory for confirmation. Duplicate identities, changed
revision/member, malformed or repeated continuations, empty paged responses,
and context changes fail without returning a partial confirmation list. Plain
empty queues and validated legacy full-row responses remain compatible. The
existing atomic discard operation still receives exactly the confirmed IDs;
new arrivals survive it. No new MCP tool or user feature is added.

The targeted Host regressions passed **10/10**, including the real transport
overflow, later-arrival discard boundary, authority changes during lookup,
cursor scope/key changes, and valid native text under 64 KiB whose escaped JSON
row exceeds 240 KiB. They also check no queue/Runtime writes or native opens on
read. The renderer/lifecycle cohort passed **19/19** tests, and the existing
confirmation UI/preload cohort passed **14/14**, including an identity-only
inventory through the rendered confirmation and exact-ID discard path.
Independent review found and closed the empty-final-page validation gap.
Production logic adds 181 lines and removes 34; regression tests add 454 lines
and remove one. Estimated implementation complexity: **5/10**.

### Cost-proof alignment and main integration

The existing native/desktop cost proofs now require an explicit incomplete
Codex aggregate with the exact missing-totals explanation while still requiring
positive retained raw usage, original input/operation identity, journal digest,
and replay without additional native effects. No assertion treats a fabricated
zero or a last-request slice as a trustworthy cumulative total.

The PR's merge conflicts with main prevented normal pull-request CI from
starting on the published head. The prepared integration uses main
`2dbc3e27b9c2ae66b15bdaf81c87bee108f02f2f`. The main-only merge candidate tree is
`0f876825bd174192a709ffa69e36382c29b11048`. Main's shared schedule-file lock and
per-schedule mutation queue are combined with the PR's captured Host authority,
atomic metadata updates and original run ownership. Durable deletion and its
admission fence remain inside the file transaction; native cleanup stays
outside metadata locks so reentrant cleanup cannot deadlock or resurrect a
deleted schedule. The reviewed schedule cohort passed **108 tests in 7 suites**.
These are compatibility resolutions for existing main changes, not new product
features authored in this pass. The PR itself remains open and unmerged.

Additional protocol checks passed: **22/22** actual HTTP MCP tests and the real
stdio MCP child-process visualization protocol test. Bootstrap/importer/ledger/
analytics regressions passed **54/54**. Exact source blobs were checked after
executor recovery. Successful local checks do not replace current-head CI.

### Remaining qualification

The full root compiler still requires CI: two local attempts were killed with
exit 137, including a bounded attempt. Compiler options and assertions were not
relaxed. The complete Host test typecheck and canonical Host build do pass.
The full Host test compiler caught an overly widened optional-field type in the
new queue fixture; using its concrete definition with `satisfies` corrected the
fixture without a cast or suppression. Both its 10 runtime regressions and the
complete Host test typecheck passed after that correction.
The complete legacy Host script typecheck also passed with the pinned compiler,
including the updated desktop cost-proof scripts.

The existing CodeQL alert 628 remains open. Its successful analysis job and
failing HIGH security check are different results; no suppression, dismissal,
credential digest replacement or identity migration is included. The original
eight source-flow details and the relevant private-storage boundary remain to
be qualified. Native desktop/provider results must be obtained from their real
qualification jobs, not inferred from these local fixtures.

Full CI and native desktop/provider E2E qualification remain required before
declaring the entire PR ready to merge. No successful result is inferred from a
terminated compiler, test worker or native flow that was not executed.

### Follow-up: bounded native task inventory reads

The new P1 review on `task_list` was reproduced on the exact published
`fe4a80669d1f5976f5396b0805458f57823bfefe` source. Creating 150 canonical tasks
with mutual relationships made the default 50-row inventory exceed 256 KiB.
The actual MCP call failed with `MCP operation output-limit`. A row-count limit
also cannot bound JSON-escaped scalar text independently of relationships.

The existing tool now uses the shared lossless read pager for oversized selected
inventories. Small results keep their original JSON array. Larger results use
the existing 64 KiB escaped-text chunk budget, preserving every selected row,
relationship and its order. The original filters and default/max limits remain
unchanged; the final continuation ends the selected limit window. The tool
description explains how to retain the same filters and reconstruct the array.

Inventory cursors have a separate protocol and bind the original query, full
current grant, principal, Team, Owner key and selected-result revision. The
cursor never enters the canonical controller filters. Existing task/comment
cursor signatures and envelopes remain unchanged. Invalid inventory shapes,
changed authority, stale results and cross-query or cross-kind cursors fail
closed through the existing Owner read boundary.

Two independent source reviews found no blocking issue. The original red
scenario passed after the fix. Six new regressions passed, including real
150-task windows, 200 rows with JSON escaping and Unicode, a single oversized
row, exact reconstruction, byte limits and unchanged task/command files.
The existing read-cutover suite passed 9/9 and the existing HTTP SDK continuation
scenario passed 1/1: **16 focused tests, zero failures or skips**. Canonical Host
build and the complete Host test typecheck passed with Node 24.21.0 and the
pinned native compiler. Source-size and whitespace checks passed.

The fix was integrated over concurrent published commit
`9b80b2fb5958c35f4c5ef7233ed21e6bd5179342` without overlapping its files. Its exact
base tree was verified, and the combined Host build and complete Host test
typecheck passed again. The unchanged MCP source blobs retain the focused
runtime evidence above; ordinary current-head CI remains required.

Production changes add **30** lines and remove **13** across three files; the
new test file contains **262** lines. Complexity: **4/10**. This repairs the
response-size failure; reading every page preserves the total selected payload
and is not evidence of lower total token use or provider cost.

### Follow-up: trustworthy CodeQL diagnostic source locations

Review of concurrent commit `9b80b2f` found two reproducible diagnostic errors.
The collector ignored an explicit `result.rule`, allowing contradictory rule
references to look complete. Its indexed tracked-path allowlist also accepted
committed symlinks and gitlinks as ordinary source files. An isolated real Git
fixture reproduced both errors through the actual helper and CLI under valid
checkout provenance; both new regressions failed on the published code.

The collector now marks explicit unsupported rule references partial before
selecting or omitting a result. Its allowlist comes from the committed tree and
accepts only regular or executable blobs, preserving raw NUL-delimited paths.
The two targeted regressions and all existing diagnostic tests passed:
**26/26, zero failures or skips**, using pinned Node 24.21.0. Two independent
reviews approved the exact diff. Production adds seven lines and removes one;
tests add 71 lines and remove one. Complexity: **2/10**.

This correction changes only diagnostic source validation. The existing CodeQL
workflow and analysis gates are unchanged. The next ordinary analysis artifact
still needs inspection; even a complete supported-subset report does not prove
that it contains every path from the historical eight-flow alert.
