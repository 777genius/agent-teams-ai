# Preserve the existing native stderr Logs surface

Date: 15 November 2026. Status: R1 and independent R2 reviewed; publication
precedes implementation. This continues Plan32's explicitly outstanding raw-stderr
gap. It is not a Logs parity or native-provider qualification claim.

## Demonstrated baseline and exact scope

Frozen frontend `4a0e06277fe216d9f82dbbede362668fe46622ee` returns normalized raw
capture unchanged under empty search/default filters. Its stream JSON parser
renders non-JSON lines as Output. The previous claim that plain stderr never
rendered was incorrect. The current Host original process adapters drain target
stderr without retaining it, so the working default Logs surface loses diagnostics.

Retain actual stderr for selected Claude/Codex member processes through their
existing original-child launch callbacks. Their stdin/stdout are native protocol,
not a raw Logs input. Do not tap either stream or expose control/readiness frames.
Do not modify CapturedProcess, WindowsCapturedProcess or OwnedProcessFacade.

The frozen OpenCode aggregate run has no child/stream turn loop and initializes
empty raw capture. Its working member logs use transcript projection. Accordingly,
this repair does not add speculative V1 server logs or reopen V2's deliberately
private engine diagnostics. Their established normalized frontend features remain
under the existing parity plans, including V1 Thinking in Plan32.

## One bounded observational path

Add a small optional MemberProviderContext callback for a closed observation:
`{ kind: 'process-output'; stream: 'stderr'; text: string }`, or the existing
`{ kind: 'gap'; reason: 'oversized' }` when capture cannot safely retain a line.
Keep provider diagnostic codes and the external provider Session SPI unchanged.

An outer adapter helper attaches to the SAME original child's stderr immediately
after custody.launch returns. Windows already exposes only target IO on its
facade, separately from broker control. Metadata probes, catalog commands and
other process users receive no observer. No new process/stream owner or observer
of ambient resources is introduced.

Trusted composition closes over the original binding, OpenConfig and existing
provider authority. It calls a narrow RuntimeOwner observation method, backed by
RuntimeActivityCoordinator's existing member fence and journal. Recheck the
captured source grant before each observation. Under the fence require matching
normalized binding, the full captured OpenConfig including checkpointRef, original
profile/config/open fingerprint, original Host incarnation and an
opening/allocated/held/closing record whose custody has not been released.
Never weaken the existing subagent observer's session or input attribution rule.

Startup observations must be accepted while the original record is already
opening and before allocate installs sessionRef; a failed open must retain the
diagnostic. Closing observations remain observational only while the original
source authority is valid. Do not use canAllocate/assertAllocatedCurrent, which
would drop startup or closing diagnostics. Runtime sealed alone neither grants nor
forbids this narrow observation; original composition-wide sealing and revocation
still reject it. Replaced/revoked/config-mismatched sources and closed or released
records produce no new retained diagnostic. No guessed current input,
operation, task, native timestamp, PID, session path or authority may be assigned.

Use the existing eventId/sequence, high water, storage fault handling and
retention bounds. These facts never update conversation text, message counts,
usage/cost, tool statistics, readiness, input terminal state or custody. Exact
task reads exclude the unattributed process facts as they already exclude
unattributed session events. Member reads retain them across cold recovery.

## Sanitize before persistence and bound framing

Reuse the pure existing runtimeDiagnosticText and diagnosticsRedaction utilities.
Move their implementations into a browser-safe Host diagnostic utility subpath;
keep existing app imports as re-exports. No new package or duplicated redactor.

One new small observeMemberProcessStderr helper owns incremental UTF-8 framing,
bounded pending bytes and observer cleanup. Maximum raw line is 24KiB; JSON
escaping can make its serialized event larger. Preserve the existing 32KiB
serialized-event check, which substitutes an oversized gap, and the 1MiB/256-event
journal limits. Normalize NUL before persistence so the existing strict text codec
can read the same retained bytes; decode invalid UTF-8 safely without throwing.
Redact the complete bounded line BEFORE truncation. For an oversized line, discard through
its terminator and emit the existing oversized gap; never publish a suffix whose
secret prefix was discarded. Flush a final bounded tail on end/close exactly
once. Diagnostic observation failures cannot throw out of the stream callback or
change provider outcomes; use existing storage-degradation behavior.

Replace actual private values ALREADY held by the selected launch: its Team MCP
bearer, selected secret environment entries, selected MCP authorization/header
values and explicit credential-bearing arguments. Do not read more credentials.
Normalize ANSI before matching the already-captured secret values; otherwise
removing ANSI later could reconstruct a secret that exact matching missed. Replace
longer values first, including nonempty line components of captured multiline
secret values, then reuse existing assignment, URL and structured dump redaction.
Reuse or export the existing pure ANSI/dump classifiers; do not copy their regexes
into a second sanitizer. Treat a detected multiline
dump as suppressed until an explicit finite end marker or stream end; do not
re-enable raw suffix publication on the next ordinary newline. An oversized-line
transition must preserve a detected dump-suppression state, including an oversized
dump opener followed by continuation lines. Keep the existing
sanitizer's behavior for all old app callers. The heuristic is not a universal
proof for secrets the native process invents or reads independently.

Tests must include captured-value canaries split across chunks, ANSI embedded
inside captured secrets, multiline captured values, valid/invalid UTF-8 and NUL,
dump continuations and an oversized dump opener, oversized secrets, escape-heavy
serialized events and final tails. No candidate is qualified
if a canary appears in persisted journal bytes or projected output.

## Finite production budget

New helper:
- packages/legacy-agent-host/src/adapters/providers/observeMemberProcessStderr.ts

Existing member/composition owners:
- packages/legacy-agent-host/src/adapters/providers/MemberProvider.ts
- packages/legacy-agent-host/src/adapters/providers/ClaudeMemberProvider.ts
- packages/legacy-agent-host/src/adapters/providers/CodexMemberProvider.ts
- packages/legacy-agent-host/src/composition/createRuntimeMemberProviderFactory.ts
- packages/legacy-agent-host/src/composition/RuntimeTeamCoordinator.ts

Existing writer and private contract:
- packages/legacy-agent-host/src/runtime/RuntimeOwner.ts
- packages/legacy-agent-host/src/runtime/RuntimeActivityCoordinator.ts
- packages/legacy-agent-host/src/runtime/providerActivityContracts.ts

Pure utility move and existing import compatibility:
- packages/legacy-agent-host/src/diagnostics/runtimeDiagnosticText.ts
- packages/legacy-agent-host/src/diagnostics/diagnosticsRedaction.ts
- packages/legacy-agent-host/package.json (utility exports only)
- src/shared/utils/runtimeDiagnosticText.ts
- src/shared/utils/diagnosticsRedaction.ts

Reuse Plan32's read whitelist, typed contracts, strict activity codec and
HostMemberActivityLog. Add a distinct top-level process-output variant; do not
implicitly allow it as a nested subagent fact. It is Output with actual stderr
provenance; the existing stream filter can exclude it. SDK/HTTP facts stay
unmarked. Search, rich copy, fullscreen and gaps use the existing viewer path.

RuntimeTeamCoordinator is 798 lines; the explicit two-line callback delegation
must fit at 800 without compression or a cap exception. Plan32's activity codec
is 794 lines: if strict top-level-only validation needs more than the remaining
space, extract the existing activity codec together with its private helpers
into one focused output-adapter module and import it, preserving every existing
call and decoder check. Move the existing five shared primitives (row, string,
boolean, oneOf, array) with that block and import them for the existing caller;
never copy them or import back from projectBackendResult to create a cycle. Do not distribute individual cases into unrelated files
or delete formatting to defeat the limit. Root must review the exact extraction
before its source commit; no other projection refactor is included.

Extend the existing desktopProofSupplementarySources roster with the actual
new/changed producers and reused diagnostic utilities; the importing root roster
already has 800 lines. Preserve its existing composition, without a new roster. Preserve existing source receipts, order and all other
pins. No provider archive, lockfile, RPC, schema version, retention increase,
workflow selector, timeout, default activation or Stage2 change is included.

## Required controlled acceptance

Use existing suites where their owned seam already exists:
- captured-claude-process / codex-member-provider: original stderr versus
  stdout protocol canary, finite subprocesses only.
- runtime-activity / member-provider-authority: opening failure persistence,
  original config/incarnation fencing, revocation, closing and cold read.
- team-activity-read / runtimeActivityFacade / hostTaskActivity: strict bounded
  projection, no fabricated task attribution, no conversation/Stats effect.
- hostLogStatsTabs: real stderr filtering, query and retained gap behavior.
- existing Windows provider/facade routing fixture: target stderr attaches before
  original resume; broker/control bytes remain absent.

The new capture helper may have one focused TEST suite if an existing suite
would mix unrelated ownership. Redactor compatibility must be covered by the
existing diagnostic consumer tests plus the capture canaries. The startup test
must emit through the factory callback before sessionRef is installed and then
reject open, retaining the diagnostic under held/open-unknown without inventing
input, terminal state, readiness or custody.

Extend only existing finite peers and desktop-emulated-runtime-ui. Emit a benign
stderr line during the existing bootstrap/stream sequence, no extra business
turn. Assert it within actual Team Logs; exercise stderr selection, search,
fullscreen, copy and cold reload, and prove it absent from exact task logs.
This is emulated application acceptance, not native Claude/Codex qualification.
The no-real-Claude/Codex instruction remains in force.

Estimated change: 180–300 new/changed production lines plus about 110 moved
utility lines, 180–260 targeted test/fixture lines. Complexity 5/10; review must
resolve redaction/framing and opening/closing identity before source publication.
The executor became unavailable on 15 November during independent Plan32 work.
Read-only GitHub source review and immutable candidate blobs are available; no
local execution PASS may be inferred. Use only existing authorized CI on the
reviewed exact commit for any unavailable checks. Keep all delivery holds explicit.

## Independent review record

R1 `/root` inspected the frozen raw-capture/parser path, current original-child
adapters, member factory authority and Runtime journal. R2 `/root/p09_review`
confirmed the pre-session opening record and the separate observational seam;
R2 `/root/qualification_audit` confirmed full OpenConfig/incarnation fencing and
required the framing, ANSI/multiline-secret, NUL and serialized-size clarifications
recorded above. Both retained the existing subagent observer unchanged and require
exact source review before publication. No source or acceptance PASS is claimed.
The executor was restored after the outage; local checks may resume on the exact
reviewed working tree. Missing checks remain explicitly unqualified.

## Exact implementation review and local controlled evidence

R1 implemented the three existing ownership layers; independent R2 root accepted
the full-config/source-grant Runtime fence and the cross-layer contracts. R2
`/root/p09_review` inspected capture framing, real original-child attachment,
redaction compatibility and cleanup. Root found a post-decoding byte expansion
case:10KiB invalid UTF-8 or NUL bytes can become30KiB sanitized UTF-8. The final
helper applies the24KiB bound to sanitized bytes as well and emits an oversized
gap. Both reviewers rechecked the correction and its two expansion canaries.

The pure redactor move preserves existing app behavior. The selected-value
classifier has a distinct purpose from the legacy assignment redactor and
covers already-held credential/cookie/private-key values without reading more
credentials. No equivalent existing selector was found; broadening the old
sanitizer would change its callers, so the small private selector is retained.

Root independently compared the codec extraction: all five primitives are
unchanged; the existing activity block differs only by the new top-level
stderr validation and rejection of nested or input-attributed process output.
Every caller outside the extraction is unchanged. The private decoder is317
lines and its existing caller500; RuntimeTeamCoordinator stays exactly800.
The existing supplementary source roster includes these actual producer/read/
renderer leaves and their reused diagnostic, Markdown and read-owner sources.

The final controlled Node24.21.0 run covers the seven existing/helper suites:
runtime-activity, member-provider-authority, member-process-stderr,
codex-member-provider, captured-claude-process, owned-process-facade and
team-activity-read. It passes92/92,0 skipped. The final six focused Vitest
suites pass62/62; three original diagnostic-consumer suites pass40/40.
Host build/test types, scoped feature/renderer/script TypeScript7, source-size,
architecture, scoped lint and diff checks pass. Actual graphical Desktop
acceptance and resulting-source native platform gates are still required.
No real Claude or Codex executable was used; the process suites use finite
controlled children.

Ordinary process facts do not alter messages, usage, previews, conversation,
readiness or custody. An explicit oversized/storage gap retains the existing
uncertainty policy, including unknown cost when evidence is incomplete.
Preserve that policy rather than inventing a diagnostic-specific exemption.

## Bounded capture follow-up on27b1

The published adapter hook, source-grant callback and full config/incarnation
fence are preserved. The follow-up reuses the existing escaped-assignment
redactor by moving it byte-for-byte to the browser-safe Host diagnostics
export; its old app module is a re-export. Three original consumer suites
pass107/107 with zero skips. No second parser or credential lookup is added.

Independent source review found and closed short-secret masking that could
destroy credential syntax, transformed held-secret fragments, overlapping
exact values, and an ANSI dump opener crossing the existing24KiB discard
boundary. Syntax is classified before exact masking; original and sanitized
held-value forms are masked in one union of spans. Unclassified ANSI loss
fails closed until the existing dump boundary. The24KiB capture/output and
32KiB serialized journal budgets remain unchanged, as do custody and stdout.
All seven published framing cases remain; the extended helper suite passes
19/19. The final seven-suite Host run passes106/106, zero skips.

The original Runtime-team composition tests additionally cover diagnostics
before SessionRef, failed open, permitted closing and rejected stale/revoked/
sealed grants. An actual Claude SDK launches only the finite TEST Node child
through the original CapturedProcess and retains startup plus final stderr
on failed startup; cleanup is checked. The six focused composition/outer-hook
cases pass with zero skips. No real Claude/Codex executable was invoked.
Resulting-source graphical/native gates remain required and unqualified here.

## R1: original standalone scheduled-process stderr

Review base: application `35cbd6e99b620e9b41802af936143d900f5e2aca`, with
checked provider source `9423f600dfb04d04448326dbced89919924b0b5f`. This is
a bounded continuation of P04 schedule parity and Plan33 process diagnostics.
Source implementation remains held until this plan and independent R2 are
published by the existing migration owner.

### Confirmed baseline and current gap

Frozen application `4a0e06277fe216d9f82dbbede362668fe46622ee` captures the
original scheduled child's stderr in `ScheduledTaskExecutor.waitForExit`,
with `STDERR_MAX_BYTES = 16 * 1024`. `SchedulerService` saves that stderr;
`ScheduleRunLogDialog` renders nonempty stderr in its existing separate `pre`.
This is independent of the rich stdout parser and of the task-first Team path.

Current `HostScheduledRuns` creates a standalone `ScheduledRunProvider`,
whose Claude custody launch and Codex app-server launch do not attach the
Plan33 helper. It has no Team endpoint and does not pass through the member
factory. Its final projection currently supplies only a generic retention
warning as stderr. Member-log parity therefore does not cover this baseline.

The original host-owned lifecycle, one captured occurrence, input admission,
custody, interruption, result, usage, summary and cold no-replay remain the
owners of execution. No OpenCode scheduled provider is introduced.

### Exact production changes

1. `packages/legacy-agent-host/src/adapters/providers/ScheduledRunProvider.ts`:
   add the optional existing `RuntimeProcessOutput` observation callback to
   `ScheduledRunProviderContext`. Attach `observeMemberProcessStderr` to the
   actual Claude child immediately after the original custody launch and to
   the actual Codex child immediately after its original app-server launch,
   before returning it to the existing SDK/byte transport. Pass the actual
   launch arguments. Preserve every original launch, currentness predicate,
   catalog preflight, stream owner and cleanup operation. The Codex catalog
   helper and unrelated processes are not scheduled targets.
2. `packages/legacy-agent-host/src/adapters/providers/observeMemberProcessStderr.ts`:
   make only its selected endpoint input optional. When absent, its private
   values consist of the already-held selected environment, argv and captured
   MCP values. Existing member endpoint/token/URL masking stays identical.
   Standalone schedules create no endpoint and no placeholder token. Reuse
   the complete35c framing/redaction implementation, including24KiB raw and
   sanitized UTF-8 bounds, ANSI/NUL handling, overlapping/escaped values,
   dump suppression, final-tail once and contained observer exceptions.
3. `packages/legacy-agent-host/src/composition/HostScheduledRuns.ts`:
   bind the callback to a cloned original binding and full normalized open
   request. Retain the original selected entry/team, capture/config/profile
   identities and principal before sharing the callback. Its separate source
   assertion checks the existing writer lease, the exact active entry and
   original Team control revision, immutable selection identities, the same
   retained recipe/source/workspace through `scheduledRunProfile`, and
   `capturedMcpSourceCurrent(profile)`. Never follow a new current-source pointer.
   Run that assertion inside the existing Runtime append fence, and contain
   its errors at the callback boundary. It performs no Runtime lookup or action.

The source assertion allows ordinary cancellation and Runtime record sealing
to proceed through original unreleased closing: `entry.cancelled` and a
Runtime sealed flag are not themselves source revocation. It explicitly
rejects `HostScheduledRuns.sealed`, writer loss, Team revision/revocation,
changed source/recipe/workspace/profile/config/entry and a replaced selection.
Host shutdown seals the composition first, so later diagnostics are refused.
This is the existing Plan33 policy; no post-Host-seal grant is added.

`RuntimeOwner.observeProcessOutput` remains unchanged. Its existing fence
checks exact profile/incarnation, full config and open fingerprint, permits
only opening/allocated/held/closing with unreleased custody, and applies the
original32KiB serialized-event budget and gap policy. Facts remain top-level
`{ kind: 'process-output', stream: 'stderr', text }` or the existing oversized
gap. No input, operation, task, child or synthetic SessionRef is attributed.

### Shared internal projection with scheduled Thinking

The sibling scheduled-Thinking R1 and this plan share exactly one optional,
computed internal field:

```ts
logProjection?: {
  thinking: RuntimeActivityEvent[];
  stderr: RuntimeActivityEvent[];
  truncated: boolean;
};
```

`runtime/activityContracts.ts` declares it and
`runtime/RuntimeActivityCoordinator.ts` computes it from the same retained
journal read. Original latest groups, ordering, byte accounting and global
`snapshot.gap` remain unchanged. Thinking, then stderr consume the remaining
space under the original aggregate256KiB snapshot limit. Only actual
top-level stderr observations are included, in journal order and with their
original IDs/sequence; nested child facts or input-attributed rows are not
reclassified. Auxiliary omission sets only `logProjection.truncated`.

There is no persisted cache, second journal/read cursor, polling owner, new
RPC or outward DTO. The existing outward snapshot mapper omits this field.
An actual original journal/storage/oversized gap retains its existing global
uncertainty semantics, including unknown cost. Auxiliary display truncation
alone cannot change the old Stats/cost/usage completeness decision.

`composition/scheduledRunProjection.ts` joins the retained sanitized stderr
lines by actual sequence. It keeps the first16KiB of UTF-8 display bytes,
ending on a complete code point. When the original gap, unknown observation
time, stdout truncation, auxiliary truncation or stderr cap requires the
existing warning, append that fixed warning once, reserving its bytes within
the same16KiB bound. With no retained stderr, preserve the existing warning
or empty-string behavior. The existing result schema stays unchanged.

Plan33 sanitation intentionally normalizes line whitespace and hides secrets
and dumps before persistence. Bounded journal retention may remove an old
prefix; the warning must acknowledge that loss. Do not reread raw process
files, recover unsanitized bytes, invent missing lines or replay a provider.
Keep stdout512KiB compatibility, final outcome and usage decisions, text-only
summary and the existing observed-time duration formula. Real diagnostics
reach the existing saved `.err`/dialog path without renderer changes.

### Finite verification

Extend existing tests only, retaining their original cases and deadlines:

- `tests/member-process-stderr.test.ts`: no-endpoint context still masks
  selected environment/argv/MCP canaries, retains ordinary text and final
  tail once; existing endpoint cases and all framing guards still pass.
- `tests/captured-claude-process.test.ts`: use its existing pinned finite
  Node-child setup with the real standalone provider adapter, once for
  Claude and once for Codex. Emit benign startup stderr and a final tail,
  then exit before native readiness. The original factory still rejects,
  the observer retains only sanitized actual stderr, no Session/input/result
  is invented, no Team endpoint exists and original cleanup is confirmed.
  This uses no Claude/Codex executable or model service.
- `tests/scheduled-run-host.test.ts`: use the existing controlled Session/
  Host fixture to prove opening facts before SessionRef, failed-open retained
  diagnostics without an input, permitted ordinary closing, Host-seal and
  writer/Team/source/immutable-selection refusals, neighbor isolation and
  no append after release. A cold read retains the actual original facts
  plus the existing cold-gap indication and never starts another occurrence.
- `tests/runtime-activity.test.ts`: verify the shared auxiliary view uses
  the same read and total byte bound, old latest/global-gap/usage behavior
  is unchanged, and top-level stderr is not promoted into child or input
  activity. Existing process-writer full-config/incarnation and serialized
  overflow tests remain the authority checks.
- The existing finite Claude standalone peer in
  `tools/owned-process-broker/fixtures/claudeProviderPeer.mjs` may emit one
  benign stderr marker during the already-existing `TEST_UI_STANDALONE_DONE`
  input. Extend its existing scheduled-host/renderer assertions to join that
  actual journal fact to saved stderr and the unchanged dialog `pre`, and
  verify cold read plus16KiB non-ASCII/retention behavior without new turns.
  `scripts/legacy-agent-host/desktop-emulated-runtime-ui.ts` is shared with
  the Thinking appendix and remains one root-owned integration. Its current
  Codex schedule flow is task-first; do not label it standalone Codex proof.

Run the affected existing controlled suites, Host build/test types, scoped
lint, source-size and architecture guards on the final exact source. The
existing Host Emulated lane already invokes `scheduled-run-host.test.ts`.
Add missing existing scheduled projection/capture/contracts leaves to the
current proof roster in the sibling plan; do not create another roster or
change selectors, deadlines, required gates or file caps. Original native
schedule/Desktop gates remain separate and require actual successful runs;
none is authorized to invoke real Claude/Codex in this session.

Estimated standalone increment:80–140 production lines across six existing
files, with the three snapshot/projection files shared with Thinking;
160–260 focused test lines plus fewer than15 existing peer/UI lines.
No new production file or framework is needed. Root owns the combined
snapshot/projection/fixture merge and publication; this R1 changes no source.

### Published review boundary

This is the reviewed R1 record as prepared above, with heading depth adjusted for
this existing plan. Root R2 accepts the exact scratch proposal SHA-256
`6849c5999c2bc4eb441697bc4764907b8d6aab3e9ad4cefd7d6a9aed1865915f` before implementation. R1 `/root/p09_review` and independent R2 `/root` confirmed the exact source-grant and shared-projection boundary.
This publication admits only its finite changes together with the sibling
scheduled-log amendment; existing migration and actual qualification gates remain.
