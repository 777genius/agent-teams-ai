# Restore the existing Host Logs workflow

Date: 15 November 2026. Status: R1 and independent R2 reviewed; publication
precedes implementation. This is a staged repair, not a
full Logs parity claim. No implementation or test PASS is claimed.

## Authority and inspected sources

- [Frontend parity goal](README.md#цель-и-исходное-состояние) requires all previously
  working controls and supersedes completion by disabling an unsupported feature.
- [Stage 1 §6.4](../stage-1-legacy-host.md#64-config-context-и-наблюдение) requires
  exact source/message/block/tool identities, partial/complete deduplication,
  subagent filtering and explicit gaps. It forbids fabricated Claude transcripts,
  tool results or usage to satisfy the old parser. Normalization permits a typed
  representation; it does not permit deleting working Thinking or stream controls.
- Application baseline inspected: `a02ab70edfdcb4169627e804f0337c9ad6b52af6`;
  original frontend baseline: `4a0e06277fe216d9f82dbbede362668fe46622ee`.
  The relevant application paths remain unchanged in the inspected `4dc08dea` checkout.
- Consumed provider source: `421fee918811b8a0b0c73d0ff3e761b9a1c5ecb0`, archive
  SHA-256 `91350f829b72f83e613505bb444ff0d9ef98fb0835e3e438b918bbea8d930f94`.
  [Provider PR #8](https://github.com/agent-teams-ai/old-provider-implementations/pull/8)
  is now at `37baf6e4b7065fe1b730c928db0d9c54809f7fc5`; preserve its intervening work.

## Established defects and baseline boundaries

`ClaudeLogsSection` enables `getClaudeLogs` for default Lead, including Host teams.
`createHostTeamsApi` has no such operation and rejects it. Its existing typed
`getMemberLogs` operation is available. Nonlead sources also enter the legacy
member-stream path before an error-driven typed fallback. Existing Desktop proof
opens Member Detail Logs and therefore does not exercise this default Lead route.

| Capability | Source evidence and required result |
| --- | --- |
| Search, filters, fullscreen and source selection | Existing `ClaudeLogsSection`, `ClaudeLogsPanel`, `ClaudeLogsFilterPopover`; retain their controls and shared presentation state. |
| Claude Thinking | Frozen `useClaudeLogsController` filters/searches thinking blocks and `streamJsonParser` renders them. Consumed `claude-sdk/normalize` drops both thinking deltas and final blocks. Restore actual exposed content. |
| OpenCode V1 Thinking | Frozen `OpenCodeRuntimeProjectionMapper` and the real comet-hub fixture in `memberLogSources.test.ts` retain thinking. Provider V1 transcript projection retains reasoning, but its Session driver drops it. |
| Codex / OpenCode V2 Thinking | Prior working display is not established. Codex's original lead parser lacks reasoning mapping and member-wide native stream explicitly reports unsupported. Do not add speculative provider behavior in this cut. |
| stdout / stderr | Legacy capture retains real markers; the filter excludes only a known unselected stream. Unmarked persisted transcript rows pass either selection. SDK/HTTP observations remain unmarked; neither is relabeled stdout. |
| Raw diagnostics | The frozen controller's empty-query/default-filter path returns raw normalized input, and `streamJsonParser` renders non-JSON lines as output. Therefore ordinary captured stderr was visible. Host currently drains it. This is a real remaining parity gap; preserving controls alone does not repair it. A separate bounded capture/ownership/redaction plan is required before implementation; never tap stdout protocol frames or persist unsanitized credentials. |
| Rich content | Reuse existing markdown, copy, highlighting and collapse primitives with real typed content. Missing clocks and retention remain explicit; never construct fake dates or Claude JSON. |

## Finite implementation

### Existing renderer surface

| Exact application path | Change |
| --- | --- |
| `src/renderer/components/team/ClaudeLogsSection.tsx` | Route canonical Host selection to actual roster Lead/member typed logs; disable raw reads. Do not query the invented fallback `team-lead` when no real Host Lead is present. Preserve compact, inline, sidebar, fullscreen and source selection. |
| `src/renderer/components/team/ClaudeLogsPanel.tsx` | Extract the current search/filter toolbar as a named presentational export in this file. Raw panel and Host source use the same toolbar with explicit handlers/metadata. No optional raw DTO body mode or second controller. |
| `src/renderer/components/team/members/MemberLogStreamWithLegacyFallback.tsx` | Route Host directly to `MemberLogsTab`, carrying enabled and presentation options; skip legacy stream IPC. Propagate enabled through existing fallback paths. |
| `src/renderer/components/team/members/MemberLogsTab.tsx` | Carry typed query/filter/view options. Poll active Host member reads using existing `useCompletionRead`, with its settlement-driven five-second scheduling and scope fence. Keep retained facts visible alongside a background read error. |
| `src/renderer/components/team/members/HostMemberActivityLog.tsx` | Apply query and all content filters after identity-based deduplication. Render actual output/thinking using existing `BaseItem`/`MarkdownViewer`; reuse tool input/output render helpers where applicable. Keep subagent identity and independent collapse, gap warnings and unknown metadata. |

Keep `ClaudeLogsFilterPopover.tsx` and `claudeLogsFilterState.ts` controls intact:
stdout, stderr, Output, Thinking and Tools. Use the existing controller's persisted
query/filter/view state with raw fetching disabled for Host; no new store or poll owner.
Absent stream provenance follows the original unmarked-row rule, without a fake label.
Filter text and thinking separately; tool calls/results retain their actual tool identity.
Dedup keys include input, kind, message/block or tool and child identity where present.
A completed block cannot be replaced by its later stale snapshot; identical text from
different messages remains distinct. Do not suppress retained gaps with a content filter.
Preserve expansion and the viewed position when moving between compact and fullscreen;
the compact reader is unmounted while the dialog owns the body. Never create two read owners.
Use existing UI primitives directly when richer transcript components require invented
timestamps. No global chat-model refactor, new viewer framework or fabricated token estimates.

### Provider dependency and Host projection

The provider change is a reviewed child continuation of current PR #8, owned by root.
Add a separate `EventPayload` variant
`{ kind: 'thinking'; messageRef: string; block: number; text: string; phase: 'snapshot' | 'complete' }`.
Do not combine `kind: 'text' | 'thinking'` in one union member: existing `Extract` users
must keep their text-only meaning. Preserve native block indexes, input/operation
attribution, limits and child routing; ignore signatures and redacted-thinking payloads.

Provider source scope is exactly `packages/provider-session-contracts/src/features/provider-session-contracts/contracts/session.ts`
and, under `packages/provider-implementations/src/features/provider-session-implementation/adapters/`,
`claude-sdk/normalize.ts` and `opencode-protocol/v1-driver-output.ts`.
Changes belong in that repository and a checked immutable artifact, never vendored `dist`.
Provider PR creation is conditional on existing workflow safety: Claude source paths
also trigger a Codex native workflow. Root must avoid prohibited real-provider execution;
use the existing safe qualification route or retain an explicit delivery hold.

| Exact application path | Change |
| --- | --- |
| `packages/legacy-agent-host/src/runtime/normalizeActivity.ts` | Validate/bound the distinct thinking event through the existing normalization boundary. |
| `packages/legacy-agent-host/src/composition/runtimeActivityProjection.ts` | Add the thinking fields to the existing explicit projection whitelist. |
| `packages/legacy-agent-host/src/composition/readTeamActivity.ts` | Retain thinking in authorized member/task reads; count each message identity once across output and thinking. Preserve retention, attribution and unknown usage. |
| `src/shared/types/teamActivity.ts` | Add the distinct thinking content variant, including the existing nested subagent content union. |
| `src/features/agent-backend/contracts/operations.ts` | Carry the same typed variant across existing IPC/HTTP contracts. |
| `src/features/agent-backend/main/adapters/output/projectBackendResult.ts` | Validate thinking with the existing text-shaped codec; preserve strict fields and bounds. |
| `src/features/agent-backend/renderer/createHostTaskActivityApi.ts` | Count unique message identities across both content kinds when deriving the existing exact task view. |

The existing generic bounded activity journal already stores typed events. No new RPC,
schema version, cursor store, retention expansion or `latest.thinking` cache is needed.
Keep thinking out of ordinary conversation output and preserve Stats token/cost semantics.
`projectTeamActivity.ts` remains the existing selection/budget boundary. The strict codec
file is 793 lines; add only the shared switch case and stay below 800, without formatting
compression or a cap exception. `MemberLogsTab` is 729 lines and must also remain below 800.

### Dependency-safe staging

First implement the independent renderer route/presentation/read polling and the
read-side DTO, strict codec and projection changes against the currently checked
packages. Their controlled fixtures establish only the selected layer's behavior.
Keep `normalizeActivity(event: Event)` bound to the installed Session SPI. Prepare
the exact thinking-case change for review, then apply it atomically with both new
checked archives and all current package/lock/receipt pins. Do not widen a local
Event alias, cast through unknown, suppress type errors, copy dist or install an
unqualified archive to make this producer compile. Producer-to-renderer Thinking
E2E remains on HOLD until that atomic adoption and its original acceptance run.

The stderr gap is tracked explicitly outside the finite implementation tables
above. The follow-up must retain only the original selected member's stderr,
including startup failure, sanitize before persistence, keep bounded framing and
existing journal ownership, and avoid invented input/task attribution. It needs
its own concrete source review; this staged repair cannot close full Logs parity
while stderr or the checked provider dependency remains outstanding.

### Artifact pins and evidence closure

Adopt both checked archives and original receipts under one new `vendor/provider-migration/`
directory. Update `packages/legacy-agent-host/package.json`, `pnpm-workspace.yaml` and
`pnpm-lock.yaml` together. The exact directory/digests come from the actual checked build.
Update current-consumer pins in `.github/workflows/ci.yml` (current lines 774, 1259,
1454–1455, 1488–1489, 1503), `packages/legacy-agent-host/tests/native-codex-team.native.ts`
and `packages/legacy-agent-host/tests/native-claude-host.native.ts`. Keep workflow behavior,
commands, required gates and deadlines. Historical donor archives/contracts hashes in
`scripts/legacy-agent-host/desktop-claude-checkpoint-upgrade.ts` and CI remain unchanged.

Extend the already-composed `desktopProofSupplementarySources` array in
`scripts/legacy-agent-host/desktop-proof-supplementary-sources.ts` with missing renderer inputs.
The importing `desktop-proof-sources.ts` is already 800 physical lines; preserve
its existing composition rather than adding another roster or a cap exception:
`ClaudeLogsSection.tsx`, `ClaudeLogsPanel.tsx`, `ClaudeLogsFilterPopover.tsx`,
`claudeLogsFilterState.ts`, `teamLogSources.ts`, `useClaudeLogsController.ts` under the
existing team directory, and `members/MemberLogStreamWithLegacyFallback.tsx`.
Include the actual reused markdown/collapse/tool-render leaves and member-log read owner;
keep existing pins and roster order. Host/types/task projection paths are already listed.
Runtime UI and finite peer files are already in `desktop-proof-management-sources.ts`.

## Acceptance and review record

Extend existing renderer suites `ClaudeLogsSection.test.ts`, `hostLogStatsTabs.test.tsx`
and `MemberLogsPolling.test.ts` for the actual source route, dedup-before-filter, completed
block precedence, independent child identity, all controls and no legacy reads. Deferred
reads must not overlap or publish after hidden-tab/context/member changes. Reuse existing
`runtime-activity.test.ts`, `team-activity-read.test.ts`, `runtimeActivityFacade.test.ts`
and `hostTaskActivity.test.ts` for bound typed propagation, cold read and task attribution.
Provider tests cover actual Claude/V1 decoding and packed-consumer type compatibility.

Extend `scripts/legacy-agent-host/desktop-emulated-runtime-ui.ts` and existing finite
`tools/owned-process-broker/fixtures/claudeProviderPeer.mjs` / `providerDesktopPeer.mjs`.
Use the existing `TEST_UI_STREAM` turn and release gate: observe Lead Logs partial then
complete by live refresh, true thinking, search/no-match/clear, all filters, rich copy/collapse
and fullscreen. Scope assertions to Logs so conversation text cannot satisfy them.
Use existing collaboration UI for a real second member source. After the existing reload,
read the same retained facts; inputs, effects, deadlines and original actions remain unchanged.
No new business turn or native Claude/Codex call is authorized. Existing safe OpenCode
native acceptance remains required; finite peers are not relabeled native qualification.

R1 `/root/migration_scope_audit` established route and upstream content-loss defects.
R2 `/root` rejected route-only repair and dropping filters; the proposal now retains all
controls and includes real thinking propagation. `/root/p09_review` independently confirmed
the dedicated SPI shape, Claude/V1 scope, subagent boundary and absent stream provenance.
Exact-document R2 `/root/p09_review` rejected the initial raw-stderr baseline claim
and required atomic checked-SPI adoption. Both corrections are recorded above;
independent R2 GO for the corrected staged plan was given on its exact blob
`ae793e5206485f188106cffb88da2c78a4a97999`. Root inspected the existing renderer
route, read owner, DTOs, strict codec and Host projection and accepts this staged
scope. Emulated provider Thinking fixtures/assertions are part of the held atomic
adoption; current independently green UI checks may use typed fixtures without
claiming producer E2E. Publish this record before source edits. No tests were run here.
Estimate: application 240–420 production lines changed/added, provider 20–45; focused
tests/fixtures 200–350 and existing E2E additions 70–120. These are planning ranges, not quotas.
Complexity 4/10; source confidence 9/10; expected reliability 8/10 pending actual qualification.
Keep Draft/base, contributor history, P08/P09 outstanding gates and the no-real-Claude/Codex,
no-main-merge, no-release, no-default-activation and no-Stage2 boundaries.

## Bounded acceptance amendment after source inspection

R1 `/root` found the root proof roster already at 800 lines and the existing
Host Emulated workflow already running all four safe offline Vitest shards.
Independent R2 `/root/p09_review` confirmed both exact sources at `332fbe3420`.
Use the existing supplementary roster for the finite dependency leaves above,
keeping every previous entry and its order. Add only the missing
`packages/legacy-agent-host/tests/team-activity-read.test.ts` to the existing
`matrix.lane == 'team'` Node test command in
`.github/workflows/host-emulated-acceptance.yml`. The five planned frontend test
files already run in the four offline shards; do not duplicate their invocation.
This strengthens controlled acceptance without altering workflow selectors,
matrices, required gates, timeouts or native-provider execution. R2 GO recorded
before these source/workflow edits. Exact implementation and actual test outcomes
remain required; no checked-provider or native acceptance is inferred.

## Preserve the existing activity UI proof

Source review found `desktop-activity-ui-smoke.ts` and the existing Task Log
Stream assertion in `desktop-emulated-runtime-ui.ts` selecting the old plain
`pre` representation. Update only those existing assertions to the real rich
rows: exact retained eventId/sequence/kind, correlated tool identity, actual
error indicator and result content, then original childId/parentToolRef/phase
and counters. Expand the actual BaseItem controls and inspect visible content.
Retain the original inputs, generation checks, timestamps-unavailable notice,
no-replay/no-write invariants and all native gates. No hidden proof markup or
weakened semantic oracle is allowed. R1 `/root` found these consumers; R2
`/root/migration_scope_audit` reviewed the precise actual-DOM adaptation before
its implementation. This is an existing-test compatibility correction for
the already-planned rich rendering, not a new business workflow.

## Final controlled source review and existing type-gate correction

The exact candidate over `462845722260dfd91111c37cb66fc54a01a3ecb7`
has independent renderer/read-side/source review. Root verified the unchanged
raw-controller and legacy routes, one Host read owner, actual roster selection,
existing read settlement/cancellation, rich event identity and all retained
controls. The three existing Desktop scripts were adapted to actual visible
rows without adding business turns; the two existing Claude/Codex finite peers
emit one benign stderr line during their original stream turn. Independent R2
`/root/p09_review` accepted all five diffs. Additional R2 by
`/root/migration_scope_audit` required exact Markdown leaves, same-input tool
correlation, scrolling the real raw-view control and a not-ready result for a
temporarily absent row; those corrections are present.

The existing `test/features/agent-backend/tsconfig.json` narrowed include list
omits two ambient declarations already in the root project:
`src/renderer/vite-env.d.ts` and `test/types/better-sqlite3-node.d.ts`.
The required dedicated TypeScript7 command therefore reports missing Vite
assets/globals and the existing Node SQLite alias. R1 prepared exactly two
include entries, and R2 root independently checked both existing declarations
and the root config. Accept only those two additions; no compiler option,
suppression, new ambient declaration or workflow-gate change is included.
The exact dedicated command passes with those original declarations.

On the final prepared source, the six focused Vitest suites pass62/62, with
no skips. Separate native TypeScript7 checks pass for the agent-backend test
config, the five changed renderer components plus four existing UI suites and
their dependencies, all legacy Host scripts, and the Host test config.
The existing source-size and provisioning-architecture guards pass; scoped
lint and diff checks pass. The full workspace typecheck was previously killed
with137 in this environment; neither that attempt nor these scoped checks are
a full workspace PASS. The existing complete CI gate remains required.

This reviewed candidate still uses the installed checked Session SPI:
`normalizeActivity(Event)`, provider pins and producer Thinking fixtures
remain unchanged. Current-source producer-to-renderer Thinking qualification
and the actual Desktop/native gates remain on HOLD until their real results.
No queued, cancelled, skipped or source-reviewed job is counted as PASS.

## Checked producer follow-up on the published Logs implementation

The follow-up preserves `27b1acf48278dcd0fb348c626696eac2dc64de73` and its
original Logs/read-side implementation. Both provider archives now come from
the checked `9423f600dfb04d04448326dbced89919924b0b5f` source: Node24 and26
source/packed-consumer checks pass, and all53 original OpenCode jobs finish
(51 positive receipts, two expected HOLD controls). The adjacent original
artifact/source receipts bind their exact bytes and scope. Dependencies are
unchanged; the previously merged opt-in prompt-suggestions binding stays off.

Host now accepts the original typed `thinking` event. The original finite
Claude/V1 stream turns expose partial and completed Thinking through the same
input/message/block; the Desktop assertions inspect these actual Logs rows,
completed-over-partial replacement, filters and reload without new effects.
Codex makes no unsupported Thinking claim. Same-source fullscreen preserves
viewport state; selecting another source resets it. The existing failed-tool
and child proofs retain their original event identity and full visible content.

Controlled follow-up evidence: the final seven Host suites pass106/106 with
zero skips; the five focused renderer suites pass57/57, and the existing team
read suite passes5/5. Host build/test types, scoped renderer/script/feature
TypeScript7, source-size and diff gates pass. Four renderer lint warnings and
one native Codex fixture warning already exist at27b1; no suppression or new
warning is added. Full workspace typecheck remains unqualified after its
earlier environment OOM. Actual resulting-source Electron/native acceptance
is still required; neither the provider receipts nor27b1 Desktop results
qualify this follow-up.

## Remaining shared-SPI coordination consumer after checked adoption

At application `35cbd6e99b620e9b41802af936143d900f5e2aca`, both original
checked archives from provider `9423f600dfb04d04448326dbced89919924b0b5f`
are admitted. Independent primary-source review verified the exact CI ZIP,
both package hashes, Node24.21/26.11 source and packed-consumer checks, and
all53 original native OpenCode jobs. Mandatory CI/native workflows and their
commands are unchanged. The provider receipt still says source/packed-consumer
only, with nativeHostQualified and packagedElectronQualified false; it cannot
qualify application Desktop, process custody or packaged acceptance.

One existing consumer still rejects the new SPI variant:
`OpenCodeCoordinationProbe.observeCoordination` accepts `usage` but refuses
`thinking`. The actual V1 management/readiness path uses this loop, so native
reasoning can reject an otherwise valid coordination proof. The Windows
Event-kind counter and Host normalizer are already corrected in35cbd6e and
are not part of this remaining companion.

R1 `/root/p09_review` identified and prepared the finite consumer repair;
R2 `/root` independently reviewed its original helper, actual MCP endpoint
and all refusal predicates. Accept exactly one production expression:
ignore `thinking` alongside `usage` only after existing session, input,
operation, revocation, event/byte-budget and deadline checks. Thinking must
never set hasText, substitute for either MCP effect, change native tool
identity, or satisfy the required actual answer and successful result.

Extend only `management-model-probe.test.ts` and its existing synthetic
Session/MCP helper with seven cases: valid Thinking plus original effects,
answer and result; Thinking with completed effects but no answer; foreign
session/input/operation; serialized Thinking above32KiB; and129 events whose
total bytes stay below32KiB. Only the first qualifies. The no-answer case
must complete the real finite MCP sequence while the overall proof refuses
it; the remaining negative cases must refuse before those effects complete.
Retain every original case, authority predicate, deadline and cleanup.

Publish this bounded amendment before source edits. With the exact checked
SPI installed, first demonstrate the new regression on the unchanged
production consumer, then run the complete existing management-model-probe
suite after the one-expression correction. Run Host build/test TypeScript7
and affected original activity suites. No new workflow, selector, package
pin, facade, persistence, runtime owner or permission is introduced. Synthetic
Session/MCP execution is not native qualification and authorizes no real
Claude/Codex process. Scheduled-log presentation has a separate concrete
baseline review; it is not silently covered by this consumer repair.

The Draft chain, contributor history and outstanding P08/P09/Desktop/native
gates remain unchanged. No queued, skipped or cancelled check is a PASS.

## Scheduled standalone Thinking parity — R1 proposal

Status: scratch only; no application source or repository plan changed.
Basis: application source `35cbd6e99b620e9b41802af936143d900f5e2aca`, child of
`27b1acf48278dcd0fb348c626696eac2dc64de73`. Root has completed the exact 35 import/tree verification and the Node24.21.0 /
pnpm11.22.0 frozen ignore-scripts install. Provider9423 provenance has R2 GO.
Source edits still require reviewed and published plans; root owns builds.
Frozen frontend: `4a0e06277fe216d9f82dbbede362668fe46622ee`.

### 1. Proven baseline loss and actual route

`ScheduleSection.tsx` opens `ScheduleRunLogDialog` from a history row.
The dialog fetches `schedules.getRunLogs` only for completed/failed/interrupted
runs and passes full stdout to `CliLogsRichView`; running/dispatched summaries
are a separate branch. The frozen executor explicitly uses stream-json for
Thinking/tool cards, captures stdout up to 512 KiB, and separately derives its
500-character summary from assistant text. SchedulerService persists the full
stdout/stderr through JsonScheduleRepository. Thinking is therefore a detailed
completed-run Logs capability, not a requirement to put reasoning in summaries.

The frozen/current dialog, CliLogsRichView and streamJsonParser are identical
Git blobs: `4d2ec4b166dd8f87aa2416b3748d436b121e0068`,
`1466b8f34b2911ffa7a6f5b576fce39e9b0b92d9`, and
`3004f6fa40a761d41742ee95e9e66f5d9190138f`. Parser lines 458–462 create Thinking
items; unchanged DisplayItemList lines 148–174 and ThinkingItem render expandable,
copyable Markdown. Frozen ScheduledTaskExecutor blob is
`294ecb66daa812eef73c8b8590bc564d9e44c7b4`; JsonScheduleRepository is
`0de15c337bebaa8d67f48ff082d32abaac2e8217`.

Current delivery is HostScheduledRuns.snapshot → projectScheduledRun →
CapturedScheduledRuns → runCapturedScheduledTask → SchedulerService.saveRunLogs
→ JsonScheduleRepository → the same getRunLogs/dialog. Two source omissions:
RuntimeActivityCoordinator.snapshot includes only kind=text in latest.text and
explicitly returns events=[]; scheduledRunProjection additionally excludes
Thinking from child facts. Top-level and child Thinking therefore disappear
from detailed logs even when their original canonical observations are retained.

Generic member Logs do not bypass this: HostScheduledRuns owns a separate Runtime,
its binding uses scheduled-standalone and a scheduled member slot, while ordinary
Team reads use RuntimeTeamCoordinator's member registry/roster. Standalone creates
no hidden Team task; an Open task link on a dispatched schedule is another flow.

### 2. Reconcile the published architecture before editing

Stage1 §6.4 forbids fabricated Claude transcripts/results/usage and immediately
allows adapters to translate real observations into compatibility projections.
P04 R4 expressly authorizes confirmed Runtime observations in the original schedule
log UI. P04 R13 expressly accepts existing text/tool/result compatibility blocks,
original IDs/sequence, 256 KiB snapshot and 512 KiB final stdout limits, without
new feed reads, cursor store, RPC, snapshot owner or allocation.

The existing schedule serializer is that approved compatibility adapter. Extend it
only with actual retained Thinking; do not replace DTOs/repository/UI or manufacture
model text, signatures, message IDs, usage, outcome or cleanup. Keep its existing
stdout contract and old saved logs. Actual observedAt may supply a reader timestamp;
no synthetic time is introduced. The legacy viewer's undated fallback is existing
behavior and is not evidence of a native timestamp.

Plan32's assertion that no latest.thinking cache is needed was sufficient for its
member/task feed consumer. Amend that assessment for this newly verified schedule
consumer: a local computed auxiliary log projection is needed. It is not persisted,
cannot be independently updated, and does not become a new public snapshot/RPC field.
Root must publish this finite P04/Plan32 clarification after exact R2 review.

### 3. Exact production changes

| Path under packages/legacy-agent-host/src | Bounded change |
| --- | --- |
| runtime/activityContracts.ts | Add one optional internal logProjection shape: { thinking: RuntimeActivityEvent[]; stderr: RuntimeActivityEvent[]; truncated: boolean }. RuntimeActivityRecord/storage schema stays as it is. |
| runtime/RuntimeActivityCoordinator.ts | Derive Thinking from the same already-read, authorized retained events inside snapshot(); use a collision-free [inputId, operationRef, messageRef, block] key and complete-over-later-snapshot precedence. |
| composition/scheduledRunProjection.ts | Include retained Thinking and real child Thinking in sequence order, preserve original eventId/child identity, emit the existing reader's Thinking compatibility block from actual text, and surface any schedule-only truncation warning. |

Process the original usage/interactions/tools/text/subagents budget loop exactly
as before. Compute both auxiliary groups from that same authorized read, with one
remaining 256 KiB counter after the original groups: Thinking, then stderr. Preserve
actual event objects/IDs and sequence ordering. Neither auxiliary group displaces
an original group. Only logProjection.truncated records auxiliary omissions.
Do not reuse the original global partial/gap flag: readTeamActivity copies that
gap and summarizeTeamActivity makes costUsd unknown for any gap. Only the scheduled
result consumes the auxiliary truncation status; genuine existing journal/state
gaps retain their old semantics. P09 has independently accepted this exact common
shape, one-read/one-budget ownership and Stats isolation. Root owns final combined
integration with the separately reviewed stderr R1; no second read cache exists.

latest.text, ordinary conversation materialization, message summaries, usage,
result/outcome, cleanup and duration retain their existing sources and rules.
For child Thinking, retain the wrapper eventId/sequence and actual childId and
parentToolRef; scope dedup by input/operation/child/parent/kind/message/block or
toolRef. Complete Thinking wins over a later snapshot, while equal text from
other identities remains distinct. Do not merge child text into root summaries.
The existing renderer mapper runtimeActivityProjection.ts explicitly whitelists
old latest groups, so optional internal logProjection needs no wire DTO or app codec.

### 4. Existing owners and compatibility boundaries

HostScheduledRuns, scheduledRunSnapshotSchema, CapturedScheduledRuns and
runCapturedScheduledTask remain the result delivery owners. SchedulerService,
ScheduleRepository/JsonScheduleRepository and the current .log/.err files remain
the persistence path. ScheduleRunLogDialog, CliLogsRichView and ThinkingItem remain
the renderer path. No new endpoint, log sidecar, polling owner, feed reader or
viewer is needed. Standalone qualification is Claude here: the current input
schema admits Anthropic/Codex, ScheduledRunProvider expressly rejects OpenCode,
and Codex makes no unsupported Thinking claim. V1 member Thinking is a separate
already implemented route, not authorization to add standalone OpenCode support.

### 5. Finite verification and source roster

Extend existing runtime-activity.test.ts for exact retained Thinking IDs, separate
identities, complete precedence, cold derived reads and budget behavior. Assert
original global gaps and Stats cost semantics remain unchanged when only the new
computed log group truncates. Use existing canonical retained-record fixtures for
read-side checks; no widened Session Event union, cast or fabricated provider proof.
Extend scheduled-run-host.test.ts's original finite case for root/child Thinking
and hot/cold output, preserving every existing result/usage/duration/tool/cleanup,
no-replay and no-hidden-task assertion. The optional internal field needs no
empty-array edits to unrelated synthesized snapshots or app test fixtures.

Reuse existing TEST_UI_STANDALONE_DONE in claudeProviderPeer.mjs and the already
present completed standalone dialog action in desktop-emulated-runtime-ui.ts.
Emit actual native final Thinking in that same one input; assert its real expanded
Markdown/copy in the same original dialog before the original screenshot/close.
No extra business turn, model call, deadline, workflow row or weakened oracle.
Preserve incoming35's stream Thinking, tool identity and source viewport changes.
Root adds the missing existing scheduledRunProjection.ts, scheduledRunCapture.ts
and scheduledRunContracts.ts leaves to the existing management/supplementary
source roster and updates original gate evidence; no new roster or root-list expansion.

Estimate: 3 production files, roughly 40–70 changed lines; 2 existing focused
suites; 2 existing finite Desktop files, including the residual checks below.
No source has been applied or new test/E2E pass claimed by this proposal.
The complete import and exact provider pins are now verified. Source execution
follows plan publication and root build coordination. Original Desktop/native and
full workspace gates remain required, with their current holds preserved.

### 6. Review status and separate stderr ownership

R1 route/omission and Stage1/P04 reconciliation are source-proven. P09 accepted the
computed-group direction and the schedule-only truncation distinction; this exact
written plan still requires root/P09 R2. Incoming35 source review is not a new UI PASS.

Frozen standalone stderr was separately captured up to 16 KiB and shown in its own
pre block. Current ScheduledRunProvider bypasses the member stderr hook. P09 owns
that separate bounded R1, including its original capture/fence/helper path. Root
owns any shared snapshot/projection integration. This Thinking proposal does not
silently authorize stderr implementation or alter another agent's source paths.

### 7. Only the genuine remaining incoming35 stream proof deltas

Incoming35 renderer source-selection reset and its regression test pass source R2.
Retain its stronger digest/operation/anchor, tool/result and child-content oracles.
The old reviewed 83128f5c scratch patch is superseded; never apply it wholesale.
Add only these checks to the current desktop-emulated-runtime-ui.ts:

- Compare partialThought.block with the fixture's actual block1, and its messageRef
  with the same turn's text message; keep incoming35's complete identity checks.
- Assert Thinking participates in the existing negative query/clear and remains
  visible for both stream-only selections, since its SDK/HTTP fact is unmarked.
- After existing stderr/text fullscreen clipboard/collapse assertions, use the
  same dialog for the actual completeThought query, visible Markdown, clipboard
  equality and collapse/restore. Restore the original query/fact before the
  existing screenshot/close. Preserve all original business-effect comparisons.
- After the existing reload, assert the original partialThought row is absent
  while the retained completeThought row remains visible.

In claudeProviderPeer.mjs add content_block_stop(0) before Thinking block1 starts
and content_block_stop(1) before the final assistant wrapper, only for the existing
uninterrupted TEST_UI_STREAM. Preserve contributor text, the signature-negative
marker, message/index identity, release action and result. P09 verified source9423
ignores stop frames as observations and accepted these two native framing additions.
No new provider call, turn, timeout, gate, business mutation, component or test suite.

This appendix and the standalone Thinking change share those two existing finite
files. Keep desktop-emulated-runtime-ui.ts below800 lines; incoming35 is739 lines.
Exact final source edits still require root R2 and publication of the finite plan.

### Published review boundary

This is the reviewed R1 record as prepared above, with heading depth adjusted for
this existing plan. Root R2 accepts the exact scratch proposal SHA-256
`c47fe4548ac3f2975d45e80e0566885381968054b97ce1c690266421c9de5e69` before implementation. Independent R2 `/root/p09_review` also accepted this exact document.
This publication admits only its finite changes together with the sibling
scheduled-log amendment; existing migration and actual qualification gates remain.
