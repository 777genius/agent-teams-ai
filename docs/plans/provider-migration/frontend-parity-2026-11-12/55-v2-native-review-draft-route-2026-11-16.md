# Plan55: existing OpenCode V2 native Review and cold readback while Draft

Status: SELECTED for one existing workflow path only, after root review and independent prospective R2. Publish and read back this selected plan before preparing source afterimages. Implementation still requires exact frozen source review, normal publication and actual original CI evidence; this document does not qualify execution.

## 1. Original requirement and source binding

P10 §§1, 4C and 5 (A10-01/04/05/08) already require native Read/Edit, original Keep/Reject/Undo/Redo/history and cold readback. B2 Task Changes observation and the synthetic Review lane are separate evidence. No new Review feature or journey is proposed.

Source base: side `ee06c055eb7e360d6b851ddef3096307456c6bc9`, tree `b3881099adb278dfc569874126b204eb6fabd7fb`. The only proposed source write path is `.github/workflows/host-emulated-acceptance.yml`, exact preimage `a1513210012356a5178620b1f370bd1daf0de9d9` (106650 bytes). This includes the incoming Plan53 metadata-lineage lint operand. Preserve that operand, all other incoming bytes and every existing lane/step/condition/assertion except the explicitly described shared V2 selection changes below. Rebind if the parent or this leaf changes.

Existing native Review helpers were independently read at primary `3be1fb3ec43d5682aa2ca77a6af62e6fa27b597b`; their blobs match the earlier immutable 447a source readback. Preparation review: `native-proposal/v2-review-r1/preparation-r1.json`, SHA256 `979aac1241174ac9ea74365ecac738b226210523802c0a85192f03a44ecbc03a`. It verifies all 21 direct selected dependency entries are already in the base/integrated proof roster. No roster, production helper, typed test, package, source-size baseline or new verifier module needs to change.

## 2. Route comparison and recommended selection

| Route | Concrete cost and constraint | Recommendation |
| --- | --- | --- |
| Append to current Linux V2 Settings → C8 lane | Plain native Review and its cold mode fail the original Linux admission predicate in backend-smoke/observations. This requires a new portable mode selection and its source guards, in addition to more work after Settings/C8 inside their existing 45-minute cap. Current receipts do not establish sufficient remaining time. | Do not select in this cut. |
| One explicit Darwin ARM64 case in the existing Host Emulated matrix | The native Review pair already supports Darwin; the job already supports its existing macOS installer case. Reuse all common preparation and the existing 45-minute job cap, with no helper or platform-admission changes. The original Settings/C8 lane is untouched. | Select this one route. |
| General `ci.yml / stage1-desktop` | Its existing condition excludes Draft. Its dispatch selects the entire matrix, including genuine Claude/Codex. Changing Ready/full-qualification meaning or enabling that matrix is outside this cut. | Leave general CI byte-unchanged. |

Add exactly one include entry to `offline-desktop-scenario`: lane `opencode-v2-review`, runner `macos-15`, platform `darwin-arm64`. The same job, aggregate and workflow triggers remain. The aggregate already requires the entire scenario matrix plus four safe frontend shards; a new case does not bypass or replace any existing row. No new workflow, job, dashboard, framework, replay route or manual dispatch is selected.

## 3. Existing preparation and exact allowed inputs

Keep the existing frozen dependency/Electron installation, Node24.21.0, Host/controller/MCP builds, eight-file admission command, install-retry command and all lane-conditional full type/lint gates. Keep all current fast-lint operands in order; this YAML-only change adds no source operand.

The common capture step continues to pin canonical `process.execPath`, compiled Host entry, pnpm and both Corepack files. For this new row only, label `host-emulated-inputs.json.nativeProviders` with the same existing `OpenCode V2 with finite localhost model only` value used by the management row. All other rows retain their exact existing value.

Extend only the predicates of the two existing V2 preparation steps to admit either `opencode-v2-management` or `opencode-v2-review`. Stage the base with the already declared `HOST_EMULATED_PLATFORM`; use that same declared platform for `OPENCODE_V2_TEST_PLATFORM`. Thus the old row still receives linux-x64 and the new row darwin-arm64. Keep exact source-head binding and the existing `host-emulated-opencode-v2-inputs.json` path. Do not alter the stage-runtime or preparation scripts.

The selected V2 fixture uses canonical `process.execPath` even after EMULATED_ONLY is unset; it does not require a separately staged resources Node. Its required original inputs are captured Bun path/SHA, engine graph, custody directory/manifest SHA, current runtime.lock, and the finite localhost model URL. On Darwin the existing delivery is OpenCode2.1.4/Bun1.4.4. Original verification checks actual Bun bytes, graph closure and native custody artifact before recipe use. NativeOpenCodeV2 is mutually exclusive with nativeClaude/nativeCodex in the existing fixture; the V2 proof mode does not start a Claude model. No genuine Claude/Codex executable is selected or invoked, including version/discovery.

## 4. Exact four new row-local steps

1. **Exercise original OpenCode V2 native Review.** Condition: only `matrix.lane == 'opencode-v2-review'`. Set `LEGACY_DESKTOP_PROOF_MODE=native-review-ui` and `LEGACY_DESKTOP_OPENCODE_GENERATION=v2`. Unset `LEGACY_DESKTOP_EMULATED_ONLY` in this step shell, then run the existing `node scripts/legacy-agent-host/desktop-backend-smoke.ts` once under the original `set -euo pipefail`. Preserve full stdout/stderr in `host-emulated-opencode-v2-review-ui.log`. No xvfb or Linux admission exception is used on Darwin.
2. **Capture the original successful Review receipt.** Same row condition, ordinary success dependency. Parse the one `phase: prepared` entry from that log, require the exact canonical selected TEST root and `desktop-backend-receipt.json`, exact source and native-review mode, and complete PASS. Write only the existing `LEGACY_DESKTOP_READBACK_ROOT` and `LEGACY_DESKTOP_READBACK_RECEIPT_SHA256` environment values, using SHA256 of the complete original receipt bytes. Do not create a replacement fixture or edit the original receipt.
3. **Read original V2 Review after cold app/Host restart.** Same row, ordinary success dependency. Keep generation v2, select `native-review-readback-ui`, unset EMULATED_ONLY in this step shell and invoke the same original backend script once. Retain `host-emulated-opencode-v2-review-readback-ui.log`. No attempt suffix, continuation mode, second warm run, input or mutation is introduced.
4. **Verify exact native Review receipts and original cleanup.** Same row with the existing failure-visible pattern `!cancelled() && steps.inputs.outcome == 'success'`. Use a small inline Node data verifier in this existing workflow. It must reject missing/ambiguous/INCOMPLETE receipts; successful child exit alone is insufficient. It reads only the two original logs/receipts, current source/compiled/input files and the referenced screenshots. No test execution, provider launch, cleanup action or application invocation belongs in this verifier.

## 5. Narrow verifier contract, reusing original evidence

- Require exactly one prepared attempt per log and the expected warm/cold filenames in one canonical `TEST-desktop-backend-*` root created under canonical RUNNER_TEMP (the existing workflow exports TMPDIR there). Reuse the current retained-fixture basename/realpath rules; do not transplant general CI's unrelated hard-coded `/private/tmp` path.
- Require the captured `host-emulated-inputs.json.sourceHead` to equal the intended head and current `git rev-parse HEAD`, with clean tracked source status; bind both epochs through their original before/after source hash arrays, unique roster entries and current hashes using the existing desktopProofSources helpers. Native Review receipts do not contain `receipt.source`, so do not require or fabricate that field. Both receipts must have the expected mode and status PASS. Keep all original failure/source-freeze/input-freeze/log-cleanup failure fields disqualifying and the original per-epoch compiled/input checks. Bind profile/descriptor/Node/Host/pnpm/Corepack bytes to original pins and input capture. The original `selectedNativeInputHashes` field is Codex-specific and absent/empty here; it does not attest a final Bun/graph byte rehash beyond the actual original V2 fixture and metadata checks.
- Warm `nativeReviewUiProof` must be PASS, provider opencode-v2/version2.1.4, with the original qualified `opencode-update-patch-v2` event, released runtime before Review and six original finite model observations. Keep all actual Task creation/Task Start, tool IDs, before/after blobs, causal attribution, exact file bytes, Keep/Reject/Undo/Redo/history, renderer reload, unrelated file/index and no-replay assertions in the unchanged helper; do not reimplement its full oracle in YAML.
- Cold `nativeReviewReadbackProof` must bind the SHA256 of that warm receipt and same task/file, be PASS, report nativeInputsReplayed=0, nativeAllocations=0 scoped to Runtime sessions, metadataProcessCount=1, and unchanged runtime records/native events/Review decisions. The existing explicit loadModels metadata child remains allowed and attested. Check its existing original capture/close facts through coldOpenCodeMetadata; never require or claim zero native children during cold readback.
- Both epochs require their original metadataAbsentBeforeHarnessCleanup, captured Host absence, app exit0/null, empty owned remainder and no cleanupFailure. Preserve the existing sentinel predicate and retain its finite refusal diagnostics; do not introduce an empty-census oracle or label those observations full fork-free/P5 evidence.
- Verify the two original referenced PNG hashes/signatures and retain their bytes for independent visual review. Emit a small row-only summary identifying exact source, warm/cold receipt paths/hashes, native OpenCode with finite local inference, and false vendor/full-mixed/release qualification.

Exclude this new native row, alongside the existing V2-management row, from the old forbidden-provider inline verifier. Its predicate for every old row stays equivalent. The new dedicated row verifier owns only this added native row.

## 6. Artifact additions only

Keep all existing upload paths/order, always() behavior, retention and warning policy. Extend include-hidden-files to the new V2 row as already done for V2 management. Existing globs already retain warm receipt, host profile/descriptor, Runtime checkpoints, app logs, app-errors, finite sentinels and UI PNGs. Original Runtime records have a two-level namespace/session layout; preserve the existing `hoststore/runtime-sessions/*.json` operand and append the recursive operand below. Append exactly these14 selected additions under `${{ runner.temp }}/TEST-desktop-backend-*/`:

- `desktop-native-review-readback-receipt.json`
- `desktop-native-review-readback-app.log`
- `native-review-ui-seed.json`
- `hoststore/runtime-sessions/**/*.json`
- `hoststore/tasks/test-desktop-backend/*.json`
- `hoststore/teams/test-desktop-backend/.host-owner/state.json`
- `hoststore/teams/test-desktop-backend/.host-owner/commands/*.json`
- `hoststore/teams/test-desktop-backend/.host-owner/outbox/*.json`
- `hoststore/teams/test-desktop-backend/.host-evidence/.board-task-changes/events/*.jsonl`
- `hoststore/teams/test-desktop-backend/.host-evidence/.board-task-changes/blobs/**`
- `hoststore/teams/test-desktop-backend/review-decisions/**/*.json`
- `workspace/native-review.ts`
- `workspace/.git/index`
- `workspace/pre-existing-untracked.txt`

All new logs and the row summary use existing `host-emulated-*.log/json` globs. No complete HOME/workspace/Git tree or unrelated Team collection is added.

## 7. Budgets, source review and qualification limits

The existing 45-minute scenario job and five-minute aggregate are unchanged. Original helper cutoffs remain: UI reads30s, native poll60s, readiness120s, Launch/tool completion180s, guarded Quit20s, metadata log drain5s, and existing cleanup bounds. No timeout, attempt count, source/profile selection, physical action or assertion is edited. Preparation/builds plus both original epochs consume that one row's 45-minute budget; no speed or guaranteed fit is claimed. An actual deadline or cleanup failure stays incomplete and requires its own bounded diagnosis.

Estimated change: one existing YAML source path, roughly100–180 added lines including the focused inline receipt validator and14 artifact operands; no production/test/source-roster path. The existing YAML exceeds800 lines and remains outside the established production-source cap. General CI, Ready/default activation/release/Stage2 and genuine Claude/Codex gates remain unchanged.

Required ordering: root review and independent prospective R2 → selected Plan55 publication/full readback → exact frozen one-path implementation plus independent source R2 → normal expected-parent publication/readback → the next original eligible CI on a coherent head, preserving useful active jobs. No extra RED cycle or manual rerun/dispatch/cancellation is selected. Actual original warm/cold receipts, source/input binding, screenshots and cleanup must be independently audited before this Review row is qualified. This proposal is not a runtime PASS, full Stage1/M13, P08/P09, vendor, release or later-head qualification.

## 8. Selection and exact review records

Root selects the single Darwin ARM64 Review pair and the one-workflow contract above. Frontend prospective R1 v3 SHA256 is `33fffde35fc2413ceb6b332e5278cb5fcb914ff493d3b0491880d8c108008bc5`; independent prospective R2 accepted that exact v3 with24 checks, SHA256 `22d5c90e771d94c846df09d471275d4961177adf7e704fdbcb15df1ae1486a11`. The source-head join and fourteen artifact operands are part of this selection, including retained old single-level Runtime glob plus the added recursive glob.

Native preparation R1 is retained at [native-preparation-r1.json](evidence/plan55-v2-native-review-2026-11-16/native-preparation-r1.json); prospective R2 is retained at [prospective-r2.json](evidence/plan55-v2-native-review-2026-11-16/prospective-r2.json). The nineteen preparation bindings remain unchanged at the selected side base. The existing twenty-one-entry dependency closure also contains the metadata-lineage helper: use the accepted current `79c288d8cd5f6dc432177a2047ce517f174d11b4` body from the Plan53 lineage compatibility source, retaining its failure/lifecycle separation. The membership of that closure is unchanged; the older primary body is not substituted.

The four other existing V2 Desktop routes (active Quit, pending-open Quit, supported Resume and PNG Composer) are separate prospective work and are not selected by this plan. Existing P08, C8 and B2 routes retain their own source and evidence gates. No Ready/main merge, default activation, release or genuine Claude/Codex execution is selected.
