# Phase 1 controller packet: PR #252 task-provenance remediation router r1

## Status and authority

- Root role: orchestrator only
- Durable controller: `controller-v17`, exactly `live=true`; no replacement or restart
- Admission/integration owner: `ProjectScopedControl`
- Producer start: `codex_goal_project_refill_worker`, `workerRole: producer`
- Reviewer start: `codex_goal_project_prepare_verifier`, `workerRole: reviewer`, strict
  `reviewKind: review`
- Current node: `PR252-task-provenance-remediation`
- Revision: `phase-01-pr252-task-provenance-remediation-router-r1`
- Target-side baseline: `3256ee3b5b8e81b144aa0a14eac1bca080c9b779`
- Pinned current real base/merge source:
  `origin/refactor/team-provisioning-round2-reapply@e9ffa30cc016ad3cb833fcc0a138fa4f026eb850`
- Conditional capacity: one serial producer, then one fresh independent reviewer
- Worker profile: `gpt-5.6-sol`, `xhigh`, `serviceTier: "fast"`; no machine `fastMode`
- This docs job launches none and ends `HOLD`

Product-worker capacity is zero until this exact seven-path router receives independent `ACCEPT`, is
integrated, and is pushed. P1.R2, P1.I, P1.F, and Phase 2+ remain blocked until the validated ordered
merge is pushed.

## Rejection consumed

Independent reviewer r4 returned `FORMAL REJECT` for producer r3 with P0/P1/P2 `0/1/0`. The sole P1
proved that, when destination `reconcile` and task `creationCommand` were absent,
`TaskBoardCommandFacade.findById` accepted an unrelated same-ID task with subject
`UNRELATED SUBJECT` and returned outcome `Executed`. Every other r3 semantic and check passed.

The successor binds these immutable records:

| Record                | SHA-256                                                            | Current authority                      |
| --------------------- | ------------------------------------------------------------------ | -------------------------------------- |
| Useful r3 handoff     | `f810a0aa191e82316737c5c0069ee6225597d8a477d77b50c57bc3fd931fe579` | strict input and remediation reference |
| Rejected r3 full diff | `cb534246905f6fd7cc03b0b761018157ed12d204d11819f0978915af7c778491` | review provenance/reference only       |
| Byte-copy rejection   | `a0fade213fd86c52022f944c9d3a9f169175f1fd5a54f6c19652173ae5307304` | terminal; never reuse or integrate     |
| Rejected semantic r1  | `95dcdae236fdadbd63bfb3022441accc4354cffdc5ca6db7447e7a01e9d53221` | terminal invalid launch contract       |
| Accepted semantic r2  | `50eb69f32c4e83ba740fe37eb1d43e3a6ff10c06`                         | historical predecessor authority only  |

The r3 full diff is not a patch carrier and is never applied, materialized, or directly integrated.
The successor must remediate the reviewed work rather than produce a clean rewrite.

## Corrected base authority and conflict route

Direct
`git ls-remote origin refs/heads/refactor/team-provisioning-round2-reapply` returned
`e9ffa30cc016ad3cb833fcc0a138fa4f026eb850`. That commit is the current real base, active merge
source, and required second parent.

The GitHub PR `baseOid` `d2585e7634800eb795644c4b6d0e8baf5f81c98f` is stale. Local proof shows
it is an ancestor of `e9ffa30c...` by 52 commits. Former pinned source
`7afc908ce92f14b4b0ebd06cc4aa3a4cf33807d0` is also an ancestor of `e9ffa30c...`; neither stale
identity has current routing authority.

Fresh merge-tree proof between target-side baseline `3256ee3b...` and pinned source `e9ffa30c...`
reports exactly the same five conflicts named below. The standalone-normal-push interpretation is
superseded. A true two-parent merge, ordered parents, pinned-source non-conflict materialization, and
the final source-only command-identity test remain required.

## Outcome and target binding

After router acceptance/integration/push, `ProjectScopedControl` resolves the accepted pushed router
commit exactly once to a full SHA and stores it as `storedAcceptedPushedRouterCommit`. That one value
binds future `canonicalSha`, `phaseStartSha`, plan target, worktree `HEAD`, reviewer target,
`mark_reviewed` target, integration target, and true-merge first parent. It is never re-resolved.

The strict-contract `baseSha` remains target-side snapshot `3256ee3b...`; it does not rebind. The
distinct source/current-real-base `e9ffa30c...` is immutable outer merge metadata. A symbolic target,
second resolution, unequal target, stale worktree, wrong source, or canonical drift fails closed.

After the launch gate, render one fully concrete producer request. The producer materializes a fresh
merge attempt, resolves exactly five conflicts, remediates the one P1, self-reviews, emits one
immutable output, and returns `HOLD`. Then render exactly one fresh no-write reviewer request. Only
independent `ACCEPT` with P0/P1/P2 `0/0/0` may advance to broker integration.

## Worker request contract

The authoritative renderer specifications are in
[`EXECUTION_INDEX.json`](../EXECUTION_INDEX.json). Producer and reviewer strict contracts each have
exactly these 18 keys in this order:

1. `kind`
2. `format`
3. `canonicalSha`
4. `baseSha`
5. `phaseStartSha`
6. `packetRevision`
7. `controllerPacket`
8. `lanePacket`
9. `phaseId`
10. `laneId`
11. `inputPatchHash`
12. `reviewKind`
13. `ownedPaths`
14. `mandatoryDocs`
15. `mandatoryScripts`
16. `mandatoryFixtures`
17. `requiredChecks`
18. `executionPolicy`

The producer contract uses the stored target, fixed target-side `baseSha`, this revision and lane,
`reviewKind: implementation`, and useful handoff hash as `inputPatchHash`. The reviewer contract uses
the same stored target/base/revision/scope, `reviewKind: review`, and the SHA-256 of the sole immutable
producer output. Both copy the same exact seven structured checks; reviewer policy is no-write.

The outer producer envelope is exactly one serial request with operation, role, model
`gpt-5.6-sol`, effort `xhigh`, and `serviceTier: "fast"`. The reviewer envelope uses the corresponding
review operation/role and the same model, effort, and tier. No `fastMode` key is present anywhere in a
machine request envelope. Merge source, plan, and materialization data remain outer metadata and are
fully concrete before admission.

Binding objects and copy directives are renderer instructions only. An operational request containing
one, a placeholder, missing/extra key, wrong input hash, wrong source, wrong path, wrong model/effort/
tier, or nonconcrete target is rejected.

## Exact seven-path router ownership

1. `docs/hosted-web-phases/START_HERE.md`
2. `docs/hosted-web-phases/README.md`
3. `docs/hosted-web-phases/EXECUTION_INDEX.json`
4. `docs/hosted-web-phases/phase-01/README.md`
5. `docs/hosted-web-phases/phase-01/controller-packet.md`
6. `docs/hosted-web-phases/phase-01/execution-dag.md`
7. `docs/hosted-web-phases/phase-01/lanes/pr252-base-conflict-resolution.md`

Every product, test, runtime, orchestration implementation, research/evidence, configuration,
package, lockfile, handoff, ledger, and integration path is read-only to this docs author. An eighth
changed path rejects the router.

## Exact five-path producer ownership

1. `src/features/task-board-commands/core/application/TaskBoardCommandFacade.ts`
2. `src/main/services/team/TeamDataService.ts`
3. `src/renderer/components/team/TeamDetailView.tsx`
4. `test/features/task-board-commands/TaskBoardCommands.e2e.test.ts`
5. `test/main/services/team/TeamDataService.test.ts`

The producer resolves all five fresh merge conflicts, and its immutable output spans exactly these
five paths. New remediation semantics are restricted to paths 1 and 4. Paths 2, 3, and 5 preserve the
passing r3 resolution unless an owned-path compile-coherence change is demonstrated, minimized,
explained, and covered. No sixth path is writable.

## Semantic acceptance

1. Start from a fresh true merge of the stored target first and pinned `e9ffa30c...` second. Never
   replay the rejected diff or replace a complete file with a source blob.
2. Preserve all r3 semantics that passed r4: partial-create recovery, stale-command recovery,
   idempotent retry identity, JSON validation, the coherent `TeamDataService` reconciliation
   capability, the `TeamDetailView` dual-signature adapter, and relation normalization.
3. Keep destination `reconcile` optional and use it when available. Its absence does not disable
   durable creation or make an unknown outcome successful.
4. At every `findById` fallback success site, pass the requested payload and validate the found task
   subject equals the requested string subject after trimming. Same ID alone never proves success.
5. Do not require or compare `creationCommand`, `createdBy`, or relations as provenance. This restores
   target-safe payload/subject validation without introducing a provenance contract.
6. An unrelated same-ID result throws `TaskBoardCreateDestinationConflictError`, is terminal, and can
   never become `Executed`, `Retried`, `Reconciled`, `Replayed`, or another success.
7. Retain four target E2E cases and five source cases, then add one regression with exact subject
   `UNRELATED SUBJECT`, no `reconcile`, and no `creationCommand`, for exactly ten combined cases.
8. Leave no duplicate branch implementation, unreachable shim, source-only mismatch, conflict marker,
   or widened writer scope.

## Producer and reviewer gates

Run independently in both isolated materializations:

```bash
git diff --cached --quiet
pnpm exec vitest run test/features/task-board-commands/TaskBoardCommands.e2e.test.ts
pnpm exec vitest run test/main/services/team/TeamDataService.test.ts
node scripts/hosted-web/phase-0/final-gate/normalize-typescript-diagnostics.mjs --mode milestone
pnpm lint:fast:files -- src/features/task-board-commands/core/application/TaskBoardCommandFacade.ts src/main/services/team/TeamDataService.ts src/renderer/components/team/TeamDetailView.tsx test/features/task-board-commands/TaskBoardCommands.e2e.test.ts test/main/services/team/TeamDataService.test.ts
pnpm exec prettier --check src/features/task-board-commands/core/application/TaskBoardCommandFacade.ts src/main/services/team/TeamDataService.ts src/renderer/components/team/TeamDetailView.tsx test/features/task-board-commands/TaskBoardCommands.e2e.test.ts test/main/services/team/TeamDataService.test.ts
git diff --check
```

The focused suites, including exactly ten TaskBoard E2E cases, empty index, lint, Prettier, and diff
checks must pass. Native TypeScript classification is green only with the inherited seven Phase 0
diagnostics:

- `auth-artifacts-spike.test.ts`: TS7016 at 25:8; TS7031 at 66:31; TS18046 at 117:68; TS7031 at
  413:48; TS7031 at 733:10;
- `evidence-scanner.test.ts`: TS7016 at 12:8; and
- `scan-runtime-surfaces.test.ts`: TS2352 at 162:44.

Any added, removed, moved, or changed diagnostic fails. Also require exact five-path diff/ownership,
both rejection hashes, fresh target/source merge-tree identity and exact conflict set, semantic
no-whole-blob-copy/no-clean-rewrite proof, exact unrelated-same-ID never-success proof, and classified
conflict-marker, secret/auth/provider, private/user/real-project-path, and textual/non-binary scans
over all five owned paths.

The source-added non-conflict path `test/renderer/utils/createTaskCommandIdentity.test.ts` is not a
sixth producer-owned path. It is materialized from pinned source by the broker and becomes a required
final-shape test.

## Independent review

After producer `HOLD`, `ProjectScopedControl` invokes the verifier exactly once. The reviewer is fresh
and independent of the router author, current producer, r3, r4, rejected earlier PR252 workers, and
prior accepted workers. It has no writer, repair, refill, re-resolution, stage, merge, commit, or push
authority. It materializes the immutable producer output at the stored target with the same pinned
source, reruns every gate and scan, and returns explicit `ACCEPT` or `REJECT`. Acceptance requires
P0/P1/P2 `0/0/0` and complete evidence.

## Reviewed ordered broker integration

Immediately before integration, `ProjectScopedControl` reruns exactly:

```bash
git ls-remote origin refs/heads/refactor/team-provisioning-round2-reapply
```

The single remote branch head must remain
`e9ffa30cc016ad3cb833fcc0a138fa4f026eb850`. If it moved, end `HOLD` and require a new-base review;
do not silently rebind, merge, or fetch a substitute.

With unchanged source and reviewer `ACCEPT`, the broker creates a true merge with ordered parents
`[storedAcceptedPushedRouterCommit, e9ffa30cc016ad3cb833fcc0a138fa4f026eb850]`. It proves the
complete conflict set is exactly the five owned paths, materializes all pinned-source non-conflicts,
applies only the accepted five-path output, and reruns every producer/reviewer gate on the final
shape. It then runs and requires green:

```bash
pnpm exec vitest run test/renderer/utils/createTaskCommandIdentity.test.ts
```

Only then may it create a conventional merge commit and push. A moved source, one-parent, squash,
patch-only, reversed-parent, extra-conflict, clean-rewrite, rejected-diff replay, whole-blob-copy,
placeholder, or gate-failing result is rejected and not pushed.

## Exact docs-router checks

Run from the repository root with `PATH=/usr/local/bin:/usr/bin:/bin:$PATH`:

```bash
node <<'NODE'
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

const target = '3256ee3b5b8e81b144aa0a14eac1bca080c9b779'
const source = 'e9ffa30cc016ad3cb833fcc0a138fa4f026eb850'
const staleBase = 'd2585e7634800eb795644c4b6d0e8baf5f81c98f'
const oldSource = '7afc908ce92f14b4b0ebd06cc4aa3a4cf33807d0'
const handoff = 'f810a0aa191e82316737c5c0069ee6225597d8a477d77b50c57bc3fd931fe579'
const rejectedDiff = 'cb534246905f6fd7cc03b0b761018157ed12d204d11819f0978915af7c778491'
const revision = 'phase-01-pr252-task-provenance-remediation-router-r1'
const node = 'PR252-task-provenance-remediation'
const targetBinding = 'storedAcceptedPushedRouterCommit'
const outputBinding = 'immutableRemediationOutputPatchHash'
const routerPaths = [
  'docs/hosted-web-phases/START_HERE.md',
  'docs/hosted-web-phases/README.md',
  'docs/hosted-web-phases/EXECUTION_INDEX.json',
  'docs/hosted-web-phases/phase-01/README.md',
  'docs/hosted-web-phases/phase-01/controller-packet.md',
  'docs/hosted-web-phases/phase-01/execution-dag.md',
  'docs/hosted-web-phases/phase-01/lanes/pr252-base-conflict-resolution.md',
]
const ownedPaths = [
  'src/features/task-board-commands/core/application/TaskBoardCommandFacade.ts',
  'src/main/services/team/TeamDataService.ts',
  'src/renderer/components/team/TeamDetailView.tsx',
  'test/features/task-board-commands/TaskBoardCommands.e2e.test.ts',
  'test/main/services/team/TeamDataService.test.ts',
]
const semanticPaths = [ownedPaths[0], ownedPaths[3]]
const coherencePaths = [ownedPaths[1], ownedPaths[2], ownedPaths[4]]
const mandatoryDocs = [
  'AGENTS.md',
  'docs/hosted-web-phases/START_HERE.md',
  'docs/hosted-web-phases/EVIDENCE_LIFECYCLE.md',
  'docs/hosted-web-phases/README.md',
  'docs/hosted-web-phases/EXECUTION_INDEX.json',
  'docs/hosted-web-phases/phase-01/controller-packet.md',
  'docs/hosted-web-phases/phase-01/lanes/pr252-base-conflict-resolution.md',
  'CLAUDE.md',
  'AGENT_CRITICAL_GUARDRAILS.md',
  'docs/hosted-web-phases/PACKET_STANDARD.md',
]
const contractKeys = [
  'kind', 'format', 'canonicalSha', 'baseSha', 'phaseStartSha', 'packetRevision',
  'controllerPacket', 'lanePacket', 'phaseId', 'laneId', 'inputPatchHash', 'reviewKind',
  'ownedPaths', 'mandatoryDocs', 'mandatoryScripts', 'mandatoryFixtures', 'requiredChecks',
  'executionPolicy',
]
const exact = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const index = JSON.parse(fs.readFileSync(routerPaths[2], 'utf8'))
const hasKey = (value, key) => {
  if (!value || typeof value !== 'object') return false
  if (Object.prototype.hasOwnProperty.call(value, key)) return true
  return Object.values(value).some((child) => hasKey(child, key))
}
const resolve = (value, bindings) => {
  if (Array.isArray(value)) return value.map((child) => resolve(child, bindings))
  if (!value || typeof value !== 'object') return value
  if (Object.keys(value).length === 1 && typeof value.binding === 'string') {
    assert(value.binding in bindings, `unresolved binding ${value.binding}`)
    return bindings[value.binding]
  }
  if (Object.keys(value).length === 1 && typeof value.copyExactFrom === 'string') {
    assert(value.copyExactFrom in index, `unresolved copy ${value.copyExactFrom}`)
    return structuredClone(index[value.copyExactFrom])
  }
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, resolve(child, bindings)]))
}
const render = (renderer, bindings) =>
  Object.fromEntries(renderer.outputKeyOrder.map((key) => [key, resolve(renderer.valueSources[key], bindings)]))
const validateContract = (contract, expected) => {
  assert(exact(Object.keys(contract), contractKeys), `${expected.label} contract shape drift`)
  assert.equal(contract.kind, 'worker-launch')
  assert.equal(contract.format, 1)
  assert.equal(contract.canonicalSha, expected.storedTarget)
  assert.equal(contract.phaseStartSha, expected.storedTarget)
  assert.equal(contract.baseSha, target)
  assert.equal(contract.packetRevision, revision)
  assert.equal(contract.laneId, 'pr252-task-provenance-remediation')
  assert.equal(contract.inputPatchHash, expected.input)
  assert.equal(contract.reviewKind, expected.kind)
  assert(exact(contract.ownedPaths, ownedPaths))
  assert(exact(contract.mandatoryDocs, mandatoryDocs))
  assert(exact(contract.requiredChecks, index.strictRequiredChecks))
  assert(contract.requiredChecks.every((check) =>
    exact(Object.keys(check), ['id', 'cwd', 'command']) && check.cwd === 'src' && check.command.startsWith('cd .. && ')))
  assert(exact(Object.keys(contract.executionPolicy), ['mode', 'sandboxRoot', 'forbiddenRealProjects']))
  assert.equal(contract.executionPolicy.mode, 'sandbox-only')
  assert(contract.executionPolicy.forbiddenRealProjects.length > 0)
  assert(!hasKey(contract, 'fastMode'))
}

assert.equal(index.currentExecutableSubphase, node)
assert(exact(index.currentExecutableNodes, [node]))
assert.equal(index.currentRouterRevision, revision)
assert.equal(index.currentRouterTerminalState, 'HOLD')
assert.equal(index.fixedRouterBaseSha, target)
assert(!hasKey(index, 'fastMode'), 'unsupported fastMode key present')

const authority = index.remoteBaseAuthority
assert.equal(authority.pinnedCurrentRealBaseSha, source)
assert.equal(authority.proofResultSha, source)
assert.equal(authority.githubPrBaseOid, staleBase)
assert.equal(authority.githubPrBaseOidClassification, 'stale')
assert(authority.githubPrBaseOidIsAncestorOfPinnedBase)
assert.equal(authority.githubPrBaseOidBehindPinnedBaseBy, 52)
assert.equal(authority.formerPinnedSourceSha, oldSource)
assert(authority.formerPinnedSourceIsAncestorOfPinnedBase)
assert(!authority.formerPinnedSourceHasCurrentAuthority)
assert(authority.remoteHeadMustBeRecheckedImmediatelyBeforeIntegration)

const mergeTree = index.freshMergeTreeProof
assert.equal(mergeTree.targetSha, target)
assert.equal(mergeTree.sourceSha, source)
assert.equal(mergeTree.mergeBaseSha, staleBase)
assert.equal(mergeTree.conflictCount, 5)
assert(exact(mergeTree.conflictPaths, ownedPaths))
assert(mergeTree.standaloneNormalPushInterpretationSuperseded && mergeTree.trueMergeRouteRequired)

assert.equal(index.currentRoute.baseSha, target)
assert(exact(index.currentRoute.mergeSource, {
  remote: 'origin', branch: 'refactor/team-provisioning-round2-reapply', commit: source,
}))
assert(Object.values(index.currentRoute.launchGate.required).every(Boolean))
assert(!index.currentRoute.launchGate.attestedByThisDocsTransition)
for (const field of ['canonicalSha', 'phaseStartSha', 'sourceRef', 'baseBranch', 'worktreeHead']) {
  assert(exact(index.currentRoute[field], { binding: targetBinding }))
}

const rejected = index.rejectedPr252SemanticProducerR3
assert.equal(rejected.disposition, 'FORMAL REJECT')
assert(exact(rejected.findings, { P0: 0, P1: 1, P2: 0 }))
assert.equal(rejected.negativeControl.returnedSubject, 'UNRELATED SUBJECT')
assert.equal(rejected.negativeControl.returnedOutcome, 'Executed')
assert(rejected.allOtherSemanticsPassed && rejected.allOtherChecksPassed)
assert.equal(rejected.usefulHandoffSha256, handoff)
assert.equal(rejected.fullDiffSha256, rejectedDiff)
assert(rejected.remediationReferenceAuthorized)
assert(!rejected.fullDiffMaterializationAuthorized && !rejected.cleanRewriteAuthorized)

assert(exact(index.producerOwnedPaths, ownedPaths))
assert(exact(index.incrementalEditPolicy.semanticRemediationPaths, semanticPaths))
assert(exact(index.incrementalEditPolicy.compileCoherenceExceptionPaths, coherencePaths))
assert(index.incrementalEditPolicy.compileCoherenceExceptionRequiresProof)
assert(index.incrementalEditPolicy.freshMergeConflictResolutionRequiredForAllOwnedPaths)
assert(!index.incrementalEditPolicy.cleanRewriteAuthorized)
assert(!index.incrementalEditPolicy.rejectedFivePathDiffMaterializationAuthorized)
assert(exact(index.workerMandatoryDocs, mandatoryDocs))
assert.equal(index.strictRequiredChecks.length, 7)

for (const policy of [index.workerExecutionPolicy, index.reviewerExecutionPolicy]) {
  for (const key of ['network', 'fetch', 'appRuntimeOrTeamLaunch', 'realProjectAccess', 'stage', 'merge', 'commit', 'push']) {
    assert.equal(policy[key], false, `worker policy enabled ${key}`)
  }
}

const semantic = index.semanticAcceptance
assert.equal(semantic.implementationTopology, 'fresh-true-two-parent-merge')
assert.equal(semantic.targetSideBaseSha, target)
assert.equal(semantic.pinnedCurrentRealBaseSha, source)
assert(semantic.preserveAllOtherR3Semantics)
assert(!semantic.cleanRewriteAuthorized && !semantic.rejectedFullDiffMaterializationAuthorized)
assert(!semantic.provenanceRequirementAuthorized)
assert(!semantic.facadeDestinationReconcile.required && semantic.facadeDestinationReconcile.useWhenAvailable)
assert.equal(semantic.facadeDestinationReconcile.fallbackWhenUnavailable, 'findById-plus-target-safe-subject-payload-validation')
assert(!semantic.facadeDestinationReconcile.sameIdAloneMayProveSuccess)
const matching = semantic.assertMatchingTaskPolicy
assert(matching.passRequestedPayloadAtEveryFallbackSuccessSite)
assert.equal(matching.subjectComparison, 'task.subject===payload.subject.trim()')
assert.equal(matching.mismatchError, 'TaskBoardCreateDestinationConflictError')
assert.equal(matching.mismatchFailureKind, 'Terminal')
assert(!matching.compareOrRequireCreationCommand && !matching.compareCreatedBy && !matching.compareRelations)
assert(exact(semantic.taskBoardE2ECoverage, {
  retainedTargetCases: 4,
  portedSourceCases: 5,
  addedRegressionCount: 1,
  requiredTotalCases: 10,
  unrelatedSameIdSubject: 'UNRELATED SUBJECT',
  unrelatedSameIdHasReconcile: false,
  unrelatedSameIdHasCreationCommand: false,
  unrelatedSameIdNeverSuccessTerminal: true,
}))

const producer = index.projectScopedProducerAdmission
assert.equal(producer.producerCount, 1)
assert.equal(producer.mode, 'serial-builtin')
assert.equal(producer.model, 'gpt-5.6-sol')
assert.equal(producer.reasoningEffort, 'xhigh')
assert.equal(producer.serviceTier, 'fast')
assert.equal(producer.remediationInput.inputPatchHash, handoff)
assert.equal(producer.remediationInput.rejectedFullDiffSha256, rejectedDiff)
assert.equal(producer.remediationInput.fullDiffUse, 'review-provenance-and-reference-only')
assert(!producer.remediationInput.materializeRejectedFullDiff && !producer.remediationInput.cleanRewriteAuthorized)
assert(exact(producer.orchestrationLaunchTemplate.mergeSourceMetadata, index.currentRoute.mergeSource))
assert(exact(producer.orchestrationLaunchTemplate.requestEnvelope, {
  operation: 'codex_goal_project_refill_worker', workerRole: 'producer', model: 'gpt-5.6-sol',
  reasoningEffort: 'xhigh', serviceTier: 'fast', serial: true,
}))
assert(producer.producerSelfReviewRequired && producer.producerTerminalState === 'HOLD')
assert(!producer.producerLaunchesReviewer)

const storedTarget = crypto.createHash('sha1').update(`${revision}:shape`).digest('hex')
const producerContract = render(producer.orchestrationLaunchTemplate.contractRenderer, {
  [targetBinding]: storedTarget,
})
validateContract(producerContract, { label: 'producer', storedTarget, input: handoff, kind: 'implementation' })

const review = index.integrationReviewAdmission
assert.equal(review.reviewerCount, 1)
assert(review.freshIndependentReviewerRequired)
assert.equal(review.model, 'gpt-5.6-sol')
assert.equal(review.reasoningEffort, 'xhigh')
assert.equal(review.serviceTier, 'fast')
assert(!review.repositoryWriterAuthority && !review.repairAuthority && !review.canonicalReresolutionAuthorized)
assert(exact(review.acceptFindingCounts, { P0: 0, P1: 0, P2: 0 }))
const outputHash = crypto.createHash('sha256').update(`${revision}:producer-output-shape`).digest('hex')
const reviewerContract = render(review.strictContractRenderer, {
  [targetBinding]: storedTarget,
  [outputBinding]: outputHash,
})
validateContract(reviewerContract, { label: 'reviewer', storedTarget, input: outputHash, kind: 'review' })

const protocol = index.reviewedIntegrationProtocol
assert.equal(protocol.mode, 'ordered-true-merge')
assert(exact(protocol.mergeSource, index.currentRoute.mergeSource))
assert(protocol.preIntegrationRemoteHeadVerification.required)
assert.equal(protocol.preIntegrationRemoteHeadVerification.expectedCommit, source)
assert.equal(protocol.preIntegrationRemoteHeadVerification.movedHeadDisposition, 'HOLD-and-require-new-base-review')
assert(!protocol.preIntegrationRemoteHeadVerification.silentRebindingAuthorized)
assert(protocol.runtimeCreatesTrueMerge)
assert(exact(protocol.requiredParentOrder, [{ binding: targetBinding }, source]))
assert(protocol.runtimeValidatesExactConflictSet)
assert(protocol.runtimeMaterializesPinnedSourceNonConflicts)
assert(protocol.runtimeAppliesAcceptedFivePathOutput)
assert(protocol.runtimeRerunsAllRequiredChecks)
assert(exact(protocol.postSourceMaterializationRequiredChecks, [
  'pnpm exec vitest run test/renderer/utils/createTaskCommandIdentity.test.ts',
]))
assert(protocol.conventionalMergeCommitRequired && protocol.pushRequiredBeforeAdvance)

assert(exact(index.authorization.authorizedNow, []))
assert.equal(index.authorization.producerCount, 1)
assert.equal(index.authorization.reviewerCount, 1)
for (const key of ['controllerReplacementAuthorized', 'workerMergeAuthorized', 'workerCommitAuthorized', 'workerPushAuthorized', 'docsJobLaunchPerformed', 'docsJobFetchAuthorized', 'docsJobStageAuthorized', 'docsJobCommitAuthorized', 'docsJobMergeAuthorized', 'docsJobPushAuthorized']) {
  assert.equal(index.authorization[key], false, `authorization enabled ${key}`)
}
assert(exact(index.authorization.blockedUntilValidatedOrderedMergePushed, ['P1.R2', 'P1.I', 'P1.F', 'Phase 2+']))
assert(exact(index.routerExclusiveOwnership, routerPaths))

for (const packet of [index.packetHashes.controllerPacket, index.packetHashes.lanePacket]) {
  assert(/^[a-f0-9]{64}$/.test(packet.sha256), `invalid packet hash ${packet.path}`)
  const actual = crypto.createHash('sha256').update(fs.readFileSync(packet.path)).digest('hex')
  assert.equal(actual, packet.sha256, `packet hash drift ${packet.path}`)
}
for (const routerPath of routerPaths.filter((value) => value.endsWith('.md'))) {
  const text = fs.readFileSync(routerPath, 'utf8')
  assert(text.includes(revision), `missing revision ${routerPath}`)
  for (const match of text.matchAll(/\]\(([^)]+)\)/g)) {
    const targetPath = match[1].replace(/^<|>$/g, '').split('#')[0]
    if (!targetPath || /^[a-z]+:/i.test(targetPath)) continue
    assert(fs.existsSync(path.resolve(path.dirname(routerPath), targetPath)), `broken link ${targetPath}`)
  }
}
console.log('task-provenance-remediation-router-r1: ok')
NODE
pnpm exec prettier --check docs/hosted-web-phases/START_HERE.md docs/hosted-web-phases/README.md docs/hosted-web-phases/EXECUTION_INDEX.json docs/hosted-web-phases/phase-01/README.md docs/hosted-web-phases/phase-01/controller-packet.md docs/hosted-web-phases/phase-01/execution-dag.md docs/hosted-web-phases/phase-01/lanes/pr252-base-conflict-resolution.md
git diff --check
git diff --cached --quiet
git status --short
```

Also prove `HEAD == 3256ee3b5b8e81b144aa0a14eac1bca080c9b779`; the two relevant ancestors lead
to `e9ffa30c...`; the fresh merge-tree conflict set equals the five owned paths; the worktree diff
contains exactly the seven ordered router paths; all seven are textual and JSON-valid; every link
exists; packet hashes match; conflict-marker scans are empty; and exact-scope secret/provider and
private-path scans contain no unsafe or unclassified value. Controlled sandbox roots and the fixed
forbidden-real-project sentinel are policy data and are never accessed by this docs job.

## Stop and HOLD

Stop on rejection-hash drift, rejected-diff materialization, clean rewrite, stale/changed source,
wrong merge parents, wrong conflict set, target re-resolution, controller replacement/restart, root
role drift, second worker, wrong model/effort/tier, unsupported machine field, extra path, same-ID false
success, provenance requirement, wrong E2E count, native diagnostic drift, unsafe/binary content,
failed gate, non-independent review, nonzero accepted finding, final source-test failure, or
integration/push failure.

This docs author does not launch a producer, reviewer, or integration attempt and performs no fetch,
stage, commit, merge, push, or lifecycle operation. End `HOLD`.
