# Phase 1 controller packet: PR #252 target-binding correction r1

## Status and authority

- Durable controller: `controller-v17`; replacement or restart is not authorized
- Required controller state: exactly `live=true`
- Current node: `PR252-base-conflict-resolution`
- Mode/revision: base-conflict resolution / `phase-01-pr252-target-binding-correction-r1`
- Stable target binding: `canonicalAtProducerAdmission`
- Source: `origin/refactor/team-provisioning-round2-reapply` pinned to
  `7afc908ce92f14b4b0ebd06cc4aa3a4cf33807d0`
- Capacity after the launch gate: exactly one `xhigh`/`default` producer, then exactly one fresh
  independent `xhigh`/`default` integration reviewer; Fast disabled for both
- This docs job launches none and ends `HOLD`

The prior r1 worker is terminal `failed_no_output` and authored nothing. The prior packet's concrete
future target was self-staling because policy integration necessarily advanced canonical. This
target-binding-correction packet is the worker's only authorized replacement. `controller-v17` must
never inspect, resume, or reuse the worker or the superseded packet.

## Binding P1.1D historical gate

P1.1D has independent `FORMAL ACCEPT` with P0/P1/P2 `0/0/0` by
`agent-teams-hosted-web-refactor-p1-1d-shadowed-map-review-v17-r4`.

| Field                        | Historical provenance value                                        |
| ---------------------------- | ------------------------------------------------------------------ |
| Strict result SHA-256        | `be0c9abd679f817c386d1d06d1b738c2a1505bb3c4718279129ab74842c98fa6` |
| Reviewed output ID           | `f3394026185348c84673d44a9b30a82667c3ff9435b5d4d7609c04785c274f41` |
| Accepted integration         | `p1-1d-shadowed-map-r4-accepted-integration-v3`                    |
| Accepted/pushed P1.1D commit | `e7e7e734c82c49105682e7a19bbedafa1f5ddbad`                         |

These four values are immutable accepted historical provenance. The P1.1D commit is not the current
route target. A stale result, nonzero finding count, unpushed provenance commit, or attempt to
rerun/reinterpret P1.1D fails closed.

## Outcome

After this correction is accepted, policy-integrated, and pushed, resolve one JIT canonical binding.
Then produce and independently review one immutable resolution patch that changes exactly the five
packet paths byte-for-byte to their audited blobs at the pinned source commit. After review `ACCEPT`,
bind the reviewed output to the unchanged source identity and resolved target identity and let the
integration runtime validate and create the true two-parent merge. The producer/reviewer never stage,
merge, commit, or push.

## One JIT canonical binding

`canonicalAtProducerAdmission` means the exact current canonical commit after this seven-path
correction router has been accepted, policy-integrated, and pushed. No concrete future target SHA is
embedded in this packet.

Product-worker capacity remains zero until all three policy steps are complete and the same
`controller-v17` reports exactly `live=true`. Immediately before producer admission,
`controller-v17` resolves the binding exactly once to a full 40-character commit SHA. It stores that
one immutable value and renders it into all of these fields:

- route `canonicalSha`, `phaseStartSha`, `baseSha`, `planBundleCommit`, materialization `HEAD`, and
  `expectedTargetCommit`;
- the producer admission contract's matching six concrete fields;
- producer worktree `HEAD` and base;
- reviewer `canonicalSha`, `phaseStartSha`, `baseSha`, materialization `HEAD`, and
  `expectedTargetCommit`;
- `mark_reviewed.expectedTargetCommit` and the integration target; and
- the first final merge parent.

Every rendered field must contain the same full SHA, not the binding name or an explanatory
placeholder. Neither reviewer admission nor runtime integration may resolve it again. If current
canonical changes after the one resolution, or any concrete field differs, stop on drift instead of
rebinding.

## Launch gate and producer admission

Producer capacity is zero until this exact seven-path docs router is accepted, policy-integrated, and
pushed; the same `controller-v17` is live; the P1.1D historical facts above are verified; the fixed
source commit and five source blobs are available; no prior conflict worker is active; and r1 is
confirmed terminal `failed_no_output` without reading or reusing it. This docs transition does not
attest that those future runtime gates are already true.

Only after those gates pass does the controller perform the one JIT resolution and render the
existing ProjectScopedControl operation for exactly one producer:

```text
operation: codex_goal_project_refill_worker
workerRole: producer
reasoningEffort: xhigh
serviceTier: default
fastMode: false
preStartAdmission.mode: serial-builtin
preStartAdmission.contract.kind: worker-launch
preStartAdmission.contract.format: 1
preStartAdmission.contract.canonicalSha: resolved canonicalAtProducerAdmission full SHA
preStartAdmission.contract.baseSha: resolved canonicalAtProducerAdmission full SHA
preStartAdmission.contract.phaseStartSha: resolved canonicalAtProducerAdmission full SHA
preStartAdmission.contract.planBundleCommit: resolved canonicalAtProducerAdmission full SHA
preStartAdmission.contract.materializationHead: resolved canonicalAtProducerAdmission full SHA
preStartAdmission.contract.expectedTargetCommit: resolved canonicalAtProducerAdmission full SHA
preStartAdmission.contract.packetRevision: phase-01-pr252-target-binding-correction-r1
preStartAdmission.contract.controllerPacket: docs/hosted-web-phases/phase-01/controller-packet.md
preStartAdmission.contract.lanePacket: docs/hosted-web-phases/phase-01/lanes/pr252-base-conflict-resolution.md
preStartAdmission.contract.phaseId: phase-01
preStartAdmission.contract.laneId: pr252-base-conflict-resolution
preStartAdmission.contract.reviewKind: implementation
```

The `resolved ... full SHA` phrases describe packet rendering; literal phrases are invalid admission
values. There is no preexisting patch input, so the source commit must not be mislabeled as
`inputPatchHash`. The controller supplies the stable contract's exact `ownedPaths`, `mandatoryDocs`,
empty `mandatoryScripts`/`mandatoryFixtures`, non-empty `requiredChecks`, and sandbox-only
`executionPolicy` from the lane packet. It separately binds the unchanged source identity to the
remote/branch/pinned commit below. It does not invent unsupported contract fields or grant raw Git
writer authority.

## Exact seven-path router ownership

1. `docs/hosted-web-phases/START_HERE.md`
2. `docs/hosted-web-phases/README.md`
3. `docs/hosted-web-phases/EXECUTION_INDEX.json`
4. `docs/hosted-web-phases/phase-01/README.md`
5. `docs/hosted-web-phases/phase-01/controller-packet.md`
6. `docs/hosted-web-phases/phase-01/execution-dag.md`
7. `docs/hosted-web-phases/phase-01/lanes/pr252-base-conflict-resolution.md`

Every product, test, runtime, orchestration, research/evidence, configuration, package, lockfile,
handoff, ledger, and integration path is read-only to this docs author. An eighth changed path rejects
the router.

## Exact producer conflict scope

| Path                                                                          | Required complete source blob OID          |
| ----------------------------------------------------------------------------- | ------------------------------------------ |
| `src/features/task-board-commands/core/application/TaskBoardCommandFacade.ts` | `f5515ddac4cd7bee957a75bc06aad78309ad3a74` |
| `src/main/services/team/TeamDataService.ts`                                   | `a8fea50ddbd71563f2ab7853978d6420eed6c441` |
| `src/renderer/components/team/TeamDetailView.tsx`                             | `5cbaef7f23046dab598a1c2878811adbfd62ea4c` |
| `test/features/task-board-commands/TaskBoardCommands.e2e.test.ts`             | `0c0a717fea61031c3c24a4ef787c0acd9bd80ad5` |
| `test/main/services/team/TeamDataService.test.ts`                             | `c281cac6493e07abf1ddd201255539e902122af2` |

These five paths are the complete producer writer set and the only legal merge conflict set. The
producer copies the complete pinned-source bytes, runs every packet check, and returns one immutable
runtime output. It may not hand-resolve, combine, reformat, regenerate, stage, merge, commit, push, or
write a handoff/evidence file.

## Independent integration review gate

After producer completion, capacity returns to zero until `controller-v17` admits exactly one fresh
independent integration reviewer using `workerRole: reviewer`, `reviewKind: integration`, reasoning
effort `xhigh`, service tier `default`, Fast disabled, and an isolated review worktree. The reviewer is
independent of the router author, current producer, every P1.1D producer/reviewer, and prior PR #252
conflict workers.

The reviewer has no repository writer or Git mutation authority and may not re-resolve canonical. It
must materialize the immutable output against the same stored full SHA, require reviewer
`canonicalSha`, `phaseStartSha`, `baseSha`, materialization `HEAD`, and `expectedTargetCommit` to
equal it and current canonical, rerun both focused test files, classify the inherited typecheck
baseline, rerun exact five-file `lint:fast:files`, Prettier, diff, full-blob, ownership, no-stage,
secret/private-path, and binary checks, and independently prove the exact conflict set. It returns
explicit `ACCEPT` or `REJECT` with complete P0/P1/P2 findings. Only complete `ACCEPT` with P0/P1/P2
`0/0/0` advances.

## Reviewed binding and integration attempt

After `ACCEPT`, `mark_reviewed` must bind the immutable reviewed output ID to exactly the unchanged
source identity and already-resolved target:

```json
{
  "sourceRemote": "origin",
  "sourceBranch": "refactor/team-provisioning-round2-reapply",
  "sourceCommit": "7afc908ce92f14b4b0ebd06cc4aa3a4cf33807d0",
  "expectedTargetCommit": "<resolved canonicalAtProducerAdmission full SHA>"
}
```

The controller must render the concrete full SHA; the explanatory placeholder is invalid runtime
input. The only legal integration admission shape is:

```text
open_integration_attempt({ reviewedOutputId })
```

No duplicated source/target arguments, branch-head substitutions, raw patch argument, worktree path,
or worker-provided commit is accepted. Runtime chooses no DAG or branch and does not resolve the
canonical binding. It only resolves the reviewed record, validates that every concrete target field
equals both the stored `canonicalAtProducerAdmission` SHA and current canonical, and fails closed on
drift. It then recreates the true merge of the resolved target and pinned source, requires the
conflict set to equal the five paths above, applies only reviewed resolution bytes, reruns every
required check, and verifies the five final blob OIDs.

The created merge must have parents in exact order `[resolved canonicalAtProducerAdmission,
7afc908ce92f14b4b0ebd06cc4aa3a4cf33807d0]`. A one-parent, squash, patch-only, reversed-parent,
moving-source-head, target-drifted, missing/extra-conflict, extra-diff, or blob-mismatched commit is
rejected and not pushed. Only the validated true two-parent result may be pushed.

## Exact docs-router checks

Run each command independently from the repository root after exporting
`PATH=/usr/local/bin:/usr/bin:/bin:$PATH`:

```bash
node <<'NODE'
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const assert = (value, message) => {
  if (!value) throw new Error(message)
}
const same = (actual, expected) =>
  actual.length === expected.length && actual.every((value, index) => value === expected[index])
const binding = 'canonicalAtProducerAdmission'
const historicalP11dCommit = 'e7e7e734c82c49105682e7a19bbedafa1f5ddbad'
const source = '7afc908ce92f14b4b0ebd06cc4aa3a4cf33807d0'
const node = 'PR252-base-conflict-resolution'
const revision = 'phase-01-pr252-target-binding-correction-r1'
const isBinding = (value) =>
  value && typeof value === 'object' && Object.keys(value).length === 1 && value.binding === binding
const routerPaths = [
  'docs/hosted-web-phases/START_HERE.md',
  'docs/hosted-web-phases/README.md',
  'docs/hosted-web-phases/EXECUTION_INDEX.json',
  'docs/hosted-web-phases/phase-01/README.md',
  'docs/hosted-web-phases/phase-01/controller-packet.md',
  'docs/hosted-web-phases/phase-01/execution-dag.md',
  'docs/hosted-web-phases/phase-01/lanes/pr252-base-conflict-resolution.md',
]
const boundFieldPaths = [
  'currentRoute.canonicalSha',
  'currentRoute.baseSha',
  'currentRoute.phaseStartSha',
  'currentRoute.planBundleCommit',
  'currentRoute.materializationHead',
  'currentRoute.expectedTargetCommit',
  'projectScopedProducerAdmission.preStartAdmission.contract.canonicalSha',
  'projectScopedProducerAdmission.preStartAdmission.contract.baseSha',
  'projectScopedProducerAdmission.preStartAdmission.contract.phaseStartSha',
  'projectScopedProducerAdmission.preStartAdmission.contract.planBundleCommit',
  'projectScopedProducerAdmission.preStartAdmission.contract.materializationHead',
  'projectScopedProducerAdmission.preStartAdmission.contract.expectedTargetCommit',
  'projectScopedProducerAdmission.planBundleCommitBinding',
  'integrationReviewAdmission.materialization.canonicalSha',
  'integrationReviewAdmission.materialization.baseSha',
  'integrationReviewAdmission.materialization.phaseStartSha',
  'integrationReviewAdmission.materialization.materializationHead',
  'integrationReviewAdmission.materialization.expectedTargetCommit',
  'pr252BaseConflictScope.expectedTargetCommit',
  'reviewedIntegrationProtocol.markReviewedMergeBinding.expectedTargetCommit',
  'reviewedIntegrationProtocol.integrationTargetCommit',
  'reviewedIntegrationProtocol.requiredParentOrder[0]',
]
const ownedPaths = [
  'src/features/task-board-commands/core/application/TaskBoardCommandFacade.ts',
  'src/main/services/team/TeamDataService.ts',
  'src/renderer/components/team/TeamDetailView.tsx',
  'test/features/task-board-commands/TaskBoardCommands.e2e.test.ts',
  'test/main/services/team/TeamDataService.test.ts',
]
const blobs = [
  'f5515ddac4cd7bee957a75bc06aad78309ad3a74',
  'a8fea50ddbd71563f2ab7853978d6420eed6c441',
  '5cbaef7f23046dab598a1c2878811adbfd62ea4c',
  '0c0a717fea61031c3c24a4ef787c0acd9bd80ad5',
  'c281cac6493e07abf1ddd201255539e902122af2',
]
const requiredChecks = [
  'pnpm exec vitest run test/features/task-board-commands/TaskBoardCommands.e2e.test.ts',
  'pnpm exec vitest run test/main/services/team/TeamDataService.test.ts',
  'pnpm typecheck',
  'pnpm lint:fast:files -- src/features/task-board-commands/core/application/TaskBoardCommandFacade.ts src/main/services/team/TeamDataService.ts src/renderer/components/team/TeamDetailView.tsx test/features/task-board-commands/TaskBoardCommands.e2e.test.ts test/main/services/team/TeamDataService.test.ts',
  'pnpm exec prettier --check src/features/task-board-commands/core/application/TaskBoardCommandFacade.ts src/main/services/team/TeamDataService.ts src/renderer/components/team/TeamDetailView.tsx test/features/task-board-commands/TaskBoardCommands.e2e.test.ts test/main/services/team/TeamDataService.test.ts',
  'git diff --check',
  'exact five-path diff and no-stage proof',
  'five complete source-blob OID proofs',
  'secret/private-path and binary scans',
  'final merge parents and exact conflict-set proof',
]
const index = JSON.parse(fs.readFileSync(routerPaths[2], 'utf8'))
assert(index.currentExecutableSubphase === node, 'wrong current node')
assert(same(index.currentExecutableNodes, [node]), 'wrong executable node set')
assert(index.currentRouterTerminalState === 'HOLD', 'router is not HOLD')
assert(index.durableController.identity === 'controller-v17', 'controller drift')
assert(index.durableController.requiredState === 'live=true', 'controller state drift')
assert(index.durableController.replacementAuthorized === false, 'controller replacement enabled')
const jit = index.jitCanonicalBinding
assert(jit.name === binding, 'wrong JIT binding name')
assert(jit.stateInThisDocsRouter === 'unresolved', 'docs router falsely resolved future canonical')
assert(jit.resolvedBy === 'controller-v17', 'wrong canonical resolver')
assert(jit.requiredResolutionCount === 1, 'canonical resolution is not exactly once')
assert(jit.resolutionTiming === 'immediately-before-producer-admission', 'wrong resolution timing')
assert(jit.resolvedValueFormat === 'full-40-character-commit-sha', 'wrong SHA format')
assert(jit.downstreamReresolutionAuthorized === false, 'downstream re-resolution enabled')
assert(same(jit.boundFieldPaths, boundFieldPaths), 'bound-field set/order drift')
for (const key of [
  'canonicalSha',
  'baseSha',
  'phaseStartSha',
  'planBundleCommit',
  'materializationHead',
  'expectedTargetCommit',
]) {
  assert(isBinding(index.currentRoute[key]), `route binding drift: ${key}`)
}
assert(index.currentRoute.sourceRemote === 'origin', 'source remote drift')
assert(index.currentRoute.sourceBranch === 'refactor/team-provisioning-round2-reapply', 'source branch drift')
assert(index.currentRoute.sourceCommit === source, 'source commit drift')
assert(index.currentRoute.lanePackets.length === 1, 'lane count drift')
assert(index.currentRoute.lanePackets[0].packetRevision === revision, 'packet revision drift')
assert(index.currentRoute.lanePackets[0].path === routerPaths[6], 'lane path drift')
const launch = index.currentRoute.launchGate.required
for (const key of [
  'exactSevenPathTargetBindingCorrectionAccepted',
  'exactSevenPathTargetBindingCorrectionPolicyIntegrated',
  'exactSevenPathTargetBindingCorrectionPushed',
  'canonicalAtProducerAdmissionResolvedExactlyOnce',
  'allTargetFieldsBoundToResolvedFullSha',
]) {
  assert(launch[key] === true, `launch gate drift: ${key}`)
}
assert(index.currentRoute.launchGate.attestedByThisDocsTransition === false, 'docs falsely attest launch gate')
const accepted = index.acceptedP11dShadowedMapRemediation
assert(accepted.disposition === 'FORMAL ACCEPT', 'P1.1D is not FORMAL ACCEPT')
assert(Object.values(accepted.findings).every((value) => value === 0), 'P1.1D finding drift')
assert(
  accepted.reviewer === 'agent-teams-hosted-web-refactor-p1-1d-shadowed-map-review-v17-r4',
  'P1.1D reviewer drift'
)
assert(
  accepted.strictResultSha256 ===
    'be0c9abd679f817c386d1d06d1b738c2a1505bb3c4718279129ab74842c98fa6',
  'P1.1D strict result drift'
)
assert(
  accepted.reviewedOutputId ===
    'f3394026185348c84673d44a9b30a82667c3ff9435b5d4d7609c04785c274f41',
  'P1.1D reviewed output drift'
)
assert(accepted.integrationAttempt === 'p1-1d-shadowed-map-r4-accepted-integration-v3', 'integration drift')
assert(accepted.acceptedCommit === historicalP11dCommit, 'P1.1D provenance commit drift')
assert(accepted.acceptedCommitUse === 'immutable-historical-provenance-only', 'P1.1D commit reused as target')
assert(accepted.pushed === true, 'P1.1D provenance commit is not pushed')
assert(index.retiredPr252BaseConflictR1.status === 'failed_no_output', 'r1 status drift')
assert(index.retiredPr252BaseConflictR1.authoredOutput === false, 'r1 output invented')
assert(index.retiredPr252BaseConflictR1.soleReplacementPacket === revision, 'r1 replacement drift')
for (const admission of [index.projectScopedProducerAdmission, index.integrationReviewAdmission]) {
  assert(admission.reasoningEffort === 'xhigh', 'reasoning effort drift')
  assert(admission.serviceTier === 'default', 'service tier drift')
  assert(admission.fastMode === false, 'Fast enabled')
}
const producer = index.projectScopedProducerAdmission
assert(producer.producerCount === 1, 'producer count drift')
assert(producer.preStartAdmission.contractStateBeforeJitResolution === 'binding-template', 'template state drift')
assert(
  producer.preStartAdmission.contractStateRequiredAtAdmission === 'all-bound-fields-concrete-full-sha',
  'resolved contract requirement drift'
)
for (const key of [
  'canonicalSha',
  'baseSha',
  'phaseStartSha',
  'planBundleCommit',
  'materializationHead',
  'expectedTargetCommit',
]) {
  assert(isBinding(producer.preStartAdmission.contract[key]), `producer contract binding drift: ${key}`)
}
assert(producer.preStartAdmission.contract.packetRevision === revision, 'producer packet revision drift')
assert(isBinding(producer.planBundleCommitBinding), 'plan bundle binding drift')
const review = index.integrationReviewAdmission
assert(review.reviewerCount === 1, 'reviewer count drift')
assert(review.repositoryWriterAuthority === false, 'reviewer writer enabled')
assert(review.canonicalReresolutionAuthorized === false, 'reviewer canonical re-resolution enabled')
for (const key of ['canonicalSha', 'baseSha', 'phaseStartSha', 'materializationHead', 'expectedTargetCommit']) {
  assert(isBinding(review.materialization[key]), `review materialization binding drift: ${key}`)
}
assert(same(index.pr252BaseConflictScope.ownedPaths, ownedPaths), 'owned path drift')
assert(
  same(
    ownedPaths.map((value) => index.pr252BaseConflictScope.sourceBlobOids[value]),
    blobs
  ),
  'source blob drift'
)
assert(index.pr252BaseConflictScope.pathCount === 5, 'conflict path count drift')
assert(isBinding(index.pr252BaseConflictScope.expectedTargetCommit), 'scope target binding drift')
assert(same(index.requiredChecks, requiredChecks), 'required check drift')
const protocol = index.reviewedIntegrationProtocol
assert(protocol.markReviewedMergeBinding.sourceCommit === source, 'review source binding drift')
assert(isBinding(protocol.markReviewedMergeBinding.expectedTargetCommit), 'review target binding drift')
assert(same(protocol.openIntegrationAttemptAcceptedFields, ['reviewedOutputId']), 'integration input drift')
assert(isBinding(protocol.integrationTargetCommit), 'integration target binding drift')
assert(isBinding(protocol.requiredParentOrder[0]), 'first merge parent binding drift')
assert(protocol.requiredParentOrder[1] === source, 'second merge parent drift')
assert(protocol.runtimeValidation.role === 'validation-only', 'runtime role drift')
assert(protocol.runtimeValidation.choosesDag === false, 'runtime DAG choice enabled')
assert(protocol.runtimeValidation.choosesBranch === false, 'runtime branch choice enabled')
assert(protocol.runtimeValidation.resolvesCanonicalBinding === false, 'runtime canonical resolution enabled')
assert(protocol.runtimeValidation.allResolvedTargetFieldsMustEqualCurrentCanonical === true, 'canonical equality disabled')
assert(protocol.runtimeValidation.failClosedOnDrift === true, 'drift is not fail-closed')
assert(same(index.authorization.authorizedNow, []), 'product worker authorized before launch gate')
assert(
  same(index.authorization.conditionallyAuthorizedAfterLaunchGate, ['PR252-base-conflict-resolution-producer']),
  'conditional producer authority drift'
)
assert(
  same(index.authorization.blockedUntilValidatedMergePushed, ['P1.R2', 'P1.I', 'P1.F', 'Phase 2+']),
  'blocked successor drift'
)
assert(same(index.routerExclusiveOwnership, routerPaths), 'router ownership drift')
for (const packet of [index.packetHashes.controllerPacket, index.packetHashes.lanePacket]) {
  const actual = crypto.createHash('sha256').update(fs.readFileSync(packet.path)).digest('hex')
  assert(actual === packet.sha256, `packet hash drift: ${packet.path}`)
}
for (const routerPath of routerPaths.filter((value) => value.endsWith('.md'))) {
  const sourceText = fs.readFileSync(routerPath, 'utf8')
  for (const match of sourceText.matchAll(/\]\(([^)]+)\)/g)) {
    const targetPath = match[1].replace(/^<|>$/g, '').split('#')[0]
    if (!targetPath || /^[a-z]+:/i.test(targetPath)) continue
    assert(fs.existsSync(path.resolve(path.dirname(routerPath), targetPath)), `broken link ${targetPath}`)
  }
}
console.log('router-index-links-hashes: ok')
NODE
pnpm exec prettier --check docs/hosted-web-phases/START_HERE.md docs/hosted-web-phases/README.md docs/hosted-web-phases/EXECUTION_INDEX.json docs/hosted-web-phases/phase-01/README.md docs/hosted-web-phases/phase-01/controller-packet.md docs/hosted-web-phases/phase-01/execution-dag.md docs/hosted-web-phases/phase-01/lanes/pr252-base-conflict-resolution.md
git diff --check
git status --short
```

Also prove the docs job did not change `HEAD`; the diff contains exactly the seven ordered router
paths above; the cached diff is empty; every link target exists; controller and lane packet SHA-256
values match the index; all seven files are textual; and a scan of only those files contains no
credential/secret/auth/provider value, private/user/real-project path, or raw command/runtime body.

## Monitoring, stop, and HOLD

Stop on correction not accepted/integrated/pushed, a stale/mixed/multiply resolved target, unequal or
non-full concrete target field, canonical drift, unverified accepted fact/blob, controller
replacement/non-live state, r1 or superseded-packet inspection/reuse, second worker, Fast mode, wrong
effort/tier, extra/staged path, unsafe/binary content, check failure, worker Git mutation,
non-independent review, incomplete/REJECT result, runtime DAG/branch choice, invalid merge binding, or
integration input beyond `reviewedOutputId`.

P1.R2, P1.I, P1.F, and Phase 2+ remain blocked until the validated true two-parent merge is pushed.
This docs author does not launch a worker/controller/integration attempt and does not fetch, stage,
commit, merge, or push. Terminal state: `HOLD`.
