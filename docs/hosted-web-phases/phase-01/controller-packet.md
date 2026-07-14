# Phase 1 controller packet: PR #252 five-file base-conflict resolution r2

## Status and authority

- Durable controller: `controller-v17`; replacement or restart is not authorized
- Required controller state: exactly `live=true`
- Current node: `PR252-base-conflict-resolution`
- Mode/revision: base-conflict resolution / `phase-01-pr252-base-conflict-resolution-r2`
- Expected target/base/phase start/plan bundle:
  `e7e7e734c82c49105682e7a19bbedafa1f5ddbad`
- Source: `origin/refactor/team-provisioning-round2-reapply` pinned to
  `7afc908ce92f14b4b0ebd06cc4aa3a4cf33807d0`
- Capacity: exactly one `xhigh`/`default` producer, then exactly one fresh independent
  `xhigh`/`default` integration reviewer; Fast disabled for both
- This docs job launches none and ends `HOLD`

The prior r1 worker is terminal `failed_no_output` and authored nothing. This r2 route is the only
authorized replacement. `controller-v17` must never inspect, resume, or reuse r1 or adopt any r1
state/output.

## Binding P1.1D gate

P1.1D has independent `FORMAL ACCEPT` with P0/P1/P2 `0/0/0` by
`agent-teams-hosted-web-refactor-p1-1d-shadowed-map-review-v17-r4`.

| Field                  | Binding value                                                      |
| ---------------------- | ------------------------------------------------------------------ |
| Strict result SHA-256  | `be0c9abd679f817c386d1d06d1b738c2a1505bb3c4718279129ab74842c98fa6` |
| Reviewed output ID     | `f3394026185348c84673d44a9b30a82667c3ff9435b5d4d7609c04785c274f41` |
| Accepted integration   | `p1-1d-shadowed-map-r4-accepted-integration-v3`                    |
| Accepted/pushed commit | `e7e7e734c82c49105682e7a19bbedafa1f5ddbad`                         |

These four values are accepted immutable provenance. A stale result, nonzero finding count, unpushed
target, changed target, or attempt to rerun/reinterpret P1.1D fails closed.

## Outcome

Produce and independently review one immutable resolution patch that changes exactly the five packet
paths byte-for-byte to their audited blobs at the pinned source commit. After review `ACCEPT`, bind the
reviewed output to the exact merge identity and let the integration runtime create and validate the
true two-parent merge. The producer/reviewer never stage, merge, commit, or push.

## Launch gate and producer admission

Producer capacity is zero until this exact seven-path docs router is policy-integrated, the same
`controller-v17` reports exactly `live=true`, the accepted P1.1D facts above are verified, the
target/source pins and five source blobs are materialized, no prior conflict worker is active, and r1
is confirmed terminal `failed_no_output` without reading or reusing it. This docs transition does not
attest that those runtime gates are already true.

The existing ProjectScopedControl operation admits exactly one producer:

```text
operation: codex_goal_project_refill_worker
workerRole: producer
reasoningEffort: xhigh
serviceTier: default
fastMode: false
preStartAdmission.mode: serial-builtin
preStartAdmission.contract.kind: worker-launch
preStartAdmission.contract.format: 1
preStartAdmission.contract.canonicalSha: e7e7e734c82c49105682e7a19bbedafa1f5ddbad
preStartAdmission.contract.baseSha: e7e7e734c82c49105682e7a19bbedafa1f5ddbad
preStartAdmission.contract.phaseStartSha: e7e7e734c82c49105682e7a19bbedafa1f5ddbad
preStartAdmission.contract.packetRevision: phase-01-pr252-base-conflict-resolution-r2
preStartAdmission.contract.controllerPacket: docs/hosted-web-phases/phase-01/controller-packet.md
preStartAdmission.contract.lanePacket: docs/hosted-web-phases/phase-01/lanes/pr252-base-conflict-resolution.md
preStartAdmission.contract.phaseId: phase-01
preStartAdmission.contract.laneId: pr252-base-conflict-resolution
preStartAdmission.contract.reviewKind: implementation
```

There is no preexisting patch input, so the source commit must not be mislabeled as
`inputPatchHash`. The controller supplies the stable contract's exact `ownedPaths`, `mandatoryDocs`,
empty `mandatoryScripts`/`mandatoryFixtures`, non-empty `requiredChecks`, and sandbox-only
`executionPolicy` from the lane packet. It separately binds `planBundleCommit` to
`e7e7e734c82c49105682e7a19bbedafa1f5ddbad` and source identity to the remote/branch/pinned commit
above. It does not invent unsupported contract fields or grant raw Git writer authority.

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

The reviewer has no repository writer or Git mutation authority. It must materialize the immutable
output against the exact target, rerun both focused test files, classify the inherited typecheck
baseline, rerun exact five-file `lint:fast:files`, Prettier, diff, full-blob, ownership, no-stage,
secret/private-path, and binary checks, and independently prove the exact conflict set. It returns
explicit `ACCEPT` or `REJECT` with complete P0/P1/P2 findings. Only complete `ACCEPT` with P0/P1/P2
`0/0/0` advances.

## Reviewed binding and integration attempt

After `ACCEPT`, `mark_reviewed` must bind the immutable reviewed output ID to exactly:

```json
{
  "sourceRemote": "origin",
  "sourceBranch": "refactor/team-provisioning-round2-reapply",
  "sourceCommit": "7afc908ce92f14b4b0ebd06cc4aa3a4cf33807d0",
  "expectedTargetCommit": "e7e7e734c82c49105682e7a19bbedafa1f5ddbad"
}
```

The only legal integration admission shape is:

```text
open_integration_attempt({ reviewedOutputId })
```

No duplicated source/target arguments, branch-head substitutions, raw patch argument, worktree path,
or worker-provided commit is accepted. The runtime resolves the reviewed binding, recreates the true
merge of the two pinned commits, requires the conflict set to equal the five paths above, applies only
reviewed resolution bytes, reruns every required check, and verifies the five final blob OIDs.

The created merge must have parents in exact order
`[e7e7e734c82c49105682e7a19bbedafa1f5ddbad,
7afc908ce92f14b4b0ebd06cc4aa3a4cf33807d0]`. A one-parent, squash, patch-only, reversed-parent,
moving-head, missing/extra-conflict, extra-diff, or blob-mismatched commit is rejected and not pushed.
Only the validated true two-parent result may be pushed.

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
const target = 'e7e7e734c82c49105682e7a19bbedafa1f5ddbad'
const source = '7afc908ce92f14b4b0ebd06cc4aa3a4cf33807d0'
const node = 'PR252-base-conflict-resolution'
const revision = 'phase-01-pr252-base-conflict-resolution-r2'
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
const blobs = [
  'f5515ddac4cd7bee957a75bc06aad78309ad3a74',
  'a8fea50ddbd71563f2ab7853978d6420eed6c441',
  '5cbaef7f23046dab598a1c2878811adbfd62ea4c',
  '0c0a717fea61031c3c24a4ef787c0acd9bd80ad5',
  'c281cac6493e07abf1ddd201255539e902122af2',
]
const index = JSON.parse(fs.readFileSync(routerPaths[2], 'utf8'))
assert(index.currentExecutableSubphase === node, 'wrong current node')
assert(same(index.currentExecutableNodes, [node]), 'wrong executable node set')
assert(index.currentRouterTerminalState === 'HOLD', 'router is not HOLD')
assert(index.durableController.identity === 'controller-v17', 'controller drift')
assert(index.durableController.requiredState === 'live=true', 'controller state drift')
assert(index.durableController.replacementAuthorized === false, 'controller replacement enabled')
for (const key of ['canonicalSha', 'baseSha', 'phaseStartSha', 'planBundleCommit', 'expectedTargetCommit']) {
  assert(index.currentRoute[key] === target, `target binding drift: ${key}`)
}
assert(index.currentRoute.sourceRemote === 'origin', 'source remote drift')
assert(index.currentRoute.sourceBranch === 'refactor/team-provisioning-round2-reapply', 'source branch drift')
assert(index.currentRoute.sourceCommit === source, 'source commit drift')
assert(index.currentRoute.lanePackets.length === 1, 'lane count drift')
assert(index.currentRoute.lanePackets[0].packetRevision === revision, 'packet revision drift')
assert(index.currentRoute.lanePackets[0].path === routerPaths[6], 'lane path drift')
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
assert(accepted.acceptedCommit === target && accepted.pushed === true, 'accepted target is not pushed')
assert(index.retiredPr252BaseConflictR1.status === 'failed_no_output', 'r1 status drift')
assert(index.retiredPr252BaseConflictR1.authoredOutput === false, 'r1 output invented')
for (const admission of [index.projectScopedProducerAdmission, index.integrationReviewAdmission]) {
  assert(admission.reasoningEffort === 'xhigh', 'reasoning effort drift')
  assert(admission.serviceTier === 'default', 'service tier drift')
  assert(admission.fastMode === false, 'Fast enabled')
}
assert(index.projectScopedProducerAdmission.producerCount === 1, 'producer count drift')
assert(index.integrationReviewAdmission.reviewerCount === 1, 'reviewer count drift')
assert(index.integrationReviewAdmission.repositoryWriterAuthority === false, 'reviewer writer enabled')
assert(same(index.pr252BaseConflictScope.ownedPaths, ownedPaths), 'owned path drift')
assert(
  same(
    ownedPaths.map((value) => index.pr252BaseConflictScope.sourceBlobOids[value]),
    blobs
  ),
  'source blob drift'
)
assert(index.pr252BaseConflictScope.pathCount === 5, 'conflict path count drift')
const protocol = index.reviewedIntegrationProtocol
assert(protocol.markReviewedMergeBinding.sourceCommit === source, 'review source binding drift')
assert(protocol.markReviewedMergeBinding.expectedTargetCommit === target, 'review target binding drift')
assert(same(protocol.openIntegrationAttemptAcceptedFields, ['reviewedOutputId']), 'integration input drift')
assert(same(protocol.requiredParentOrder, [target, source]), 'merge parent drift')
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

Also prove `HEAD` is exactly `e7e7e734c82c49105682e7a19bbedafa1f5ddbad`; the diff contains exactly
the seven ordered router paths above; the cached diff is empty; every link target exists; controller
and lane packet SHA-256 values match the index; all seven files are textual; and a scan of only those
files contains no credential/secret/auth/provider value, private/user/real-project path, or raw
command/runtime body.

## Monitoring, stop, and HOLD

Stop on a stale/mixed pin, unverified accepted fact/blob, controller replacement/non-live state, r1
inspection/reuse, second worker, Fast mode, wrong effort/tier, extra/staged path, unsafe/binary content,
check failure, worker Git mutation, non-independent review, incomplete/REJECT result, invalid merge
binding, or integration input beyond `reviewedOutputId`.

P1.R2, P1.I, P1.F, and Phase 2+ remain blocked until the validated true two-parent merge is pushed.
This docs author does not launch a worker/controller/integration attempt and does not fetch, stage,
commit, merge, or push. Terminal state: `HOLD`.
