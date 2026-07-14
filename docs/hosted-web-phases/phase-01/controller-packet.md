# Phase 1 controller packet: PR #252 task-provenance remediation router r2

## Status and authority

- Root role: orchestrator only
- Durable controller: `controller-v17`, exactly `live=true`; no replacement or restart
- Admission/integration owner: `ProjectScopedControl`
- Producer continuation: existing `codex_goal_project_start` for the exact r3 job
- Reviewer start: `codex_goal_project_prepare_verifier`, `workerRole: reviewer`, strict
  `reviewKind: review`
- Current node: `PR252-task-provenance-remediation`
- Revision: `phase-01-pr252-task-provenance-remediation-router-r2`
- Accepted and pushed predecessor router:
  `f5e3ce8257d05c6ff2a5c19e944d75999868550d`
- Continued workspace base and intentional `HEAD`:
  `3256ee3b5b8e81b144aa0a14eac1bca080c9b779`
- Pinned current real base/merge source:
  `origin/refactor/team-provisioning-round2-reapply@e9ffa30cc016ad3cb833fcc0a138fa4f026eb850`
- Conditional capacity: one same-job reviewed-dirty r3 continuation, then one fresh independent
  reviewer
- Existing r3 profile: `gpt-5.6-sol`, `xhigh`, `serviceTier: "fast"`
- This docs job launches none and ends `HOLD`

Product-worker capacity is zero until this exact seven-path r2 router receives independent `ACCEPT`,
is integrated, and is pushed. P1.R2, P1.I, P1.F, and Phase 2+ remain blocked until the validated
ordered merge is pushed.

## Rejection and reviewed workspace identity

Independent reviewer r4 returned `FORMAL REJECT` for producer r3 with P0/P1/P2 `0/1/0`. The sole P1
proved that, when destination `reconcile` and task `creationCommand` were absent,
`TaskBoardCommandFacade.findById` accepted an unrelated same-ID task with subject
`UNRELATED SUBJECT` and returned outcome `Executed`. Every other r3 semantic and check passed.

The rejected `ReviewedWorkerOutput` is exactly:

| Field         | Required value                                                                                  |
| ------------- | ----------------------------------------------------------------------------------------------- |
| Output ID     | `1796cc59fb1a6c291c54a589ef8a0e10d694b8c61128a5486e5307831afaee9b`                              |
| Decision      | `rejected`                                                                                      |
| Worker job    | `agent-teams-hosted-web-refactor-pr252-semantic-conflict-resolution-v17-r3`                     |
| Task          | `agent-teams-hosted-web-refactor-pr252-semantic-conflict-resolution-v17-r3`                     |
| Workspace     | `/var/data/agent-teams-hosted-web-refactor/worktrees/pr252-semantic-conflict-resolution-v17-r3` |
| Base and HEAD | `3256ee3b5b8e81b144aa0a14eac1bca080c9b779`                                                      |
| Raw patch     | `f810a0aa191e82316737c5c0069ee6225597d8a477d77b50c57bc3fd931fe579`                              |
| Changed paths | the exact ordered five-path list below                                                          |

The complete rejected five-path diff hash
`cb534246905f6fd7cc03b0b761018157ed12d204d11819f0978915af7c778491` remains provenance-only.
It is not a patch carrier and is never replayed, applied, materialized, or integrated. The raw
`f810a0aa...` patch already exists in the exact r3 workspace; the continuation preserves it in place.

## Corrected base authority and conflict route

Direct `git ls-remote origin refs/heads/refactor/team-provisioning-round2-reapply` returned
`e9ffa30cc016ad3cb833fcc0a138fa4f026eb850`. That commit remains the current real base, active merge
source, and required second parent.

The GitHub PR `baseOid` `d2585e7634800eb795644c4b6d0e8baf5f81c98f` is stale and 52 commits
behind `e9ffa30c...`. Former source `7afc908ce92f14b4b0ebd06cc4aa3a4cf33807d0` is also an
ancestor of `e9ffa30c...`; neither stale identity has current routing authority. Fresh merge-tree
proof between `3256ee3b...` and `e9ffa30c...` reports exactly the five conflicts below.

This r2 correction changes no merge semantics. The final broker still creates the true two-parent
merge with ordered parents, materializes pinned-source non-conflicts, and runs the source-only
command-identity test. The correction is solely that remediation continues the already reviewed r3
job/workspace rather than creating a fresh producer/worktree.

## Stored router authority without moving r3 HEAD

After r2 acceptance/integration/push, `ProjectScopedControl` resolves that pushed full SHA exactly
once as `storedRouterCommit`. It binds the continuation directive, fresh reviewer, `mark_reviewed`,
integration target, and true merge's first parent. It is never re-resolved.

`storedRouterCommit` is not the continued workspace base or `HEAD`. The r3 workspace intentionally
remains at `3256ee3b...` so its exact dirty patch remains intact. The continued worker obtains current
authority only by running `git show <storedRouterCommit>:<path>` for every mandatory authority path.
It may not fetch, checkout, reset, rebase, or otherwise move `HEAD` to read r2.

## Exact same-job continuation request

Immediately before start, `ProjectScopedControl` must prove all of the following in one snapshot:

1. The accepted pushed predecessor is `f5e3ce825...`, r2 is accepted/integrated/pushed, and
   `storedRouterCommit` was resolved once.
2. The named r3 job and task already exist, refer to the exact workspace, are not active, and no
   continuation is already in flight.
3. Reviewed output `1796cc59...` still exists, has `decision=rejected`, and matches worker, task,
   workspace, base, patch, and five paths exactly.
4. The workspace exists with `HEAD=3256ee3b...`, an empty index, exactly five unstaged tracked paths,
   no untracked path, and `git diff` SHA-256 `f810a0aa...`.
5. The pinned source and exact five-conflict proof still match.

Any mismatch ends `HOLD` without a start. If every check passes, invoke existing
`codex_goal_project_start` exactly once with the project-scoped controller/registry/cwd and this
payload:

```json
{
  "jobId": "agent-teams-hosted-web-refactor-pr252-semantic-conflict-resolution-v17-r3",
  "reviewedOutputId": "1796cc59fb1a6c291c54a589ef8a0e10d694b8c61128a5486e5307831afaee9b",
  "forceStart": true,
  "confirmStart": true,
  "dependencyBootstrap": "install",
  "confirmDependencyBootstrap": true
}
```

This is a reviewed-dirty SAME-JOB continuation. It is not `codex_goal_project_refill_worker`. A new
job, task, prompt-owned workspace, worktree, refill, duplicate start, or parallel producer is not
authorized. `worker_already_running` or any reviewed-output/job mismatch fails closed.

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

## Exact five-path reviewed workspace

1. `src/features/task-board-commands/core/application/TaskBoardCommandFacade.ts`
2. `src/main/services/team/TeamDataService.ts`
3. `src/renderer/components/team/TeamDetailView.tsx`
4. `test/features/task-board-commands/TaskBoardCommands.e2e.test.ts`
5. `test/main/services/team/TeamDataService.test.ts`

The existing patch in all five paths is preserved. New bytes are authorized only in paths 1 and 4:
the P1 subject-safety fix and its exact tenth E2E regression. Paths 2, 3, and 5 remain byte-identical
to their `f810a0aa...` patch sections. Existing unrelated hunks in paths 1 and 4 also remain intact.
There is no compile-coherence exception and no sixth path.

## Semantic acceptance

1. Continue the exact reviewed-dirty r3 workspace; do not materialize another merge, replay either
   rejected artifact, or copy a complete source blob.
2. Preserve all r3 semantics that passed r4: partial-create recovery, stale-command recovery,
   idempotent retry identity, JSON validation, the `TeamDataService` reconciliation capability, the
   `TeamDetailView` dual-signature adapter, and relation normalization.
3. Keep destination `reconcile` optional and use it when available. Its absence does not disable
   durable creation or make an unknown outcome successful.
4. At every `findById` fallback success site, pass the requested payload and validate that the found
   task subject equals the requested string subject after trimming. Same ID alone never proves
   success.
5. Do not require or compare `creationCommand`, `createdBy`, or relations as provenance.
6. An unrelated same-ID result throws `TaskBoardCreateDestinationConflictError`, is terminal, and
   can never become `Executed`, `Retried`, `Reconciled`, `Replayed`, or another success.
7. Retain the existing nine E2E cases and add one exact tenth regression with subject
   `UNRELATED SUBJECT`, no `reconcile`, and no `creationCommand`.
8. Keep the index empty and leave no duplicate implementation, unreachable shim, source-only
   mismatch, conflict marker, or widened writer scope.

## Continued worker and reviewer gates

Run independently after continuation and in the fresh review materialization:

```bash
git diff --cached --quiet
pnpm exec vitest run test/features/task-board-commands/TaskBoardCommands.e2e.test.ts
pnpm exec vitest run test/main/services/team/TeamDataService.test.ts
node scripts/hosted-web/phase-0/final-gate/normalize-typescript-diagnostics.mjs --mode milestone
pnpm lint:fast:files -- src/features/task-board-commands/core/application/TaskBoardCommandFacade.ts src/main/services/team/TeamDataService.ts src/renderer/components/team/TeamDetailView.tsx test/features/task-board-commands/TaskBoardCommands.e2e.test.ts test/main/services/team/TeamDataService.test.ts
pnpm exec prettier --check src/features/task-board-commands/core/application/TaskBoardCommandFacade.ts src/main/services/team/TeamDataService.ts src/renderer/components/team/TeamDetailView.tsx test/features/task-board-commands/TaskBoardCommands.e2e.test.ts test/main/services/team/TeamDataService.test.ts
git diff --check
```

The focused suites include exactly ten TaskBoard E2E cases. Native TypeScript classification is green
only with the inherited seven Phase 0 diagnostics:

- `auth-artifacts-spike.test.ts`: TS7016 at 25:8; TS7031 at 66:31; TS18046 at 117:68; TS7031 at
  413:48; TS7031 at 733:10;
- `evidence-scanner.test.ts`: TS7016 at 12:8; and
- `scan-runtime-surfaces.test.ts`: TS2352 at 162:44.

Any added, removed, moved, or changed diagnostic fails.

Also prove the reviewed-output binding, original snapshot, preserved patch sections, exact five-path
scope, pinned merge-tree identity, unrelated-same-ID terminal never-success result, and classified
conflict-marker, secret/auth/provider, private/user/real-project-path, and textual/non-binary scans.
The worker self-reviews with P0/P1/P2 counts, emits one immutable output, and returns `HOLD`. It does
not start the reviewer or authorize integration.

## Independent review and ordered broker integration

After r3 `HOLD`, `ProjectScopedControl` invokes `codex_goal_project_prepare_verifier` exactly once.
The reviewer is fresh and independent of the router author, continued r3 worker, r4, rejected earlier
PR252 workers, and prior accepted workers. It uses `gpt-5.6-sol`, `xhigh`, `serviceTier: "fast"`, no
machine `fastMode`, no writer/repair/refill authority, stored r2 authority, base `3256ee3b...`, pinned
source, and the SHA-256 of the sole immutable continued output. It reruns every gate and returns
explicit `ACCEPT` or `REJECT`; acceptance requires P0/P1/P2 `0/0/0`.

The reviewer renderer in `EXECUTION_INDEX.json` retains the exact 18-key strict worker-launch shape.
It binds `canonicalSha` and `phaseStartSha` to `storedRouterCommit`, keeps `baseSha=3256ee3b...`,
binds `inputPatchHash` to the immutable continued output, copies the exact five paths and seven
structured checks, and uses no-write execution policy. A placeholder, missing/extra key, stale
target, wrong hash, or nonconcrete binding fails closed.

Immediately before integration, `ProjectScopedControl` reruns exactly:

```bash
git ls-remote origin refs/heads/refactor/team-provisioning-round2-reapply
```

The single branch head must remain `e9ffa30cc016ad3cb833fcc0a138fa4f026eb850`. If it moved, end
`HOLD` and require a new-base review; do not silently rebind or fetch a substitute.

With unchanged source and reviewer `ACCEPT`, the broker creates a true merge with ordered parents
`[storedRouterCommit, e9ffa30cc016ad3cb833fcc0a138fa4f026eb850]`. It proves exactly five
conflicts, materializes all pinned-source non-conflicts, applies only the accepted five-path output,
reruns every gate, and then requires green:

```bash
pnpm exec vitest run test/renderer/utils/createTaskCommandIdentity.test.ts
```

Only then may it create a conventional merge commit and push. A moved source, one-parent, squash,
patch-only, reversed-parent, extra-conflict, clean rewrite, rejected-patch replay, whole-blob copy,
placeholder, or gate-failing result is rejected and not pushed.

## Exact docs-router checks

Run from the repository root with `PATH=/usr/local/bin:/usr/bin:/bin:$PATH`:

```bash
node <<'NODE'
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

const predecessor = 'f5e3ce8257d05c6ff2a5c19e944d75999868550d'
const base = '3256ee3b5b8e81b144aa0a14eac1bca080c9b779'
const source = 'e9ffa30cc016ad3cb833fcc0a138fa4f026eb850'
const reviewedOutput = '1796cc59fb1a6c291c54a589ef8a0e10d694b8c61128a5486e5307831afaee9b'
const patch = 'f810a0aa191e82316737c5c0069ee6225597d8a477d77b50c57bc3fd931fe579'
const rejectedDiff = 'cb534246905f6fd7cc03b0b761018157ed12d204d11819f0978915af7c778491'
const revision = 'phase-01-pr252-task-provenance-remediation-router-r2'
const job = 'agent-teams-hosted-web-refactor-pr252-semantic-conflict-resolution-v17-r3'
const workspace = '/var/data/agent-teams-hosted-web-refactor/worktrees/pr252-semantic-conflict-resolution-v17-r3'
const reviewedManifestPath = `/var/data/agent-teams-hosted-web-refactor/worker-jobs/reviewed-worker-outputs/${reviewedOutput}/manifest.json`
const jobManifestPath = `/var/data/agent-teams-hosted-web-refactor/worker-jobs/registry-v17/${job}/job.json`
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

assert.equal(index.currentRouterRevision, revision)
assert.equal(index.currentRouterTerminalState, 'HOLD')
assert(!hasKey(index, 'fastMode'), 'unsupported fastMode key present')
assert.equal(index.acceptedPushedPredecessorRouter.commit, predecessor)
assert(index.acceptedPushedPredecessorRouter.accepted)
assert(index.acceptedPushedPredecessorRouter.integrated)
assert(index.acceptedPushedPredecessorRouter.pushed)
assert.equal(index.continuedWorkspaceSnapshot.baseSha, base)
assert.equal(index.continuedWorkspaceSnapshot.headSha, base)
assert.equal(index.continuedWorkspaceSnapshot.patchSha256, patch)
assert(index.continuedWorkspaceSnapshot.indexEmpty)
assert(exact(index.continuedWorkspaceSnapshot.changedPaths, ownedPaths))

const rejected = index.rejectedReviewedWorkerOutput
assert.equal(rejected.reviewedOutputId, reviewedOutput)
assert.equal(rejected.decision, 'rejected')
assert.equal(rejected.workerJobId, job)
assert.equal(rejected.taskId, job)
assert.equal(rejected.workspacePath, workspace)
assert.equal(rejected.baseCommit, base)
assert.equal(rejected.patchSha256, patch)
assert.equal(rejected.fullDiffSha256, rejectedDiff)
assert(exact(rejected.changedFiles, ownedPaths))
assert.equal(rejected.fullDiffUse, 'provenance-only')
assert(!rejected.replayAuthorized && !rejected.directIntegrationAuthorized)

const manifest = JSON.parse(fs.readFileSync(reviewedManifestPath, 'utf8'))
assert.equal(manifest.reviewedOutputId, reviewedOutput)
assert.equal(manifest.workerJobId, job)
assert.equal(manifest.taskId, job)
assert.equal(manifest.sourceWorkspacePath, workspace)
assert.equal(manifest.baseCommit, base)
assert.equal(manifest.patchSha256, patch)
assert.equal(manifest.patchByteLength, 35569)
assert.equal(crypto.createHash('sha256').update(fs.readFileSync(manifest.patchPath)).digest('hex'), patch)
assert.equal(manifest.reviewDecision.decision, 'rejected')
assert(exact(manifest.changedFiles, ownedPaths))

const jobManifest = JSON.parse(fs.readFileSync(jobManifestPath, 'utf8'))
assert.equal(jobManifest.jobId, job)
assert.equal(jobManifest.taskId, job)
assert.equal(jobManifest.workspacePath, workspace)
assert.equal(jobManifest.model, 'gpt-5.6-sol')
assert.equal(jobManifest.reasoningEffort, 'xhigh')
assert.equal(jobManifest.serviceTier, 'fast')

const admission = index.projectScopedContinuationAdmission
assert.equal(admission.operation, 'codex_goal_project_start')
assert.equal(admission.continuationCount, 1)
assert(admission.sameJobRequired && admission.reviewedDirtyRequired)
assert(!admission.newJobAuthorized && !admission.newWorktreeAuthorized && !admission.duplicateAuthorized)
assert(exact(admission.requestEnvelope, {
  controllerJobId: 'agent-teams-hosted-web-refactor-controller-v17',
  registryRootDir: '/var/data/agent-teams-hosted-web-refactor/worker-jobs/registry-v17',
  cwd: '/var/data/agent-teams-hosted-web-refactor/worktrees/integration-hosted-web-feature-boundaries',
  jobId: job,
  reviewedOutputId: reviewedOutput,
  forceStart: true,
  confirmStart: true,
  dependencyBootstrap: 'install',
  confirmDependencyBootstrap: true,
}))
assert(admission.preStartSnapshotVerification.required)
assert(admission.preStartSnapshotVerification.failClosedOnAnyDrift)
assert.equal(admission.authorityRead.commandTemplate, 'git show <storedRouterCommit>:<path>')
assert(admission.authorityRead.workspaceHeadMustRemainUnchanged)

assert(exact(index.producerOwnedPaths, ownedPaths))
assert(exact(index.continuationEditPolicy.onlyNewBytePaths, [ownedPaths[0], ownedPaths[3]]))
assert(exact(index.continuationEditPolicy.unchangedPatchPaths, [ownedPaths[1], ownedPaths[2], ownedPaths[4]]))
assert(index.continuationEditPolicy.preserveExistingFivePathPatch)
assert(!index.continuationEditPolicy.compileCoherenceExceptionAuthorized)
for (const key of ['fetch', 'checkout', 'reset', 'rebase', 'clean', 'stage', 'merge', 'commit', 'push']) {
  assert.equal(index.workerExecutionPolicy[key], false, `worker policy enabled ${key}`)
}

const semantic = index.semanticAcceptance
assert.equal(semantic.implementationTopology, 'same-job-reviewed-dirty-continuation')
assert(semantic.preserveAllOtherR3Semantics)
assert(!semantic.cleanRewriteAuthorized && !semantic.rejectedPatchReplayAuthorized)
assert(!semantic.provenanceRequirementAuthorized)
assert.equal(semantic.assertMatchingTaskPolicy.subjectComparison, 'task.subject===payload.subject.trim()')
assert.equal(semantic.assertMatchingTaskPolicy.mismatchError, 'TaskBoardCreateDestinationConflictError')
assert(exact(semantic.taskBoardE2ECoverage, {
  retainedExistingCases: 9,
  addedRegressionCount: 1,
  requiredTotalCases: 10,
  unrelatedSameIdSubject: 'UNRELATED SUBJECT',
  unrelatedSameIdHasReconcile: false,
  unrelatedSameIdHasCreationCommand: false,
  unrelatedSameIdNeverSuccessTerminal: true,
}))

const review = index.integrationReviewAdmission
assert.equal(review.reviewerCount, 1)
assert(review.freshIndependentReviewerRequired)
assert(exact(review.acceptFindingCounts, { P0: 0, P1: 0, P2: 0 }))
const contractKeys = [
  'kind', 'format', 'canonicalSha', 'baseSha', 'phaseStartSha', 'packetRevision',
  'controllerPacket', 'lanePacket', 'phaseId', 'laneId', 'inputPatchHash', 'reviewKind',
  'ownedPaths', 'mandatoryDocs', 'mandatoryScripts', 'mandatoryFixtures', 'requiredChecks',
  'executionPolicy',
]
const storedRouter = crypto.createHash('sha1').update(`${revision}:stored-router`).digest('hex')
const outputHash = crypto.createHash('sha256').update(`${revision}:continued-output`).digest('hex')
const reviewerContract = render(review.strictContractRenderer, {
  storedRouterCommit: storedRouter,
  immutableContinuedOutputPatchHash: outputHash,
})
assert(exact(Object.keys(reviewerContract), contractKeys))
assert.equal(reviewerContract.kind, 'worker-launch')
assert.equal(reviewerContract.format, 1)
assert.equal(reviewerContract.canonicalSha, storedRouter)
assert.equal(reviewerContract.baseSha, base)
assert.equal(reviewerContract.phaseStartSha, storedRouter)
assert.equal(reviewerContract.packetRevision, revision)
assert.equal(reviewerContract.inputPatchHash, outputHash)
assert.equal(reviewerContract.reviewKind, 'review')
assert(exact(reviewerContract.ownedPaths, ownedPaths))
assert(exact(reviewerContract.mandatoryDocs, index.workerMandatoryDocs))
assert(exact(reviewerContract.requiredChecks, index.strictRequiredChecks))
assert(exact(reviewerContract.executionPolicy, index.reviewerStrictExecutionPolicy))
const protocol = index.reviewedIntegrationProtocol
assert.equal(protocol.mode, 'ordered-true-merge')
assert(exact(protocol.requiredParentOrder, [{ binding: 'storedRouterCommit' }, source]))
assert.equal(protocol.preIntegrationRemoteHeadVerification.expectedCommit, source)
assert(protocol.runtimeMaterializesPinnedSourceNonConflicts)
assert(protocol.runtimeAppliesAcceptedFivePathOutput)
assert(protocol.conventionalMergeCommitRequired && protocol.pushRequiredBeforeAdvance)

assert(exact(index.authorization.authorizedNow, []))
assert.equal(index.authorization.sameJobContinuationCount, 1)
assert.equal(index.authorization.reviewerCount, 1)
assert(exact(index.authorization.blockedUntilValidatedOrderedMergePushed, ['P1.R2', 'P1.I', 'P1.F', 'Phase 2+']))
assert(exact(index.routerExclusiveOwnership, routerPaths))

for (const packet of [index.packetHashes.controllerPacket, index.packetHashes.lanePacket]) {
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

console.log('task-provenance-remediation-router-r2: ok')
NODE
r3=/var/data/agent-teams-hosted-web-refactor/worktrees/pr252-semantic-conflict-resolution-v17-r3
if tmux has-session -t agent-teams-hosted-web-refactor-pr252-semantic-conflict-resolution-v17-r3 2>/dev/null; then
  exit 1
fi
test "$(git rev-parse HEAD)" = f5e3ce8257d05c6ff2a5c19e944d75999868550d
test "$(git -C "$r3" rev-parse HEAD)" = 3256ee3b5b8e81b144aa0a14eac1bca080c9b779
git -C "$r3" diff --cached --quiet
test -z "$(git -C "$r3" ls-files --others --exclude-standard)"
actual_paths=$(git -C "$r3" diff --name-only)
expected_paths=$(printf '%s\n' \
  src/features/task-board-commands/core/application/TaskBoardCommandFacade.ts \
  src/main/services/team/TeamDataService.ts \
  src/renderer/components/team/TeamDetailView.tsx \
  test/features/task-board-commands/TaskBoardCommands.e2e.test.ts \
  test/main/services/team/TeamDataService.test.ts)
test "$actual_paths" = "$expected_paths"
actual_patch=$(git -C "$r3" diff | sha256sum)
test "${actual_patch%% *}" = f810a0aa191e82316737c5c0069ee6225597d8a477d77b50c57bc3fd931fe579
pnpm exec prettier --check docs/hosted-web-phases/START_HERE.md docs/hosted-web-phases/README.md docs/hosted-web-phases/EXECUTION_INDEX.json docs/hosted-web-phases/phase-01/README.md docs/hosted-web-phases/phase-01/controller-packet.md docs/hosted-web-phases/phase-01/execution-dag.md docs/hosted-web-phases/phase-01/lanes/pr252-base-conflict-resolution.md
git diff --check
git diff --cached --quiet
git status --short
```

Also require the worktree diff to contain exactly the seven ordered router paths; all seven must be
textual and JSON-valid, links and packet hashes must match, conflict-marker scans must be empty, and
exact-scope secret/provider/private-path scans must contain no unsafe or unclassified value.

## Stop and HOLD

Stop on predecessor/router authority drift, reviewed-output decision or identity drift, wrong r3
job/task/workspace, base/`HEAD` or patch drift, a nonempty index, new/untracked path, source drift,
wrong conflict set, a refill/new job/new worktree/duplicate, fetch/checkout/reset/rebase/clean/replay,
extra semantic edit, wrong E2E count, native diagnostic drift, non-independent review, nonzero accepted
finding, final source-test failure, or integration/push failure.

This docs author does not launch the continuation, reviewer, or integration attempt and performs no
fetch, lifecycle action, stage, commit, merge, or push. End `HOLD`.
