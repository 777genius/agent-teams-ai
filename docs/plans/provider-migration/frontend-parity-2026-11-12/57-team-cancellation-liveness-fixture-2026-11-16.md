# Plan57: restore the cancellation fixture's existing Team liveness shape

Status: SELECTED after root R1 and independent prospective R2. Publish and read back this selected plan before creating a source afterimage. Exact source R2 and original CI remain required.

## Original failure and bounded cause

At source `3be1fb3ec43d5682aa2ca77a6af62e6fa27b597b`, Host Emulated run `43933487563`, job `133531813939`, the original safe frontend shard reports540 passed files and one failed file,6222 passed tests, four failed and six explicit skips. All four failures are in `test/renderer/components/team/TeamProvisioningCancellation.test.ts`: Vitest rejects the missing `selectTeamIsAliveForName` export in its complete `teamSlice` module mock before the cancellation assertions run. The real `teamSlice` already re-exports this selector. Plan51's production presentation legitimately imports it to distinguish explicitly offline Teams from old snapshots with unknown liveness.

The existing cancellation fixture's selected Team and cached Team snapshots contain members and no `isAlive` field. The real `teamDataSelectors.ts` returns the selected snapshot's optional `isAlive`, which is `undefined` for these unchanged fixtures. No current evidence requires a production change.

## Selected implementation boundary

Change only `test/renderer/components/team/TeamProvisioningCancellation.test.ts`, preimage Git blob `d3a363bcecb304583851fe7da2b625da5569e775`. Add `selectTeamIsAliveForName: () => undefined` to the existing complete `vi.mock('@renderer/store/slices/teamSlice', ...)` object. A short adjacent comment may state that this legacy cancellation fixture has unknown Team liveness. Do not replace the complete mock with a heavy real store import, introduce a new helper, or synthesize an alive/offline value absent from the fixture.

Preserve the complete fixture state and all four test bodies byte for byte: one observed cancellation and explicit retry, replacement-owner isolation, same-owner cleanup failure after cancelled presentation removal, and preservation of the mounted diagnostics view. Preserve every existing assertion, deferred-promise action, teardown, timer/settle behavior, mock and test title. No test is removed, skipped, loosened, replaced or newly added. This test-only compatibility repair does not change Plan51's production liveness semantics or its independent online/offline/unknown coverage.

No production, workflow, dependency, source-size baseline, Desktop proof roster, timeout or native-provider path is selected. Existing safe frontend CI already selects this test file. Local work is limited to inert source/manifest/diff inspection; the original complete shard on the next coherent head is the execution gate.

## Evidence and order

- Original job: https://github.com/777genius/agent-teams-ai/actions/runs/43933487563/job/133531813939.
- Full original decoded job log:179656 bytes, SHA256 `158a12c32c11567d3894c1a6ede95259c0787c3285b8af9370efef43184c5fc1`.
- Original artifact `14262939796`:297501 bytes, SHA256 `011c64ceb20d4f3819dc1e504ffbd8011ad22cec41253230ae9f1af2ac6b69db`; both members verified by CRC and full extracted SHA256.
- Full original JSON report:2177009 bytes, SHA256 `e7934b3414f6a2a01f77c3154b5eca1e1cdc1663dfc7644dad54c54d09b75c89`.
- Real selector source `src/renderer/store/team/teamDataSelectors.ts`: Git blob `aaa234335255c27ec212c3538d9e1e8167a7df32`; existing barrel `src/renderer/store/slices/teamSlice.ts`: `df9dd8391bdd9fcd2edc05057fa18a8cbd787dad`.

Root R1 and independent prospective R2 precede selected-plan publication/readback. Then freeze the exact one-file patch, prove restoration of the original bytes by removing only the added mock field/comment, obtain independent source R2 and publish through expected-parent CAS preserving incoming work. Keep useful active CI; no manual rerun/dispatch/cancellation. Actual complete-shard results remain required. This document is neither a test PASS nor full frontend/native/Stage1 qualification; #1192 stays Draft with its existing base, default-off and without merge/release/Stage2.


## Selection record

Root selects the one-field compatibility repair above. Independent prospective R2 accepted the exact proposal SHA256 `ff27f62f07aeb0de8e71ba9d19c683949ac9c369d3a49d56545eaa007b6a0095`; report SHA256 `1e040f87b548ce6510e430efb836a3904f496ea835f400bece32c425ca501cf9` is retained at [prospective-r2.json](evidence/plan57-team-cancellation-fixture-2026-11-16/prospective-r2.json). Publication base `1f174b343cc0c01465907d1b316982d006900a4b` preserves incoming Plan56; the selected test preimage remains unchanged. The source patch is still unexecuted and unpublished at this documentary selection.
