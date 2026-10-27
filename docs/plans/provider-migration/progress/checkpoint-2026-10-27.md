# Stage 1 continuation: 27 October 2026

## Main integration checkpoint

PR #982 remains Draft. Stage 2, OpenCode V2 integration, merge, publication and
activation remain outside this work. The existing P0–P8 / M01–M19 denominator
and the original native evidence limits are unchanged.

The isolated continuation started at `feadd83eccc487658d9fc06eb9f5f01d490938c2`.
Current main `d23f45ece051bda6b2343692b6c064ebf5b308b7` was incorporated by
`8ee6003698df2ae1136ebdf9310e1003ba1a4e4e`, preserving both histories.
All eight conflicts received an independent semantic review. A separate review
checked shutdown admission, renderer reload/loss, cancellation and late startup.

Close coordination preserves the Host branch's monotonic mount admission and
`uiHandlerObserved` proof together with main's acknowledged-save timeout and
late-result warning handling. Renderer load state does not bypass the mount gate.
Provider setup diagnostics retain the captured request scope and the existing
Host management port. Legacy OpenCode readiness/delivery fixes from main are
retained without adding a V2 Host driver or fallback.

Verification for this exact merge checkpoint:

- Local Host and task-change-ledger builds passed.
- The focused Vitest run passed **91 tests in 12 files**, with no skips: existing
  close coordinator/preload/mount/registry, shutdown order/MCP, provider setup
  diagnostics, OpenCode handshake/message delivery and installer controls.
- Fast lint of the eleven resolution/adaptation files, `git diff --check`, source
  size guard (4,614 production files) and Team Provisioning architecture guard passed.
- Canonical `pnpm typecheck` was killed with exit 137 during the first compiler
  invocation under local resource pressure. No typecheck PASS is claimed.
- Exact-head full CI was dispatched as
  [run 40539001594](https://github.com/777genius/agent-teams-ai/actions/runs/40539001594).
  All eleven required jobs subsequently passed, including `Full qualification`.

The local test command used `pnpm exec vitest run --maxWorkers=1` with:

```text
test/features/app-close-coordination
test/main/index.shutdown-order.test.ts
test/main/services/team/ShutdownMcpTransport.test.ts
test/main/features/runtime-provider-management/providerSetupDiagnostics.test.ts
test/main/services/team/OpenCodeReadinessHandshake.test.ts
test/main/services/team/OpenCodeMemberMessageDeliveryService.test.ts
test/renderer/components/cli/OpenCodeV2InstallAction.test.ts
test/features/opencode-runtime-installer/installAction.test.tsx
```

## Source Desktop qualification route

The existing CI workflow now has an optional `stage1_desktop` dispatch input.
It runs the existing mixed Create/Launch, native Create and stopped import-only
modes on an actual recorded macOS arm64 runner, using pinned provider executables,
the captured Host Node 24.21.0, disposable TEST state and localhost inference.
The original retained receipt must report `PASS`; an `INCOMPLETE` receipt fails
the job. The shell-environment TEST sentinel accepts the exact nonce-framed
probe introduced on main without evaluating shell input.

The normal workspace-test shard also runs the existing Host package test command
once with the captured Node 24.21.0. Ordinary frontend checks alone do not qualify
the Host package.

This workflow change is a route to new evidence, not a native/UI PASS. Packed or
installed qualification, vendor authentication and another OS tuple are not
inferred. The stopped import-only mode still does not qualify Launch Submit.
The frozen 23 October progress report is preserved as a historical snapshot.

## Active confirmed gaps

The confirmed Edit Team defect is corrected through the existing dialog and one
Host roster replacement. The original saved revision, saved settings, edited
presentation and complete roster are committed together. The old `updateConfig`
writer is not called for a Host handle; authoritative saved presentation also
feeds Team and global Task reads.

The existing Main application command ledger retains the exact roster intent
before dispatch. Renderer reload or dialog reopen cannot introduce a new command
while the previous outcome is unknown. Roster hydration reconciles only the
original command/payload at its captured Host; missing receipts retain HOLD.
Completed Main replay still requires a current authorized Host lookup. Standalone
HTTP composes the same existing storage/ledger features; missing durable storage
refuses roster mutations while preserving ordinary reads. No second journal or
new Team mutation is introduced.

For this focused correction, **108 tests in seven existing/new focused files
passed**, including seven SQLite reconstruction/error/authority cases, facade and
roster contracts, selected Desktop composition, existing Edit Team and Host reads.
The new guard and transport composition received an independent review; the
standalone omission it found was fixed before commit. The finite native source
closure includes the new dialog helper, guard and reused ledger dependencies.
Canonical typecheck with bounded compiler parallelism also ended with exit 137
under local resource pressure; no new native/UI or final exact-head full-CI PASS
is inferred from these focused tests.
Typed definitive pre-admission refusals remain terminal rather than unresolved
debt; a rejected stale save can reopen and submit a new intent. The existing
dialog also permits correction after a known refusal while retaining UNKNOWN
payload/identity protection. No error-message text is used to infer the outcome.

Actual stopped import → existing Launch Submit, final mixed Desktop acceptance,
packed/installed workflow, complete M01–M19 qualification and the original M19
custody HOLD remain separate obligations. No timeout, readiness, authority or
process-custody guard is relaxed to clear them.

## Stopped import → native Launch preparation

The existing stopped-import smoke now has an explicit
`LEGACY_DESKTOP_STOPPED_IMPORT_LAUNCH=1` continuation. Its original import-only
variant is retained. The continuation stages synthetic stopped solo product/run
records and uses an actual source-owned TEST Node child with the existing
`spawnCli` / captured stop / `markStopped` owners. It does not claim source
provider inference or historical native session adoption.

The existing Launch dialog then edits the saved prompt and permission choice,
submits its ordinary button once, observes the actual SDK/CLI Task/Bash/reply
oracle, stops through the ordinary control and reloads the same saved settings.
The exact source files, single import publication and retained imported Task must
remain unchanged. A fourth variant in the existing optional CI job requires the
original native continuation receipt to be PASS; import-only cannot satisfy it.

Local preparation verification: the actual captured-source child stop test passed
with no skips; strict `typecheck:legacy-host-scripts` passed. The combined fixture
run passed nine cases and failed three pre-existing macOS fixture preparations
because this Linux checkout has no staged darwin-arm64 Node artifact. This does
not qualify the actual Launch continuation; that remains the remote macOS job.

The first source CI attempt on `bbf176ae1` stopped before native allocation at an
ESM-only package resolution mistake in the new workflow. `990f8da76` fixes that
bootstrap. The next attempt passed bootstrap on the actual tuple macOS 15.7.5 /
build `24G624`, then exposed the fixture assertion about macOS-injected
`__CF_USER_TEXT_ENCODING`. The fixture now checks exact nonce framing and its
owned TEST value while narrowly accepting the demonstrated Core Foundation field.
No production environment probing or qualification tuple was weakened. Existing
packed custody qualification for build `24G90` does not qualify build `24G624`.

## Reproducible Host unit gate

Adding the existing Host package suite to full CI exposed two tests depending on
untracked `native-events.jsonl`, `before.txt` and `final.txt` from the historical
OpenCode probe. The tracked manifest retains their digests and sizes; the raw
31,446-byte native log is not available in the checkout or reviewed archives.
Those two tests now use an explicit synthetic, self-contained V1 payload fixture
for exact dirty-preimage application and rejection of externally appended bytes.
Both tests and Host test typechecking passed. Historical native evidence is
unchanged, and this unit conformance result is not new native qualification.

## Affected lifecycle/readback qualification

The optional source CI route also selects existing active-input Quit and
pending-open Quit scenarios, each followed in the same job by the existing cold
Quit readback. The original PASS receipt's exact root and SHA-256 are passed to
the readback; the source phase is never retried. Existing cold selected Resume,
native review followed by its original cold readback, and offline Task board /
cross-Team controls cover the corresponding changed ownership/shutdown/review
paths. Both source and readback receipts must report PASS.

The nine variants have distinct artifact identities. YAML, all eight shell run
steps, embedded JavaScript syntax and whitespace checks passed; an independent
review found no blocking workflow issue. These are selected existing acceptance
routes, not new native results or a replacement for the unchanged M01–M19 matrix.

The existing mixed Create/Launch smoke now also exercises the changed Edit Team
path before native allocation: its original description control, one Save, exact
same-owner settings/roster/receipt checks, renderer reload, and reopening/canceling
the same Edit dialog. It then continues the existing native mixed launch/group/
member-restart workflow. Strict script typechecking, whitespace and independent
review passed; actual Edit UI acceptance awaits the next exact-head run.

## Confirmed inactive-roster import defect

Final backend review reproduced a stopped import losing the functional removed
roster: the original metadata archive retained a removed teammate, but the new
owner's `removedMembers` was empty, so the existing Restore action had no target.
The source snapshot and existing owner bootstrap now carry only validated inactive
identity/settings/removal-time metadata. No source grants, delivery selectors or
runtime authority are imported. Restore uses the existing roster CAS and retains
the member identity and configured choices.

The optional header field is omitted when there are no removed rows, preserving
the prior normal header shape. Defined numeric epoch zero is a removal timestamp;
invalid shapes, duplicate identities, lead rows and native authority are refused.
Old snapshots with no new field retain their prior import/state shape.

Focused verification passed: source/export/import/cold-read/Restore **13 tests**,
portable stopped import **14 tests**, Host build and test typechecking, fast lint
of the eight changed files, source size and provisioning architecture guards.
An independent implementation review requested the empty-header/epoch-zero
compatibility checks, which passed before commit. Native/UI acceptance and final
exact-head CI remain separate from this product-data regression proof.


## Original Create intent and definitive refusals

Final UI review confirmed that a known pre-dispatch Create rejection was losing
its typed outcome through IPC and leaving the form permanently attached to the
old command. The existing Create response now carries a finite refusal envelope;
the renderer reconstructs its typed error and releases the retained intent only
for that proof. After a Host submit rejection, the same captured owner must prove
absence of the original registry command and expected draft before correction is
allowed. Published/pending/held intents, failed lookups and changed authority stay
UNKNOWN with the original command. No mutation is replayed by this correction.

The author ran **32 focused tests in five affected suites**, bounded strict
typechecking of the new contract/registry/renderer closure, fast lint and source
size checks. Independent integration and root reviews accepted the original-owner
absence fence and transport. Canonical whole-project validation remains a fresh
remote exact-head obligation. The two new production helpers are in the existing
finite native source closure.


## Actual source UI results and bounded diagnostics

Run `40543867901` on `fe6449efd` completed all normal checks/full qualification
and the actual native Create UI scenario successfully. This qualifies that source
Create route on macOS 15.7.5 / build `24G624`; it does not qualify packed/installed
custody, Edit, the mixed route or stopped-import Launch. The mixed readiness wait,
import-only original Download wait and import-to-Launch source custody gate failed.
Their receipts remain INCOMPLETE; no native acceptance is inferred from unit PASS.

The import continuation now records bounded read-only source directory/file
identity, hashes, release/census markers and comparisons from the captured Node
and Electron runtimes before its one Launch click and on failure. It never
repairs or republishes proof, looks up a process or retries Launch. Strict script
typechecking and an actual Linux child-stop/read-only diagnostic check passed;
the macOS cause remains unconfirmed pending the next actual run.

The import-only Download harness now applies the existing captured Page download
policy to its isolated TEST Downloads directory and records that context before
the same original click. Its 45-second budget and exact byte/SHA checks remain.
Strict script typechecking and independent review passed. Diagnostic artifacts
retain hidden owner state under the existing TEST hoststore plus the two exact
synthetic source Team/Task directories, without collecting a user home.


## Same-owner Task reference identity

Whole-PR UI review confirmed that global Task suggestions offered another Team's
Task while the captured Host mutation adapters rejected every foreign selection.
Existing Create Task, comments and prepared local/group Composer controls now
translate explicitly captured same-owner Team selections into finite immutable
Task reference metadata using the existing resource UUID. They never select a
foreign filesystem root, grant authority or infer a binding from a mutable name.
Reads resolve only the exact resource under the same owner; a purged/recreated
Team remains an explicit unavailable opaque reference. Different owners are
refused, and self references retain their existing canonical representation.

Only the specific Host TaskRef validator accepts this finite metadata token; the
generic safe filesystem segment validator is unchanged. The existing Main Task
snapshot projection also now retains its allowlisted prompt/promptTaskRefs, so
these configured references survive actual mapper/readback rather than only
mutation receipts. No new storage or routing framework is introduced.

Two independent critics accepted the identity/metadata/path boundaries. Final
focused verification passed **62 tests in four suites**, including actual Main
mapper readback, Task/comment/prepared Composer/group refs, different-owner
refusal, purge/recreate isolation and unchanged self routing. A bounded strict
compiler closure, precise fast lint, source-size and provisioning guards passed.
Whole-project and actual Desktop exact-head qualification remain remote gates.


The existing renderer failure snapshot now retains a bounded passive mixed
progress timeline and the selected/visible TEST Teams' original current run,
progress, diagnostic and ignored/floor/error state before normal Quit. Existing
hidden owner records are retained by the artifact step. Strict script
typechecking, embedded expression parsing, independent review and whitespace
checks passed. This supplies missing evidence for the mixed aggregate failure;
no readiness wait, display predicate or native effect is changed by this probe.


## Captured Host member presentation

Independent UI/backend review confirmed that the legacy native Codex process
heuristic marked a captured Host Codex member stale despite the original Host
runtime being ready. The Host view now supplies a presentation-only provenance
marker for its active and removed snapshots. It excludes only that view from the
legacy process heuristic; no PID, runtime liveness, selected backend or provider
setting is invented. Explicit offline/error/skipped/removed states and the closed
Team guard retain their behavior. The member memo comparator includes provenance
so an otherwise unchanged row refreshes correctly.

The author passed **99 tests in three affected suites**, precise seven-file fast
lint, bounded strict typechecking and the source guard (Host adapter 795/800).
An initial external RAM exhaustion failed before collection; after capacity was
restored, unchanged assertions passed. Two independent integration reviews
accepted the presentation boundary. Actual native mixed/UI acceptance remains
open until a new coherent exact-head run.


## Frozen final baseline and canonical syntax repair

Main advanced by one reviewed commit while the integration was being checked.
After the presentation checkpoint, exact `7eb878f88af355334547ab526034ca1c2bf961ab`
(Auto environment fallback and stale provisioning status retirement) was merged
without conflicts. Two independent compatibility reviews approved these three
production changes; later unrelated main commits are not chased for this run.
The six affected main suites passed **249 tests**, and the actual nonce-framed
TEST shell fixture passed **5 tests**.

Automatic CI `40551607609` exposed a real compiler gate failure in the new
Create refusal class: constructor parameter properties are forbidden in the
canonical erasable-syntax script closure. Explicit readonly fields and ordinary
constructor assignments preserve its behavior. Both actual canonical updater-e2e
and sentry-e2e typechecks now pass, with **17 Create refusal/readiness tests**
also passing after the repair. Applying that flag to the unrelated full M12 test
closure was not a valid qualification command and produced baseline syntax
errors; no unrelated classes were changed. Whole-project CI remains required.

The finite native source list now also pins the presentation predicate/memo
consumer and the current main environment/runtime refresh paths. Fast lint of
the syntax repair and three incoming production files, source-size/provisioning
guards and whitespace checks passed before the merge checkpoint.

The available macOS runner advertises macOS 15 and has demonstrated build
`24G624`; no configured build `24G90` runner is advertised. This does not transfer
the historical packed custody qualification to the current tuple. Packed/
installed M17 and the original M19 custody HOLD remain explicit unresolved
qualification obligations. PR remains Draft; no merge, release or activation.


## Current source Desktop run and reviewed follow-ups

[CI run 40553118520](https://github.com/777genius/agent-teams-ai/actions/runs/40553118520)
finished on exact `6c8e79a57331c9cb4c4cf7a9f6223554b08cff81`. The original
receipts remain unchanged. Its overall conclusion is **failure**, not acceptance
of later fixes: canonical validate/build/typechecks, main/renderer lint and test
shards 1, 2 and 4 passed. Feature lint found one unnecessary non-null assertion;
`974f79b26` removes only that assertion. Test shard 3 and the Windows ledger smoke
both found the same old exact TEAM_CREATE failure-envelope expectation;
`692729836` updates that exact assertion, preserving the draft-only and no-legacy
writer checks. The affected IPC suite passed **270/270** after that repair.
The Windows original run had **1240 passed, 5 existing skipped, 1 failed**; its
failure is not a second product defect. Full qualification remains failed for
this original run and must be rerun on the final pushed source.

| Original source Desktop case | Observed result | Boundary retained |
| --- | --- | --- |
| Create with native launch | PASS | Actual SDK/CLI/MCP, original native work and Stop/released; dev wrapper required SIGTERM after that proof, so natural app exit is not claimed |
| Pending-open Quit and cold readback | PASS | Original physical group absent and app exit0; Runtime remains held/unknown, and cold startup adds no allocation/input |
| Active-input Quit and cold readback | PASS | App exit0 without signal, original group absent before cleanup, cold Runtime/product state unchanged |
| Native review and cold readback | PASS | Original Changes actions, exact mixed bytes/decision history and cold readback without new allocation/input; partial evidence remains nonreviewable and wrapper SIGTERM is not natural Quit |
| Cold selected Resume | PASS | Same profile across guarded Quit/startup, explicit selected checkpoint/history and second Stop; app exit0 without signal |
| Mixed Create/Launch and Edit | FAIL at aggregate launch progress | Original Edit subproof passed one CAS and reload. Durable native attempts became ready, but the earlier opening observation had already been stored as disconnected in the renderer |
| Existing Task board/cross-Team controls | FAIL before the original drag | No drag or order command occurred; the Manual choice remounted the board, and the harness reopened its already-closed sort popover |
| Saved legacy import only | FAIL at external TaskRef observation | Attachments, exact download bytes and internal destination navigation passed. The actual captured source result opened the existing Task tab; the harness incorrectly expected a dialog |
| Stopped legacy import followed by native Launch | FAIL before target Launch | The original native release proof was valid at preparation, then legacy background writers changed the source inventory; the canonical refusal is retained |

Retained receipt SHA-256 values for the successful cases:

- Create: `08c97b16b4fb6266170ba30def434ef455eab9353675ad21f7baadc5179d27d5`.
- Pending-open Quit: `2f1dc4dce478675b77cb194e747df0d56487cb74946703075397116818118eee`;
  cold readback: `4a41c1c550d8c1db03e5ac04b89f1a4cdc36406aa2bd14d1e2d262caa44d0f8e`.
- Active-input Quit: `2fb5ed48f4bd241c6567ca8ff8ce64218df68c9012cbcdc27ea1959fd6d4de7a`;
  cold readback: `727c9e399dd1df307f24cdbbd5fe982b87c5f457d65b45e00bc586051042c77a`.
- Native review: `919cb9e3029f97c4040f5b8aa75346ae4813487998f75bce43505f3481154f2a`;
  cold readback: `aa74c6d7acc2176d3634404512e714fea2b77e1075b0782b31a530c07819dc81`.
- Cold selected Resume: `b36a937e0d7bb8e1e516082462a76d3c1b3027aa63b5acc7749876da33b3d97c`.

### Narrow fixes already pushed after the original run

`3375c1306` keeps a known current in-flight native factory in
`pending-bootstrap/opening` only after exact binding/config validation, with the
original live continuation, current Host incarnations, unexpired deadline and
no unresolved retained interaction. Native readiness, work/control availability
remain false and Runtime custody remains unknown. Cold, completed, expired,
unavailable and revoked cases do not gain authority. The actual RuntimeOwner
regression failed before the patch and the existing team-launch suite passed
**22/22** afterward, including seven negative cases. No renderer terminal rule
or retry policy was relaxed.

`2036bf13d` removes the redundant sort-toggle click, uses the existing real-wheel
scroll helper and verifies hit targets before the one original drag. `0072ba91a`
checks the actual external-source Task tab: captured context/team/task identity,
current read entry with null task and unavailable/missing phase, matching active
session surface, visible page and exact selected tab. It closes only that tab
through the existing control before the next reference. Neither patch changes
production navigation, mutates store state from a read, retries a business action
or reduces the original timeout. Strict scripts typecheck, formatting and diff
checks passed; new native/UI acceptance is still required.

### Import writer boundary and remaining native membership proof

The retained source diagnostics now disprove the earlier runtime-precision
hypothesis: Node 24.21.0 and Electron's Node 24.22.0 reported the same directory
identity, including birthtime nanoseconds. The canonical reader instead reports
`Incomplete solo native inventory`. Existing work-sync lifecycle adoption adds
`_backupIdentityId` to config; its router also materializes member metadata and
later inactive reconciliation creates `.member-work-sync` state. The original
strict census refuses these changes. The proposed next repair is a narrow
admission/publication fence for positively qualified stopped sources at the
existing legacy writer boundaries. It must preserve active/UNKNOWN old owners,
source directory identity and backup/restore lifetimes; no source proof repair,
late fixture baseline, deletion purge or census allowlist relaxation is accepted.

This is the selected finite stopped-solo source shape. A legacy config that
already contained extra lifecycle metadata before Stop is not newly qualified
by that repair. General historical-format import and the original M19 custody
HOLD are not claimed complete.

The plan review also confirmed a missing actual-SDK boundary for additive native
membership. An optional continuation of the existing solo Create scenario is
now implemented: one lead Do input uses `team_member_create`, the original read-only
lookup, explicit addressed work and a real peer reply; subsequent original lead
inputs prove the current roster reminder exactly once. Existing lead bindings,
grants and prior work must remain unchanged, then ordinary Stop/reload must
retain the new member and release both sessions. This is the same harness and
existing UI, with a separate tenth CI variant whose gate requires its own proof.
It is not yet a native PASS. No generic hot roster CAS or production default
change is introduced.


The optional native-add proof implementation passed the existing strict Host
test and Desktop-script typechecks, six model-oracle admission/identity tests,
source/provisioning guards, ten-variant YAML/shell syntax and all three embedded
JavaScript checks. Two independent final reviews accepted the original-command
lookup, one new allocation, exact retained product/receipt identity and actual
request assertions. The original captured saved Opus/medium values are frozen
once with the input; omitting the optional peer model deliberately exercises
the existing configured inheritance path, and every actual peer request must
carry those values plus the configured role/workflow. No production inheritance
code changed. The finite source closure has **1329 files, missing 0**. These are
fixture/compiler/review results; actual native-add acceptance is still pending.
