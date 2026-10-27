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

## Exact 7415702 source run: native addition and remaining failures

[CI run 40559325843](https://github.com/777genius/agent-teams-ai/actions/runs/40559325843)
completed with **FAILURE** on the full source gates and ten separately gated
Desktop variants at exact `7415702c69513dd709f301fc51299ddca3859867`: eight
Desktop variants passed; mixed launch and stopped-source/native Launch failed.
Canonical validate, all three
lint shards, all four test shards and the Windows ledger smoke passed. The
`Full qualification` aggregation also passed, but it does not include the
optional native jobs and therefore is not complete Stage 1/native acceptance.
Later source changes must receive their own qualification.

The new **solo Create plus native persistent teammate** job passed. Its original
receipt is retained in artifact `12759326202`,
`stage1-source-desktop-native-create-member-7415702c69513dd709f301fc51299ddca3859867`;
receipt SHA-256 is
`619df172fa55876376cf0bda26b142d25d53985084a9dfebc2bef0c0ac34e548`.
The actual lead SDK/MCP flow created one persistent peer, performed the original
creation lookup, delivered addressed work and received the peer reply. Five
original inputs succeeded (four lead, one peer). The original creation receipt,
member IDs/settings and captured bindings were retained. The next original lead
input contained the current roster reminder exactly once, with no repeat on the
following input. Ordinary Stop released both sessions; reload retained the
member. The app exited with code 0 and no signal; its process group was empty
before harness cleanup and the captured Host was absent.

The original native-add receipt did not retain the separate raw
`nativeMemberObservations` array: the evidence object was created before the
first inference, and an initial `array.length` condition omitted the then-empty
array. The actual helper assertions still ran, but raw request retention is not
claimed for that original receipt. A one-line collector repair retains the
existing array reference by presence for future runs. Historical evidence is
unchanged.

The stopped-source import/native Launch job failed before target Launch. Its
receipt SHA-256 is
`f2065bad7a9410f8c067428ebb4b7c9e7e8b80d2803af2482d8d534a176f466c`
in artifact `12761410748`. The same config lifecycle marker, comment-journal
replica and WorkSync/member files changed after the original Stop. Additionally,
the passive Electron snapshot observed a transient
`group-chats.json.lock-transition-v2`: ordinary group listing used the legacy
write lock for a read-only callback. The canonical reader still correctly
reports `Incomplete solo native inventory`. The fix under review keeps the
original directory/owner admission through physical writes and adds a pure
single-registry read for listing. No source proof or census rule is relaxed.

The mixed Create/Launch job also remains failed; receipt SHA-256 is
`e6f98da6fded3555608462e808e1b316e8985f9fb568ca460d56929c54d8aed6`
in artifact `12761106754`. The opening fix is effective: this run's renderer
store received authoritative aggregate `ready`, `Team is ready.` and all three
bootstrap confirmations. The visible original progress block nevertheless
remained at `Finishing launch` / `2 teammates still joining`. The existing
presentation requires per-member spawn observations, while the Host Teams API
currently rejects that existing read operation as unsupported. A narrow
owner-qualified read projection is being independently reviewed; no timeout or
readiness assertion is weakened. The original Edit CAS/reload subproof passed
again. Failure cleanup exited naturally with code 0 and no remaining group.

Fresh holistic review also found that both Create submission hooks retained the
command only inside the dialog instance. The actual Team list conditionally
unmounts that dialog, so an uncertain submission could acquire a fresh command
on reopening. The reviewed repair now retains one finite application-lifetime
intent qualified by owner, operation and product draft, with an in-flight fence.
Changed owner/draft/operation stays held; only the original current success or
supported finite launch refusal frees the slot. Focused regressions use a real
unmount/remount. Existing draft storage is reused; missing copied overrides
remain an explicit unchanged-draft HOLD rather than an invented new draft.
The two existing focused suites passed **25/25** tests, including actual
unmount/remount, pending calls, original-owner replay and finite refusal. Scoped
formatting, fast lint and diff checks passed; an independent critic accepted the
fix. The new helper and regression are explicitly included in the finite source
closure. Canonical project and actual Desktop qualification of this new source
repair remain pending; no durable renderer-reload guarantee is claimed.

The original M19 custody HOLD, unavailable packed M17 build `24G90`, broader
historical import formats and the remaining current native variants stay open.
PR remains Draft; there has been no merge, release, publication or activation.


## Pure group catalog read checkpoint

The existing Main group storage now supplies an optional pure registry snapshot
read. The portable group list uses it when available, while older storage ports
keep their original `withRegistry` fallback. Missing and malformed records retain
the existing results/errors; group mutation and admission paths are unchanged.
This removes the transient writer-lock publication observed by the stopped-source
census without relaxing that census or hiding any source file.

The new real-filesystem regression preserves missing/valid/malformed storage
bytes and directory entries and explicitly asserts that listing never enters the
existing writer port. An isolated copy of the prior list implementation failed
that assertion with exactly three writer entries; the current implementation
passed. The full existing integration file executed **35 passing assertions**;
its remaining MCP transport case timed out because local `mcp-server/dist/index.js`
is absent, so the complete file is **not qualified as passing** here. A direct
actual portable-feature check confirmed the old storage-port fallback is invoked
exactly once. The complete portable group test runner stalled before its first
result in this local recovered tooling; only task-owned verification processes
were stopped, and no package-suite PASS is claimed. Scoped production fast lint
and diff checks passed. Fresh CI with the normal build remains required for the
full package/MCP and actual stopped-source acceptance.

## Additional exact 7415702 Desktop receipts

The same source run `40559325843` also passed the following existing UI gates.
These results belong to `7415702c69513dd709f301fc51299ddca3859867`, not to the
later group-read, Create-retention or pending import/status fixes.

| Original gate | Artifact | Original receipt SHA-256 |
| --- | --- | --- |
| Active-input Quit | `12760174307` | `e21f91aae22b93784fa41798a5ac88cecc7b25177411e9cd9d2fda6915bbd017` |
| Active-input cold readback | same artifact | `873133f7a11dab494d029d965ce30c34276c7961f0f1d820db27f8d219a4ce9d` |
| Pending-open Quit | `12761984327` | `31c1d020b92ae0881c1712a31c131d868f701d7fd21421e50b1ca77811f9c83a` |
| Pending-open cold readback | same artifact | `0b784e374ddd8ab7956275155bf5fe6807287332eeca9128040c17db3e16e818` |
| Native review | `12762545090` | `2f307f4c11793fec690adf6d639ea7717bc71c52a7f7987c1cbdd79ddb36e65c` |
| Native-review cold readback | same artifact | `b75e916ef5fa65c64bef7d2258c4d61d55acbb1865867645216a3e45e407a75d` |
| Existing Task board and cross-Team controls | `12761524109` | `38f8ce794c28fdc3a36e6d6afa6f10e262b8ee669a8d9a765dfaf6f0938312f9` |
| Cold selected Resume | `12762004657` | `36307ecf5ff5b4b7babff299023d6e62ed6a026dae2070049a363ecaad94fe19` |
| Original Create with native launch | `12761828746` | `e33b25507ef985ee5f2b216357726918378ebf276a929d79c2ccd8c50650180b` |
| Saved legacy import only | `12761034984` | `af4bb267887decc87f06067cc141d6ca6c73388061d7cbe52e47ff4ee1ce2aa9` |

The Task board gate used the original dependency picker, assignee/resolve and
blocked Start/Complete controls, actual sortable-card drag, attachment operations,
review/correction/approval history, notification navigation/delete and original
cross-Team Send/Reply. Its Mark-as-read control was unavailable because the
original viewed notification was already read; that action is not newly claimed.
Root visually inspected the retained reordered-board and approved-task screenshots.
This is a canonical offline UI proof with no configured provider sessions. The
receipt records remaining dev processes and harness SIGTERM, so natural app exit
or native custody is not inferred from this UI PASS.

The Resume gate retained the original selected checkpoint/history through guarded
Quit and same-profile cold startup, then used the original Resume and Composer
controls and a second Stop. Both captured app epochs exited with code 0, no signal,
empty owned process groups and absent Host; the first epoch released its writer
lock. Root also inspected its original resumed native UI screenshot. Active-input
Quit and native-review source/cold receipts separately report PASS, natural exit0,
no signal and empty groups before cleanup; cold readback did not start a new native
session.

Original Create confirmed scoped preflight, one created Team/native session,
actual SDK/MCP/Bash/reply, Stop and settings after renderer reload. Saved import
used a **never-launched draft**, retained original import identity through reload
and closed the existing Launch dialog without Submit. It does not qualify the
separate previously-launched stopped-source/native-Launch failure. Both of these
receipts record harness SIGTERM and remaining dev processes before cleanup; their
scoped workflow results do not establish natural app exit. None of the inspected
receipts had refused or post-Quit/cleanup sentinel invocations. Vendor model
qualification, full P4/P8, packed M17 and the original M19 custody HOLD remain open.
The pending-open Quit and its exact linked cold readback also passed: both
original receipts report exit code 0, no signal, empty process groups and absent
Host. Cold readback started no new provider, and refused/post-Quit sentinel
counts remained zero. Root downloaded and read those original receipts.


## Captured Host member spawn read checkpoint

The existing Host Teams API now implements the existing per-member spawn-status
read from the captured `launch.configuration.read` projection. It retains the
original connection/context and launch read fence, uses the same qualified run
identity as aggregate progress and excludes the configured lead from teammate
milestones. A member is presented online only for authoritative ready, usable and
native-ready observations. Pending, permission, unknown, failed and skipped
states retain distinct existing presentation states; no process ID, heartbeat,
control grant or native readiness is fabricated. This addresses the confirmed
mixed UI case where aggregate progress was ready but absent per-member reads
kept the original banner at `Finishing launch`.

The author reports **80/80** focused tests passed (25 new projection/fence tests,
40 existing Host reads and 15 provisioning tests), including actual Main
projection through the shared presentation helper. Bounded strict TypeScript 7,
scoped fast lint, formatting and diff checks passed. The lead additionally
removed one confirmed unnecessary non-null assertion and reran its exact typed
lint rule and the affected 25 tests. An independent critic
reviewed the completed helper and exact three-line API wiring and accepted them.
Both new helper and regression are explicitly source-pinned. Actual mixed
Desktop acceptance and canonical project qualification on this changed source
remain pending; the earlier failed native receipt is unchanged.


## Finite corrective Create refusal checkpoint

Both existing Create operations now preserve the same finite refusal envelope
through their original IPC channels. Legacy launch validation and save-only
request parsing may report `invalid/not-dispatched` only before entry into the
Team/native writer. This is **not** a universal filesystem no-effects claim:
legacy validation may create the selected cwd. Save-only Host Create forwards
only the existing branded refusal; its original registry create/lookup path must
still prove the original command absent under the captured current owner.
Generic post-dispatch errors, unavailable or pending lookup, malformed envelopes
and changed-owner results retain UNKNOWN/HOLD. No message-string inference or
blanket catch-to-refusal conversion is added.

The existing preload supplies an optional raw save-only result, and the renderer
shares the finite decoder/decorator between launch and save-only Create. Legacy
save-only success without a DTO remains supported, original receivers are
preserved and each operation performs one original bridge invocation. The
application-lifetime intent can be corrected after a proven current refusal in
either mode; uncertain outcomes keep the original intent through unmount.

The author reports **312/312** tests passed across four existing suites (276 Main
IPC, 16 actual unmount/intent, 13 refusal transport and 7 real Host registry
cases). Scoped fast lint and formatting passed for all ten changed files;
bounded strict TypeScript passed for the decoder/registry/adapter closure.
Independent actual-code review accepted the unit, and integration diff checks
passed. Main/preload full-project typechecking and actual Desktop qualification
on this changed source remain pending. The finite source list explicitly covers
the two additionally affected existing regression files; no closure was generated
from unfinished stopped-source admission work. A whole-working-tree source-size
PASS is not claimed while that separate work is still in progress.


## Holistic review of 7e3ea01: Task intent and group association follow-ups

An additional independent Sol 6.1 xhigh critic reviewed the committed
`7e3ea01aa2bcb8ad085ba57ae9ecc41da2178bf7` tree separately from the unfinished
source-admission patch. The review found two concrete existing-workflow gaps:

- Task detail retains a failed comment draft but the Host adapter allocates a
  new command UUID on every `addTaskComment` call. After a committed response is
  lost, an unchanged retry can create a second comment and notification. The
  exact committed adapter reproduced two mutations with two IDs for one unchanged
  request after UNKNOWN. This is a focused adapter reproduction, not native proof.
- Original Create Task carries `groupChatId` from a selected group/message, but
  Host input allowlists, Team task contract and read/result projections omit it.
  The existing group-origin action is rejected before dispatch. Dropping that
  field would lose existing product semantics and is not an acceptable fix.

The same review identified `CreateTaskDialog` clearing its pending command ref
on close/open; root confirmed the source path. Its existing unchanged-submit
identity works only while that component state survives. The follow-up retains
original Task create/comment intent through actual unmount and session retirement,
with original-handle lookup for UNKNOWN and revision-safe preservation of newer
comment edits. A lookup rejection or missing receipt is not proof that the old
effect never happened. Existing text/chip draft storage has TTL and memory fallback;
no renderer-reload durability guarantee or new generic command journal is assumed.

Group association is a separate bounded correction. It must preserve the actual
legacy semantics: a new association requires a valid UUID and an existing active
group in the same Team's persisted catalog; missing/foreign/archived groups and
an absent default group are rejected. A completed original create remains
replayable after later archive. Contract/projection changes alone do not close
this gap; existing group-owner admission and original UI qualification are required.

The source-admission unit is still under review. Additional concrete checks cover
multi-Team queue context, delayed backup/comment continuations, explicit deletion
compatibility, runtime-turn-settled producers and local inbox publication. An
independent test author ran **8/8** actual queue/audit consumer regressions with
real timers, filesystem, JsonStore and FileAudit. Only canonical-release recognition
was controlled by a mock; these checks are not real Stop/import acceptance. The
actual canonical-source consumer regression and final integrated/native gates
remain pending. No import, Task intent or group-association PASS is inferred from
unfinished code or from the earlier source run.


## Stopped-source admission implementation handoff

The source-admission author completed the bounded production unit and handed it
to an independent backend critic. A positive canonical stopped-source release
now prevents the observed backup identity, WorkSync store/materialization/replica,
audit and comment-journal maintenance writes. The existing census and release
predicate are unchanged. An admitted continuation retains the original selected
owner/root and physical Team directory; a replacement at the same name does not
receive that admission. Local publication uses the existing identity fence then
launch-publication queue, retaining both until the actual physical operation
settles, including interrupted worker responses and nested publications.

Actual producer paths preserve this restriction before their first delayed work:
per-item WorkSync queue execution (including coalescing and retry), both startup
scan facades, runtime target resolution, debounced backup and the whole comment
notification drain. Only local inbox publication is fenced; provider/network work
is not moved under these locks. Runtime execution closures are not persisted in
events or DTOs. Explicit permanent deletion keeps its original authority; the
maintenance guard is not installed in the shared identity claimant. Existing
`assertSafeTeamName` preserves Unicode and space compatibility.

The final local qualification is deliberately reported by suite and scope:

| Check | Observed result |
| --- | --- |
| Backup suite, including genuine captured-source consumers | 64/64 PASS |
| Additional actual public startup facade with two ordinary Teams | 1/1 PASS |
| Source admission core, including physical settlement and name compatibility | 11/11 PASS |
| Independent actual queue, JsonStore and FileAudit regressions | 8/8 PASS |
| Runtime admission plus existing resolver/ingestor | 30/30 PASS |
| Existing WorkSync event queue | 26/26 PASS |
| Existing TDS comment notification cases selected by name | 5/5 selected cases PASS; other cases skipped by the filter |
| Host package build on the current worktree | PASS |
| Scoped fast lint, new/helper/test formatting, size and architecture guards | PASS |

The genuine source test created and stopped a captured TEST child, read the real
canonical release, then invoked actual backup startup/periodic/shutdown, comment
initialization and WorkSync startup/events/read/fence consumers. Source bytes and
the original canonical release remained exact. Controlled storage/backend ports
are identified in the test; this is not an actual SDK or Desktop import proof.
Separate cases exercised an already-captured delayed backup after replacement,
coalesced comment replacement and explicit deletion. Ordinary runtime audit
entries still capture before their own first await and file chain; an inherited
retired scope cannot be replaced with a fresh admission.

The adapted native-extension suite did not collect because this local recovered
tooling lacks `better-sqlite3-node`; no PASS is claimed for that suite. Full
project typechecking and the actual stopped-source to imported-target native
Launch remain pending on committed source. Final production caps are 800 lines
for the WorkSync composition, 795 for its backend-selecting store, 784 for its
queue and 794 for the deletion coordinator; no baseline exception was raised.
The independent final review is still pending at this handoff. General historical
sources with identity metadata already present before Stop and the original M19
custody HOLD remain separate open qualifications.

## Draft feedback status at 7e3ea01

The PR is still Draft and MERGEABLE against unchanged base
`7eb878f88af355334547ab526034ca1c2bf961ab`. Automatic Draft CI run
`40567157944` passed Fast feedback but its Full qualification gate explicitly
failed with `Draft feedback does not qualify for merge`: canonical validate,
lint, test and Windows ledger jobs were skipped, and no qualified prior run was
reused. This is not a current-code full PASS and is not evidence of a failing
production assertion. An explicit workflow dispatch on the reviewed committed
candidate is required for the full gates and optional Desktop matrix.


### Independent source review: restore and purge blockers

The final backend critic withheld acceptance after tracing two actual existing
privileged paths through the newly guarded stores. Startup WorkSync restore uses
the configured real restore participant, whose preflight enters the guarded
backend store without a maintenance admission. Actual feature permanent-deletion
purge likewise reaches the guarded JsonStore/replica without that scope. Both
can throw `Missing original legacy source admission` on ordinary operations.
The earlier explicit-deletion regression covered `backup.beginPermanentDeletion`
and did not qualify the later feature purge; the distinction is now explicit.

The source commit remains blocked while these two entrypoints are corrected
under their existing owner, identity, generation and quiesce fences. Ordinary
store operations must keep requiring their original admission, with no permissive
fallback or fresh capture of a replacement directory. Actual configured restore
participant and actual feature purge regressions are required before re-review.
The critic accepted the inspected runtime, queue, inbox, debounce, startup and
read-fence seams without additional findings; this does not override the two
remaining compatibility blockers or qualify native import.


## Group-origin Task association review and local regression closure

The bounded group association unit received independent actual-code ACCEPT. The
existing group command access supplies a synchronous catalog assertion under the
same Team store fence as the first Task receipt write. It runs only for a new
Task command after authority, namespace/conflict and pending-command checks.
Existing completed, prepared and held receipts retain their original admission;
current authority is still checked. UUID/missing/foreign/archived and absent
persisted default groups are refused. Missing synchronous storage capability or
malformed/unreadable storage retains HOLD. No new message, runtime, membership or
admin requirement is added to Task association.

The package author ran 8/8 new association cases and 18 existing Team owner/board
cases successfully, plus Host build and test typechecking. The independent critic
read those actual filesystem, restart, replay, revoke and continuation tests and
the original-facade/Main/board regression. Frontend integration execution remains
a separate gate while its exact UI dependency closure is recovered.

Root resolved the earlier local group-suite interruption without editing product
code or reducing its test scope. Nine ordinary cases passed in a selected run;
the separate full-roster case successfully completed its real 256-recipient
canonical fanout in 68.1 seconds. A subsequent **single original full-file run**
passed **10/10**, zero skips, in **81.3 seconds** (80.3 seconds in the full-roster
case), using pinned Node 24.22.1 and the task-owned RAM temporary directory.
The earlier overlay-backed bounded attempts remain interrupted/unqualified;
this later run is their successful actual group regression replacement. It is
worktree/package qualification, not an exact committed-head native/UI proof.

The existing Task board E2E is being extended with one saved offline TEST peer,
only in its two existing board modes, so the fixture satisfies the real minimum
of two agents for canonical group creation. The same original seed Task carries
the group association. Original Group filter and Create Task controls, exact
receipt/readback and the existing reload are the planned acceptance path. No
provider/runtime session, extra business Task or alternative harness is added;
these E2E edits are not yet claimed as tested or accepted.


### Restore and purge correction: actual red/green handoff

The source author reproduced all four reported failures with actual configured
restore and feature purge consumers, then corrected the existing privileged
entrypoints. Restore preparation still captures ordinary source admission before
candidate/preflight reads and refuses a positive read-only source. Only the
existing post-publication `importAndVerify` and permanent-deletion purge receive
a private, exact-Team, physically scoped lifecycle storage context. Original
Host and physical teams-root restrictions remain active; the normal storage path
still requires `policy.current`. The existing restore identity/config checks and
purge generation/quiesce fences remain decisive. Purge captures its restriction
in the existing generation state before waiting for other operations to drain.
No public bypass, registry, extra receipt framework or new production file was
introduced for this correction.

The finite actual regression set passed 8/8: missing and pending restore, complete
JSON and backend-selecting JSON purge, root/owner replacement during the existing
coordinator drain, and genuine canonical stopped source with the actual bound
participant and pending manifest both false and true. Cross-Team access and late
use of an expired private context are refused. The canonical stopped source
retains exact original bytes and release in both pending cases.

The final author bundle passed **237/237** across nine suites: Backup 72,
feature 85, deletion coordinator 5, admission core 11, independent queue/audit 8,
runtime admission 4, existing resolver/ingestor 26, existing event queue 26.
Scoped fast lint, source-size (4619 files), provisioning architecture and diff
checks passed. The feature composition is now 791 lines, persistence 183 and its
deletion coordinator 356. This is a completed local author handoff; independent
final actual-code review and exact committed-head CI/native acceptance still
remain required. The earlier review blockers are not marked closed merely by
the design verdict or these reported test counts.


### Independent final source-code acceptance

The same independent backend critic re-read the completed actual diff and issued
**ACCEPT**, closing the two restore/purge compatibility blockers. The reviewed
private storage context preserves exact Team, original owner/root and active
physical lifetime; ordinary `policy.current` has no permissive fallback. The
purge restriction is captured before generation drain. Interrupted errors retain
their original identity: restore keeps its identity/mutex/quiesce owners until
settlement, while failed purge stays quiesced and its existing retry waits for
worker retirement. The critic also rechecked the previously accepted runtime,
local inbox and positive stopped-source gates and found no new blocker.

The sole integrator subsequently ran the normal Host build/declarations refresh
successfully after the final restriction-only port change. Neither this review
nor the local 237-case bundle substitutes for full committed-head qualification
or the actual source-import/native-launch Desktop gate. The source unit is now
ready for its coherent commit and immediate push; unrelated Task UI and E2E
work remains separately owned and reviewed.


## Committed source checkpoint and canonical CI feedback

The reviewed source-admission unit was committed and immediately pushed as
`c5ded9a14df74b30c5567f4511c3aa960b9b1fea`. Its explicit path set contained the
34 agreed source/test paths, the finite source-closure update and this progress
log; unrelated Task/group/F01 and Desktop extension work was excluded.
[Workflow 40577183939](https://github.com/777genius/agent-teams-ai/actions/runs/40577183939)
was explicitly dispatched on this exact head with all ten source Desktop cases.
It must not inherit results from the earlier `7415702c` run.

The canonical validation job found a real contract mismatch:
`TeamWorkSyncIdentityAccess.withCurrentPublication` could supply an undefined
assertion callback while `MemberWorkSyncTokenIdentity` requires a callable one.
The actual native persistence consumer also calls that callback, so a cast or a
weakened port would not be a valid correction. The IPC test facade additionally
lacked the new `withStoppedImportFence` member. Both are being corrected under
independent review; the source checkpoint is not a full typecheck PASS.

All three lint jobs and test shards 2 and 3 passed. Shard 1 failed two existing
TeamDataService comment-forwarding expectations because the physical inbox write
now carries its original `shouldStillWrite` guard as a third argument. Shard 4
failed thirteen existing LaunchTeamDialog Create/save-only cases and one
request-shaped Host routing case. These failures are being diagnosed rather
than skipped or reclassified. The original Task board Desktop job passed on
`c5ded9a14`; its not-yet-committed group extension was not part of that run. The
remaining Desktop jobs were still running or queued at this checkpoint.


## F01 Task/comment unit: final local author and independent review

The application-lifetime Task/comment recovery unit is frozen for integration.
The independent whole-candidate critic issued actual-code **ACCEPT** after
reviewing original command/payload/handle retention, strict direct/lookup receipt
correlation, Main-validated policy no-effect proof, original writer normalization,
revision-safe comment completion and the bounded outstanding-submission map.
A lookup with missing, pending, held, malformed or unavailable evidence retains
HOLD. Completed but unacknowledged obligations count towards the bound; the
existing successful UI/store workflow performs a local acknowledgement.

Three actual caller defects were corrected during that review. The graph Create
Task parent now propagates failed submission instead of turning it into a
fulfilled callback. The existing comment Send control remains available for
original-intent lookup after the current draft is cleared or exceeds its length
limit. A replacement Create Task form registers its open lease in layout phase,
so an old late success cannot acknowledge the intent already restored by the new
form. Normal successful parent close without replacement still acknowledges and
releases the completed intent.

The final author run passed **110/110 tests across ten suites**: real filesystem
TeamOwner recovery 22, strict transport facade 29, existing Host mutations 18,
attachments 6, group facade/projection 3, Task detail core policies 17, legacy
Create Task identity 4, actual CreateTaskDialog 7, original Send control 3 and
actual graph hook/callback 1. Scoped lint and format checks passed for the 26
owned paths; source-size and provisioning guards passed without cap changes.
A bounded strict helper/core/Main-projector type program passed; it is not the
canonical project typecheck.

The separate real-store Task detail renderer integration suite has not collected
locally because its exact CodeMirror language dependency set is still being
recovered. Its new actual retirement/unmount case has no local PASS yet. The
finite source closure must include the new reviewed helpers before committed
proof. Renderer reload durability is explicitly outside this application-lifetime
retention claim; the existing draft store is not a new command journal.

The three-file existing Task board group extension also received independent
actual-code ACCEPT. It uses the original offline fixture, Group filter, Create
Task controls and reload, checking canonical group association and preserving
the original group receipt separately. Strict script typechecking and scoped
format/diff checks passed. Actual Electron acceptance remains pending on the
combined committed head.


## Independent plan audit: remaining F08 Electron evidence

The independent plan audit identified a specific acceptance omission rather than
a confirmed production defect. F08 requires mutation between snapshot and
subscribe, reconnect/gap and a late former-target response specifically in
Electron/CDP. The existing-handle owner A to default B switch, unavailable A
without effects at B and rollback handle survival likewise need their concrete
routing proof. The retained P5 handoff separates CLI/adapter race results from
ordinary Electron automatic-update evidence; the existing six negative routing
probes and ten Desktop variants do not establish the full required sequence.

A bounded continuation at the existing offline Task board/routing boundary is
being researched. No alternative harness, provider allocation or mocked native
acceptance is authorized by that design exercise. Until the actual required
proofs and the other retained P7/P8 obligations pass, this remains a scoped
integration checkpoint, not an unqualified final `candidate-synthetic` result.
The original M19 custody HOLD, unavailable historical M17 packed tuple and broader
historical-source metadata qualification remain separately open.


## Confirmed c5 CI contract and forwarding corrections

The source identity adapter now always supplies the required callable publication
assertion. With configured source admission, its closure retains the original
admission and receiver across awaits; without that optional policy, the existing
legacy identity fence remains authoritative. The native consumer's required
callback contract is unchanged. Two actual identity regressions cover callable
legacy publication across an await and revoked original source admission before
a write, with no fresh capture. The existing IPC fixture supplies the newly
required stopped-import fence. Two TDS forwarding assertions now verify the
original third options object and invoke its actual `shouldStillWrite` callback,
while retaining their exact business payload/call-count assertions.

All three existing focused suites passed **183/183** (TDS 162, identity 11 and
IPC 10). The normal Host build/declarations refresh and exact four-file fast lint
and diff checks passed. Independent actual-code review accepted the completed
delta; no production port was weakened or cast to bypass validation. Existing
formatting outside the changed lines was preserved. These are local corrections
to the confirmed c5 canonical CI findings; full qualification of the new commit
remains pending, and no new native result is inferred.


### CI correction pushed; Task detail integration gap closed

The confirmed publication-callback/fixture/forwarding correction was committed
and immediately pushed as `b3f33a9978c0b459fab9d16d7aca0b9a2508a885`. The reviewed
staged set contained its four exact source/test paths, two finite regression pins
and the progress checkpoint. Other dirty units were excluded.

After recovering the exact direct CodeMirror dependencies, the carried real-store
Task detail suite ran. Its new intentional lost-ACK case first hit the repository's
expected-console gate; all functional assertions passed. The test now explicitly
checks and clears that one expected diagnostic, following the existing failure
case in the same suite. The unchanged original suite then passed **12/12**,
including actual Host retirement/unmount/reopen, original submission identity and
preservation of later draft edits. This closes the previously reported local
collection gap and brings the F01 author bundle to **122 PASS**. Production F01
is unchanged from its independent ACCEPT; final committed-head gates remain.


### Two original c5 Desktop artifacts inspected

Root downloaded and inspected original artifacts from workflow `40577183939` on
`c5ded9a14df74b30c5567f4511c3aa960b9b1fea`, including their actual screenshots:

| Existing source Desktop flow | Artifact ID | Original receipt SHA-256 | Observed boundary |
| --- | --- | --- | --- |
| Ordinary Create and native Launch | `12769086131` | `f7227610e5c9479f7fe85b034bca1feefa6e5fd89d8c77373bfba9bdc1e505e7` | PASS: original Create/Launch, actual SDK MCP/Bash/reply and completed Task, original Stop release and settings after reload. Harness cleanup used SIGTERM; natural app exit is not claimed. |
| Task board and cross-Team controls | `12766199926` | `37e05a3746903e3bf7ec0e5d643841381903660d7574fc3346f5f1b6919e065b` | PASS: original dependency/assignment/drag, attachment/comment, review/change/fix/approve, notification and cross-Team Send/Reply/reload controls. This run had an empty process group before cleanup, app exit 0 with no signal and captured Host absent. |

Both receipts retain empty forbidden and post-Quit/cleanup sentinel invocation
lists. Notification Mark as read was unavailable because the original viewed
notification was already read; it is not reported as exercised. The Task board
artifact excludes provider sessions and has no not-yet-committed group/F01/F08
extension. The native Create artifact uses localhost scripted inference and does
not establish vendor authentication, installed/packed qualification or full
P4/P8. These exact c5 results are not promoted to `b3f33a997` or a later head.


## Task/group/F01 coherent integration checkpoint

The accepted group association and F01 changes are integrated as the finite union
of their author manifests: **37 paths**, with three shared adapter/contract files.
Task Create and comment submission retain their original command, captured owner
and product payload through uncertain replies and component unmounts. Original
receipt lookup, current authority and finite no-effect proof control recovery;
missing or unavailable lookup remains HOLD. The original Create Task, graph
callback and comment Send controls now preserve that outcome rather than
reporting a swallowed failure or clearing a replacement form/newer draft. These
are bounded application-lifetime obligations, with no renderer-reload durability
claim or new history/attachment journal.

The same Team store fence validates an active, readable, same-Team group before
a new Task's first receipt. Existing admitted/replayed receipts keep their
original semantics and current authority checks. The group ID survives the
original Host mutation, canonical Task and Main snapshot projection. No group
message, provider allocation or new membership/admin authority is introduced.

Author execution and independent actual-code acceptance are recorded above:
F01 now has **122 local passing cases**, including the complete existing
real-store TaskDetail suite (12/12). The group author separately passed eight new
association and 18 existing owner/board cases; the original full group suite
passed 10/10 with its full 256-recipient case intact. These overlapping buckets
are not added into a new unique total. Integration rechecked the exact manifest
and both source-size and provisioning architecture guards successfully. All 19
additional affected helper/regression/necessary existing paths were explicitly
source-pinned, without deriving a closure from other dirty work. Canonical full
project and exact-head Desktop qualification remain pending. The accepted
three-file group UI E2E and separate routing/F08 work remain separate units.


## Original Task board group-association E2E integration

The accepted extension is confined to the three existing fixture/board files.
Only `task-board-ui` and `task-board-cross-team-ui` add one saved offline TEST
peer beside Alice, with matching captured descriptor metadata and no runtime,
provider allocation or new principal grants. Under the same original profile
writer lease, the fixture creates a real canonical active two-agent group and
links the original single seed Task to it. It preserves the seed Task's existing
identity/subject and retains the group receipt separately.

The existing Group chat filter supplies the existing Create Task form's group
selection. The original single Create action is checked against its exact
canonical Task/receipt payload and captured Team snapshot; the same association
must survive the existing renderer reload. Every Task command census separately
checks that the original group-family receipt remains unchanged. The group filter
is cleared before the existing Alice/dependency/drag/review workflow continues.
The board helper now requires its group seed explicitly, so a missing fixture
cannot silently fall back to the earlier board proof. The original combined
cross-Team overlay preserves this base roster and only adds its existing Teams.

Independent actual-code review accepted the extension; the final required-seed
and descriptor-census guards were separately approved. Existing strict script
TypeScript, scoped formatting and diff checks passed. Both existing Group filter
and task projection sources are explicitly pinned and included in the proof's
source hashes. Actual Desktop execution on the changed head remains pending;
prior Task board PASS receipts do not qualify this new group-association phase.


### Integrated Task/group and existing board proof commits

The reviewed F01/group union was committed and immediately pushed as
`0ddaa8ac04d1f21e104fa1fc3a64abb7690731b0`. The existing board extension followed
as `3b4cc0938517621f401ca97896bca8298580c516`, also pushed immediately. Its group
seed is mandatory at the board helper entrypoint, and the same offline peer is
represented in both persisted roster and captured descriptor metadata. Neither
commit receives an inherited Desktop PASS from the c5 run.


### Additional original c5 Desktop receipts and custody limits

Root downloaded and inspected three further original artifacts from workflow
`40577183939` on `c5ded9a14df74b30c5567f4511c3aa960b9b1fea`:

| Existing flow | Artifact ID | Original receipt SHA-256 | Observation |
| --- | --- | --- | --- |
| Saved legacy import only | `12768847459` | `202a48f240913418dfa1e0f41481de684d56376ddba0e6c3330c2667c456b5b9` | PASS for the original never-launched draft import, saved dialog/data, close without Submit, reload and original import lookup. No native Team input; harness SIGTERM, no natural-exit claim. |
| Pending native open then Quit | `12768937700` | `b31703246066b599e9db6dd6ffac5b7a7f2749a2bb710dd3aecfbc247f867492` | PASS for safe shutdown with zero inputs, retained `held-unknown` outcome/debt, absent native children, original writer lock released and empty process group before cleanup. |
| Same pending-open profile cold readback | `12768937700` | `0b7e4a7c71ad3b27dacc3ab13c9adfa71c5e6d76da57e9eb48aae168e0d89e1f` | PASS: original session/product unchanged through startup and second Quit, no new allocation. Both app epochs exited 0 without a signal; automatic app.relaunch remains unqualified. |
| Solo Create and native persistent teammate | `12770150475` | `16915144dffdb19a21821c5c9df7a5dff8ab78dffeb2f159eaf54ae767480cfb` | PASS for one original lead input creating the persistent peer, original lookup, addressed peer work/reply, current-roster reminder once, Stop and reload. Harness SIGTERM, no natural app-exit claim. |

The pending-open absence observations do not prove provider custody release: the
original UNKNOWN obligation is deliberately retained. This does not clear the
historical M19 HOLD. The never-launched draft receipt does not qualify the broader
previously launched/historical-source import cases.

The native teammate artifact now contains its original raw
`model.nativeMemberObservations`: **11 observations**, nine from the lead and two
from the created peer, covering original creation, addressed peer work, next-input
roster and no-repeat roster checks. This closes the earlier collector omission
for this new c5 run only; the older receipt is not rewritten. All captured probes
were permitted, but this artifact recorded **three post-Quit/cleanup version-only
probes** (OpenCode, Codex, OpenCode). No native execution or full fork-free/P5
qualification is inferred from them. The other two newly inspected artifacts
have empty forbidden and post-Quit/cleanup invocation lists. Root also inspected
the original import dialog and pending-open cold-readback screenshots.


## Captured Create routing and fresh-app test isolation

The existing Create result decorator now applies the same captured-destination
refusal before either raw-result or ordinary legacy Create bridge. A Host key,
including a malformed reserved Host prefix, cannot fall through to a legacy
writer; the regression asserts that neither bridge nor any backend request is
called. Ordinary new-Team creation keeps its existing transport and receiver.

The separate Launch suite failure was reproduced in the full file while isolated
cases passed: an intentional UNKNOWN in one mock application retained its proper
application-lifetime intent into later test cases that constructed a new mock
application. The existing reset helper now runs only in that fresh-app
`beforeEach`; no within-case/unmount reset or production retention change was
made. Independent actual-diff review accepted both corrections.

The author passed **162/162** across the full Launch file (127), retained Create
flow (16), routing (6) and refusal transport (13), plus scoped three-file lint,
format/diff and bounded strict decoder typechecking with erasable syntax enabled.
These are local CI corrections; exact committed-head canonical and Desktop
qualification remain pending. Both affected existing regressions are explicitly
source-pinned. The unfinished two-file F08 harness is excluded from this commit.


## Bounded F08 original Electron read-timing harness

The independently accepted two-file continuation extends only the existing
`task-board-cross-team-ui` workflow, after its original command censuses. On the
same offline captured Host it uses one original Task Comment control and one
canonical comment/receipt, then exercises original shared-feed response loss,
a real Host cursor-gap read and a late public observer's resync. A separate
original selected-Team read is held across original navigation to the existing
peer and released only after the peer is loaded. Recorded original getData
provenance, selected loading/nonce and its terminal roster-read observation
qualify that hold; arbitrary background polling is not relabelled as selection.

Each tracked read performs the real original backend call exactly once and
retains its returned result/hash. Cursor loss changes only the read cursor sent
to the actual Host; no synthetic successful result or replacement mutation is
injected. The one comment/receipt and original receipts are checked, the peer
product stays unchanged, and the shared invocation/observer hooks are restored
in `finally`. The same already-pinned helper/glue paths contain the complete
change; no endpoint, backend, fixture, provider, default setter or new harness was
introduced.

Direct existing script TypeScript, scoped helper formatting and focused VM
fault-mechanics checks passed. Independent actual-code review accepted the
completed provenance, bounded polling, settlement, product and cleanup checks.
Actual Desktop execution of this changed continuation remains **pending**.
This does **not** qualify full F08/M18: the first global snapshot-subscription
race, same-A revision rollback across an in-flight mutation, transport
reconnect/Host restart, live default-owner switch, unavailable-A physical fault
and cross-owner routing remain explicitly excluded/open.

The earlier exact c5 run has again reported failed mixed Create/Launch and
previously-stopped-source import/native Launch gates. Their new original evidence
is being retrieved and triaged; no cause is asserted here and no historical PASS
is transferred to those failures or this changed combined head.


## Completed c5 run: original failures and remaining receipts

Workflow [40577183939](https://github.com/777genius/agent-teams-ai/actions/runs/40577183939)
finished on `c5ded9a14df74b30c5567f4511c3aa960b9b1fea` with **7/10 source Desktop
jobs passing**. Its canonical validation and shards 1/4 and 4/4 also failed;
their previously documented code/test corrections are committed separately and
have not yet received full current-head qualification. All three lint jobs,
shards 2/4 and 3/4 and the Windows Task ledger smoke passed on c5. Renderer source
validation was skipped. The whole run is **FAILURE**, not a Stage 1 acceptance.

Root retrieved the original failed Desktop artifacts without rewriting receipts:

| Existing flow | Artifact ID | Original receipt SHA-256 | Exact failure boundary |
| --- | --- | --- | --- |
| Previously stopped source import and native Launch | `12769943539` | `f8b41bc02533b70ca06f79463dad5e8481e3b94c4bdd003db356e3db0a8b503d` | The source immutability census passed; the original Launch reached a fresh capture, then strict target-settings comparison rejected the explicitly saved `allowExperimentalLocalModels: false`. Later native effect/Stop/reload checks were not reached. |
| Mixed Create and Launch | `12769778896` | `a3949b03b484e9eef12d6fd844b639e9f1d70b17f7c3068d85729fc530d2c59e` | Original UI showed all two teammates joined and the first native lead reply. The helper then searched the canonical lead name in an aria label that uses its existing display name. No subsequent Composer mutation was dispatched. |
| Cold selected Resume | `12771010095` | `94e83214bc54048ed71058a13445fae51ecf9492a90cbc8c437266c4e43c0431` | The initial Launch button remained disabled by the provider catalog/readiness guard after selecting Opus 4.6/Medium. No initial Launch or Resume business input occurred; cause remains under investigation. |

Independent critics traced the first two failures to exact TEST oracle gaps.
Ordinary Launch explicitly materializes the disabled local-model opt-in while
preserving the imported settings. The proposed expectation retains the complete
object comparison and requires `false`; no production default or source fixture
is changed. The existing direct-chat presentation maps canonical `team-lead` to
`lead`; only the TEST aria label selection should use that display name, while
canonical recipient/provider/capture and reply assertions remain intact. Both
initial mixed input and post-member-restart selectors need the same correction.
These diagnoses do not turn the failed runs into PASS.

For import, the original live receipt's before/after source census agrees for
all ten paths. The independent critic also rechecked all seven source JSON files
retained in the downloaded artifact, with exact bytes/hash/size and no new paths.
The artifact omits three attachment blobs, so a second physical-byte verification
of those three is not claimed. Original receipt evidence remains unchanged.

Additional original passing c5 receipts were inspected:

| Existing flow | Artifact ID | Original receipt SHA-256 | Observation and limit |
| --- | --- | --- | --- |
| Active input Quit | `12770830150` | `7458541bcef0d02deef0216385bbe4f90aea96255200e4f120bca9401bb3bb0d` | Two original Composer submissions, first actual input held and second queued; shutdown ended closed/released without debt, with one model observation, absent captured native children, empty owned group and released writer lock. |
| Same active-input profile cold readback | `12770830150` | `3f82b3eb50961ce997951045dbf3a8b74d3d265f84fb98fb5ac0a22dbb39b3c6` | Original product/runtime unchanged, no new allocation/input. Both app epochs exited 0 without a signal and the captured Host was absent. |
| Native review source run | `12770441800` | `dc39b026feab5fa2d0008f820f5d3ab7fa3d05fcfd0d026f1c4c8df07c5dd60d` | Two exact foreground native Edit transformations and original Start/Changes Keep/Reject/Undo/Redo/history/Stop/reload passed. Partial background/failed-Bash authorship stays unqualified. Source app cleanup used SIGTERM. |
| Same native-review profile cold readback | `12770441800` | `0ef3926a16c83990c6f0f022774c0210ea8f21a489c7c6374cd2303e96b0571e` | Original events/runtime/review decisions/file unchanged with zero allocations/inputs; original receipt SHA correlated. Cold app exit 0 without signal, empty owned group and captured Host absent. |

The review source and cold cleanup modes are deliberately distinguished; neither
receipt closes all M13. All four have empty forbidden/post-Quit invocation lists.
No new run clears the historical M19 custody HOLD or supplies the missing M17
packed/installed macOS tuple.

The independently reviewed routing/test-isolation correction was immediately
pushed as `f2e8383af37b1e2157fac3dc6ce102bf17bae1df`; the bounded original-UI F08
continuation followed as `25c61a451eb56c407391e4964ae7b6fe006a5766`, also immediately
pushed. Neither inherits a Desktop PASS from c5. Holistic static backend/Main/
Runtime review found no additional confirmed production blocker in the current
integration; current-head canonical/native qualification remains pending.


## Exact Launch settings and direct-chat TEST oracles

The two c5 artifact diagnoses above are corrected in the existing smoke flows.
Imported Launch still compares the entire saved-settings object against the
captured pre-Launch settings, with the original prompt/permission choices and
an explicit `allowExperimentalLocalModels: false`. The ordinary Launch roster
submission materializes that value; the TEST now requires it explicitly without
changing the source fixture, product default or source-byte census.

Both the initial mixed direct-chat selector and its post-Bob-Restart continuation
now use `lead` for the existing UI display of canonical `team-lead`. The canonical
member/provider tuples, captured principals, original inputs, recipients and
native reply assertions are unchanged. Existing `memberHelpers.ts` and the actual
direct-chat `ChatListRow.tsx` presentation sources are explicitly added to the
finite Desktop proof source closure. No renderer dependency is imported into the
Node smoke scripts.

The independent cross-layer critic accepted the actual selector/pin delta; the
backend artifact diagnosis independently established the complete settings
expectation. The existing strict `tsconfig.legacy-agent-host-scripts.json` check,
scoped Prettier check of all four changed script/closure files and `git diff
--check` pass. These are static corrections only: a new original Desktop run is
required for import/native Launch and the complete mixed flow. The separate cold
Resume readiness failure remains under investigation; no guard, timing budget,
mutation count or failed original receipt is changed here.


## Captured Host Task Trash read and existing Restore route

A holistic renderer review confirmed that `getDeletedTasks` was absent from the
Host compatibility API: the generic Host guard rejected it, so the original
selected-Team and global Trash feeds displayed no Host deleted Tasks despite the
existing canonical delete/restore mutations. Ordinary snapshots deliberately
exclude deleted Tasks and remain unchanged.

The existing `tasks.list` read now accepts only the additional literal
`deleted: true` query. Its ordinary `{}` array response and the original Host
wire `null` query retain their active-only behavior. The deleted-only response
contains the captured canonical Team identity and existing portable controller
`listDeletedTasks()` records, under the original read grant and owner fence.
It has its own 512 KiB bound; retained Trash does not enlarge or change the
revision of ordinary active snapshots. Main reuses the existing complete Task
allowlist, validates every returned status as deleted and strips private fields.
The renderer checks the captured canonical name/current scope/product read fence
after awaiting the response and reuses the original TaskRef remapping. Missing,
old-shape, foreign-owner and unavailable results refuse explicitly without legacy
fallback. The existing canonical Restore mutation and active/global board policy
are unchanged.

Independent actual-code review accepted this finite read after catching and
correcting the draft `null`-query compatibility regression. Verification:

- **56/56** focused tests passed: 13 new real-owner/Main/renderer/global Trash and
  Restore/refusal tests, 40 existing Host reads and three existing global Trash
  feed tests. The final new 13-test file rerun also passed after typed fixture
  corrections; it is not counted twice.
- **1/1** existing actual Host CLI/RPC lifecycle case passed, including its old
  `null` active-list assertion and new deleted-only read after canonical delete.
- Host source build/declarations and Host test TypeScript checks passed. The
  changed production TypeScript 7 closure passed. Including the real global-store
  test in that bounded check is blocked only by two absent unchanged local
  transitive packages, `@floating-ui/dom` and `better-sqlite3`; no dependency
  installation, stub or skip is used to claim qualification.
- All 11 changed source/test paths passed scoped fast lint; all 12 including the
  explicit source-closure additions passed Prettier. Source-size guard passed
  for 4621 production files, and `git diff --check` passed.

The canonical test asserts exact Task bytes across reads, deleted timestamp,
retained comments/qualified refs, original owner/handle, real global-feed output,
restoration and active-board exclusion. Canonical delete's expected queued-alert
retraction diagnostic is asserted exactly and consumed, not broadly suppressed.
Original Trash/Restore Desktop controls still need the next explicit UI proof;
unit/Host RPC results are not promoted to Desktop acceptance or full Stage 1.


## Passive original Launch readiness diagnosis for cold Resume

The c5 cold-Resume failure remains unresolved: its original Launch was disabled
by the provider-readiness/catalog guard. The existing Launch UI smoke now captures
bounded passive diagnostics immediately before that original attempt and again
only if the attempt fails. It reads the exact original Team's currently mounted
Launch component/check array and captured draft signatures through a bounded
current React root walk, with explicit DOM values and timestamps. The ownership
check precedes CDP; inaccessible/truncated diagnostics are recorded without
masking or replacing the original failure.

Root independently accepted the actual frozen delta at source SHA-256
`e9a74e0e9b4ecc06bea74907eb3c521cd2e8b0fbd24da044c19bf1f4015cf2a4`.
The bounded ancestor/tree/hook limits are 64/4096/512; the read has a three-second
budget. No product/backend call, probe, refresh, bypass, default change or mutation
retry is added. The original click/error and later proof gates remain intact.
The existing strict scripts TypeScript check and embedded-expression VM syntax
check passed. Prettier reports the same preexisting whole-file drift on the
unchanged HEAD baseline; no broad formatting is applied. Diff check passed.
This is diagnosis only, not a readiness waiver, Resume PASS or workflow acceptance.


## Captured lead coordination without duplicate Host TaskStart inputs

Holistic review confirmed that ordinary `processSend` was unsupported for Host
Teams, losing unassigned TaskStart lead coordination. The existing compatibility
surface now makes one original `message.send` intent to the unique lead from the
same captured snapshot that resolves its handle/canonical Team/TaskRef bindings.
UUID, text and current scope are captured before awaiting; no second resolve,
default fallback, legacy writer, slash dispatch or automatic retry is introduced.
A completed receipt with the authoritative message ID is required; uncertain
responses retain their original command identity in the error.

Blindly enabling the old stdin surface would duplicate assigned-lead work.
Both ordinary Task and graph Start callers now preserve Host coordination only
when the canonical `notifiedOwner` result is false. A true result retains the
original canonical owner notification without a second lead input. Host prompted
Create and Cancel keep their canonical work/direct-owner messages; their extra
legacy stdin echoes remain legacy-only. Existing legacy behavior, TaskStartCause,
notification proof and native input-count oracles are unchanged.

Independent actual-code backend and root reviews accepted the five production
paths. **28/28** focused cases passed: eight actual graph callback/real canonical
owner cases, 19 ordinary adapter cases including the one-owner/lead/TaskRef proxy
regression, and the existing graph lost-ACK retention case. Fixture delivery
bindings are captured product metadata; these tests allocate no native process
and do not claim SDK or Desktop acceptance. The new proxy fixture's `never[]`
typing was corrected and its bounded strict TypeScript closure passes with the
repository's real ambient declarations. The changed adapter/API closure also
passes; the broader graph/test type closure is locally blocked by missing
unchanged UI-library declarations, so full current-head validation remains remote.
Scoped fast lint has zero errors and one unchanged existing TeamDetailView hook
warning; scoped format/diff checks pass. The final script/source-size checks pass
with TeamDetailView at 3743/3750 and Host API at 798/800. No cap is raised.


## Bounded same-A stale feed continuation in the existing F08 UI proof

The existing cross-Team Taskboard continuation now also retains one original
same-A shared feed response, completes the same single original UI Comment,
awaits a newer A product read and then returns the unchanged stale feed response
before the observer epoch changes. It requires a greater sequence in the same
stream, the retained original Task surface/receipt, exact newer A cache and no
extra mutation. The earlier real response-loss, gap, late-observer and A-to-B
selection phases continue afterwards with the same original Comment intent.

The raw `newerSnapshotArmed` record is the first matching same-A `getData`, not
uniquely correlated to the explicit call. Separately, the awaited explicit
`getData` returns only after its existing snapshot acceptance/current checks and
contains the new Comment; this establishes newer acceptance before stale release.
The proof does not claim stronger per-call raw correlation.

Independent actual-code and root reviews accepted frozen source SHA-256
`79c74968cedbef82542b7178e0eb5d58f1752df0f19e0c982a761bbd8ed2bd3f`.
Combined strict scripts TypeScript, scoped format/diff checks and the author's
bounded VM fault mechanics passed. Actual original Desktop execution remains
pending. This qualifies no full F08/M18 row: the first global snapshot race,
stale product snapshot across a same-A in-flight mutation, live owner/default
switch, unavailable owner, transport reconnect/Host restart and cross-owner
routing remain excluded. Original receipts and historical acceptance are intact.
