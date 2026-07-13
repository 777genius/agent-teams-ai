# Phase 1 controller packet: P1.1D corrected independent review

## Status and authority

- Current node: `P1.1D-additive-response-remediation`
- Current mode: review-only
- Immutable product candidate `baseSha`: `1b37afb02bec25a1f08432d733595b553101ecab`
- Reviewer `canonicalSha`, `phaseStartSha`, `planBundleCommit`, and worktree `HEAD`:
  `bbfd2551baaa904061e705511f07716e0f6db17d`
- Superseded packet: `phase-01-p1-1d-additive-response-remediation-r1`
- Current packet: `phase-01-p1-1d-additive-response-review-r2`
- Capacity after admission: exactly one fresh independent reviewer
- Reviewer configuration: reasoning effort `xhigh`, service tier `default`
- Required disposition: explicit `ACCEPT` or `REJECT`
- Blocked: product mutation, producer retry/refill, product integration, P1.R2, P1.I, P1.F,
  Phase 2+, and all five PR conflict files

The P1.1D remediation product candidate is complete and immutable. This transition corrects only the
input provenance supplied to independent review. It does not rerun or change production, reinterpret a
rejection, integrate anything, or launch a reviewer or controller.

The predecessor docs-router transition is immutable rejected evidence: reviewed output
`1ad2849056be658ab629b9810914ace7eab3287745ecb39c1d76ac1c124d0eb7`, patch SHA-256
`657c1c5ff6421f6b206ef14509586d09fad72e8c511efe1a6f9bf6b8dce5f577`, based at
`bbfd2551baaa904061e705511f07716e0f6db17d`. Its useful review-only transition is reproduced here,
but its invalid product-base and reviewer-admission assertions are not. The rejected artifact remains
unmodified and unintegrated.

## Exact immutable-candidate provenance

| Role                                      | SHA-256                                                            | Allowed use                                      |
| ----------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------ |
| Runtime nine-path handoff carrier         | `1f9c6a2a28e5540c61d1395bc51a34a7c0db31855bae575abc9582f839118b49` | Locate and verify the complete candidate carrier |
| Final eight-path semantic reconstruction  | `fa46617652b072e887563f5a751f7bd0260e0e1d4fb96b628badea91ea7ae9d6` | Verify the five product and three test paths     |
| Reviewed-workspace rejection-ledger input | `521d8bab2ed7bc4334b38a5786dd5685f5e4f033c3962cab566f9ab3b60d0000` | Consume the prior rejection-ledger record only   |

The three hashes are legitimate but non-interchangeable. The workspace snapshot is not a carrier,
handoff, patch, or semantic reconstruction hash and must not be presented as fresh candidate identity.

The final candidate neither contains nor claims transient interim hash `7672e922`. That value appeared
only in an external review instruction and has no candidate-authority role.

## Binding prior independent review

| Field                    | Value                                                              |
| ------------------------ | ------------------------------------------------------------------ |
| Strict result SHA-256    | `29ad2243be1a1e0c7aa95cb1a32ae32b8f15db8ebe1a260cd41dd85d2c079934` |
| Binding disposition      | `REJECT`                                                           |
| Finding severity         | P1                                                                 |
| Finding count            | one                                                                |
| Sole finding             | stale external review-input assertion mislabeled `7672e922`        |
| Candidate claim of value | none                                                               |
| Reinterpreted as ACCEPT  | no                                                                 |

The rejection remains binding. Its sole basis was the external instruction's incorrect assertion that
`7672e922` was the final handoff hash. Correcting that instruction permits a fresh review; it does not
retroactively accept the prior review or candidate.

Producer output and prior reviewer output each have a formal rejected integration-ledger record.
Admission reports no blocking output debt. Those records close runtime-output accounting only; they do
not grant integration authority.

## Outcome

Authorize one fresh independent reviewer to inspect the existing immutable nine-path candidate with
the corrected hash roles above and return explicit `ACCEPT` or `REJECT` with P0/P1/P2 findings. The
reviewer must independently rerun the bound semantic, negative, architecture, quality, provenance,
ownership, hash, and safety gates. No candidate byte may change.

## Durable controller and structured transition

The durable controller identity remains unchanged. Moving from completed product production to
review-only authority is an actual authority transition, so the controller must atomically update its
structured scope from packet `phase-01-p1-1d-additive-response-remediation-r1` to
`phase-01-p1-1d-additive-response-review-r2`. It must remain `live=true` throughout admission and bind
reviewer `planBundleCommit` `bbfd2551baaa904061e705511f07716e0f6db17d` without changing the
immutable product `baseSha` `1b37afb02bec25a1f08432d733595b553101ecab`.

No controller replacement, restart, successor launch, or second controller is authorized. A stale or
mixed packet, producer authority left active, non-live controller, second reviewer, or identity reused
from the router author, any P1.1D producer, or the prior rejected reviewer fails closed.

## Review launch gate and exact identity

Reviewer capacity is zero until all conditions are true:

1. this exact seven-path docs-only correction router is policy-integrated after
   `bbfd2551baaa904061e705511f07716e0f6db17d`;
2. the same durable controller reports exactly `live=true` with the structured review-only scope;
3. the runtime verifies the carrier, semantic reconstruction, ledger snapshot, and prior result hashes
   by their distinct roles;
4. both formal rejected integration-ledger records are present and admission still reports no blocking
   output debt;
5. the existing candidate remains byte-identical and unintegrated; and
6. no producer, reviewer, integration, later-node, or conflict-resolution work is active.

After all six gates, the same controller may invoke the existing ProjectScopedControl operation. This
is the supported admission identity; it is not a new public tool or contract:

```text
operation: codex_goal_project_refill_worker
workerRole: reviewer
reasoningEffort: xhigh
serviceTier: default
preStartAdmission.mode: serial-builtin
preStartAdmission.contract.kind: worker-launch
preStartAdmission.contract.format: 1
preStartAdmission.contract.canonicalSha: bbfd2551baaa904061e705511f07716e0f6db17d
preStartAdmission.contract.baseSha: 1b37afb02bec25a1f08432d733595b553101ecab
preStartAdmission.contract.phaseStartSha: bbfd2551baaa904061e705511f07716e0f6db17d
preStartAdmission.contract.packetRevision: phase-01-p1-1d-additive-response-review-r2
preStartAdmission.contract.controllerPacket: docs/hosted-web-phases/phase-01/controller-packet.md
preStartAdmission.contract.lanePacket: docs/hosted-web-phases/phase-01/lanes/p1-1d-additive-response-remediation.md
preStartAdmission.contract.phaseId: phase-01
preStartAdmission.contract.laneId: p1-1d-additive-response-remediation-review
preStartAdmission.contract.inputPatchHash: 1f9c6a2a28e5540c61d1395bc51a34a7c0db31855bae575abc9582f839118b49
preStartAdmission.contract.reviewKind: review
```

The existing internal `worker-launch` format additionally requires the exact nine `ownedPaths`, lane
mandatory documents/scripts/fixtures, non-empty required checks, and sandbox-only execution policy;
the controller must populate those established fields from this lane packet rather than guess a
smaller schema. The reviewer count of one is enforced by the controller's serial state, not invented
as a contract field. `planBundleCommit` remains the separately bound reviewer runtime fact above; it
is not added as an unsupported `worker-launch` key.

The semantic reconstruction hash, rejection-ledger snapshot hash, prior strict-result hash, binding
`REJECT`, and stale `7672e922` classification remain distinct review evidence. They are not substituted
for `inputPatchHash` or injected as invented internal contract fields. No separate reviewer-launch
operation or public contract exists.

## Exact seven-path router ownership

1. `docs/hosted-web-phases/START_HERE.md`
2. `docs/hosted-web-phases/README.md`
3. `docs/hosted-web-phases/EXECUTION_INDEX.json`
4. `docs/hosted-web-phases/phase-01/README.md`
5. `docs/hosted-web-phases/phase-01/controller-packet.md`
6. `docs/hosted-web-phases/phase-01/execution-dag.md`
7. `docs/hosted-web-phases/phase-01/lanes/p1-1d-additive-response-remediation.md`

Every product, test, runtime, orchestration, research-evidence, configuration, package, lockfile,
handoff, ledger, and conflict-resolution path is read-only. An eighth changed path rejects this router.

## Immutable nine-path review scope

Product paths:

- `src/features/team-lifecycle/contracts/team-lifecycle-read.ts`
- `src/features/team-lifecycle/contracts/index.ts`
- `src/features/team-lifecycle/core/application/ListTeamLifecycle.ts`
- `src/features/team-lifecycle/core/application/index.ts`
- `src/features/team-lifecycle/index.ts`

Test paths:

- `test/features/team-lifecycle/core/ListTeamLifecycle.test.ts`
- `test/architecture/hosted-web/phase-1/team-lifecycle/team-lifecycle-read-contract.test.ts`
- `test/architecture/hosted-web/phase-1/team-lifecycle/team-lifecycle-read-boundaries.test.ts`

Handoff path:

- `.codex-handoff/phase-01-p1-1d.json`

The reviewer reads these five product, three test, and one handoff paths without editing, formatting,
staging, regenerating, or replacing them. The eight non-handoff paths are the semantic reconstruction
scope; all nine paths are the runtime carrier scope.

## Independent review gate

The fresh reviewer must:

1. prove independence from this router author, all P1.1D producers, and the prior rejected reviewer;
2. prove product `baseSha` is exactly `1b37afb02bec25a1f08432d733595b553101ecab` while reviewer
   `canonicalSha`, `phaseStartSha`, `planBundleCommit`, and worktree `HEAD` are exactly
   `bbfd2551baaa904061e705511f07716e0f6db17d`;
3. verify each legitimate hash only in its declared role and verify the prior strict result as binding
   `REJECT`;
4. confirm candidate paths contain no claim of `7672e922` and classify docs references to it as the
   external stale assertion only;
5. rerun every exact focused, negative, additive-response, architecture, lint, typecheck-classification,
   formatting, diff, provenance, ownership, binary, and lexical-safety gate without changing bytes;
6. independently recompute the eight-path semantic reconstruction and verify the complete nine-path
   carrier using the runtime's recorded canonical reconstruction procedures;
7. verify the producer and reviewer rejected-ledger records and no-blocking-output-debt admission
   without treating ledger closure as acceptance; and
8. return one explicit `ACCEPT` or `REJECT` result with P0/P1/P2 findings and exact hash observations.

Only a new explicit `ACCEPT` can make the immutable candidate eligible for a separately authorized
integration. `REJECT`, blocked, failed, incomplete, ambiguous, or non-independent output is not
acceptance and authorizes no retry/refill.

## Exact docs-router checks

Run each command independently from the repository root after exporting
`PATH=/usr/local/bin:/usr/bin:/bin:$PATH`:

```bash
node <<'NODE'
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const assert = (condition, message) => {
  if (!condition) throw new Error(message)
}
const same = (actual, expected) =>
  actual.length === expected.length && actual.every((value, index) => value === expected[index])
const routerPaths = [
  'docs/hosted-web-phases/START_HERE.md',
  'docs/hosted-web-phases/README.md',
  'docs/hosted-web-phases/EXECUTION_INDEX.json',
  'docs/hosted-web-phases/phase-01/README.md',
  'docs/hosted-web-phases/phase-01/controller-packet.md',
  'docs/hosted-web-phases/phase-01/execution-dag.md',
  'docs/hosted-web-phases/phase-01/lanes/p1-1d-additive-response-remediation.md',
]
const index = JSON.parse(fs.readFileSync(routerPaths[2], 'utf8'))
const node = 'P1.1D-additive-response-remediation'
const productBase = '1b37afb02bec25a1f08432d733595b553101ecab'
const reviewerSha = 'bbfd2551baaa904061e705511f07716e0f6db17d'
const carrier = '1f9c6a2a28e5540c61d1395bc51a34a7c0db31855bae575abc9582f839118b49'
const semantic = 'fa46617652b072e887563f5a751f7bd0260e0e1d4fb96b628badea91ea7ae9d6'
const ledger = '521d8bab2ed7bc4334b38a5786dd5685f5e4f033c3962cab566f9ab3b60d0000'
const strictResult = '29ad2243be1a1e0c7aa95cb1a32ae32b8f15db8ebe1a260cd41dd85d2c079934'
assert(index.currentExecutableSubphase === node, 'wrong current subphase')
assert(same(index.currentExecutableNodes, [node]), 'wrong executable nodes')
assert(index.currentRouterTerminalState === 'HOLD', 'router is not holding')
assert(
  index.workerStartAuthority === 'ProjectScopedControl codex_goal_project_refill_worker',
  'unsupported reviewer operation'
)
assert(index.currentRoute.mode === 'review-only', 'route is not review-only')
assert(index.currentRoute.baseSha === productBase, 'wrong product base')
for (const key of ['canonicalSha', 'phaseStartSha', 'planBundleCommit', 'reviewerWorktreeHead']) {
  assert(index.currentRoute[key] === reviewerSha, `wrong reviewer ${key}`)
}
assert(index.currentRoute.lanePackets.length === 1, 'lane count is not one')
assert(index.currentRoute.launchGate.required.sameDurableController === true, 'controller replaced')
assert(index.currentRoute.launchGate.required.structuredReviewScopeUpdateApplied === true, 'scope not structured')
assert(index.currentRoute.lanePackets[0].path === routerPaths[6], 'wrong lane path')
assert(
  index.currentRoute.lanePackets[0].packetRevision ===
    'phase-01-p1-1d-additive-response-review-r2',
  'wrong packet revision'
)
assert(index.priorP11dIndependentReview.disposition === 'REJECT', 'prior review drift')
assert(index.priorP11dIndependentReview.strictResultSha256 === strictResult, 'strict result drift')
assert(index.priorP11dIndependentReview.reinterpretedAsAccept === false, 'REJECT laundered')
assert(index.priorP11dIndependentReview.staleExternalAssertion === '7672e922', 'wrong stale assertion')
assert(index.immutableP11dCandidate.containsOrClaimsStaleExternalAssertion === false, 'candidate claim drift')
assert(index.immutableP11dCandidate.baseSha === productBase, 'candidate base drift')
assert(index.immutableP11dCandidate.runtimeNinePathHandoffCarrierSha256 === carrier, 'carrier drift')
assert(index.immutableP11dCandidate.finalEightPathSemanticReconstructionSha256 === semantic, 'semantic drift')
assert(index.rejectionLedgerConsumption.reviewedWorkspaceSnapshotSha256 === ledger, 'ledger hash drift')
assert(index.rejectionLedgerConsumption.purpose === 'prior-rejection-ledger-consumption-only', 'ledger role drift')
for (const key of ['canonicalSha', 'phaseStartSha', 'planBundleCommit', 'worktreeHead']) {
  assert(index.reviewerRuntimeBinding[key] === reviewerSha, `wrong reviewer binding ${key}`)
}
assert(index.rejectedP11dReviewInputRouter.disposition === 'REJECT', 'router REJECT drift')
assert(
  index.rejectedP11dReviewInputRouter.reviewedOutputId ===
    '1ad2849056be658ab629b9810914ace7eab3287745ecb39c1d76ac1c124d0eb7',
  'wrong rejected router output'
)
assert(
  index.rejectedP11dReviewInputRouter.patchSha256 ===
    '657c1c5ff6421f6b206ef14509586d09fad72e8c511efe1a6f9bf6b8dce5f577',
  'wrong rejected router patch'
)
assert(index.rejectedP11dReviewInputRouter.findingCount === 2, 'wrong router finding count')
assert(index.rejectedP11dReviewInputRouter.integrated === false, 'rejected router integrated')
const admission = index.projectScopedReviewerAdmission
assert(admission.operation === 'codex_goal_project_refill_worker', 'wrong broker operation')
assert(admission.workerRole === 'reviewer', 'wrong worker role')
assert(admission.reasoningEffort === 'xhigh', 'wrong admission effort')
assert(admission.serviceTier === 'default', 'wrong admission service tier')
assert(admission.preStartAdmission.mode === 'serial-builtin', 'wrong admission mode')
assert(admission.preStartAdmission.contract.kind === 'worker-launch', 'wrong contract kind')
assert(admission.preStartAdmission.contract.format === 1, 'wrong internal contract format')
assert(admission.preStartAdmission.contract.canonicalSha === reviewerSha, 'wrong contract canonical')
assert(admission.preStartAdmission.contract.baseSha === productBase, 'wrong contract base')
assert(admission.preStartAdmission.contract.phaseStartSha === reviewerSha, 'wrong contract phase start')
assert(admission.preStartAdmission.contract.reviewKind === 'review', 'wrong review kind')
assert(admission.preStartAdmission.contract.inputPatchHash === carrier, 'wrong review input carrier')
assert(admission.planBundleCommitBinding === reviewerSha, 'wrong admission plan bundle')
assert(index.authorization.reviewerCount === 1, 'reviewer count drift')
assert(index.authorization.freshReviewerRequired === true, 'fresh reviewer not required')
assert(index.authorization.independentFromRouterAuthor === true, 'router independence drift')
assert(index.authorization.independentFromAllP11dProducers === true, 'producer independence drift')
assert(index.authorization.independentFromPriorRejectedReviewer === true, 'reviewer independence drift')
assert(index.authorization.reasoningEffort === 'xhigh', 'reasoning effort drift')
assert(index.authorization.serviceTier === 'default', 'service tier drift')
assert(index.authorization.prConflictFileCount === 5, 'PR conflict count drift')
assert(index.authorization.prConflictFilesBlocked === true, 'PR conflict files not blocked')
assert(
  same(index.authorization.blocked, [
    'product integration',
    'P1.R2',
    'P1.I',
    'P1.F',
    'Phase 2+',
    'five PR conflict files',
  ]),
  'blocked set drift'
)
assert(index.authorization.reviewAuthorized === true, 'fresh review not authorized')
assert(index.authorization.reviewLaunchPerformedByThisDocsJob === false, 'review launch performed')
assert(index.authorization.productChangeAuthorized === false, 'product change authorized')
assert(index.authorization.integrationAuthorized === false, 'integration authorized')
for (const packet of [index.packetHashes.controllerPacket, index.packetHashes.lanePacket]) {
  const actual = crypto.createHash('sha256').update(fs.readFileSync(packet.path)).digest('hex')
  assert(actual === packet.sha256, `packet hash drift: ${packet.path}`)
}
for (const routerPath of routerPaths.filter((value) => value.endsWith('.md'))) {
  const source = fs.readFileSync(routerPath, 'utf8')
  for (const match of source.matchAll(/\]\(([^)]+)\)/g)) {
    const target = match[1].replace(/^<|>$/g, '').split('#')[0]
    if (!target || /^[a-z]+:/i.test(target)) continue
    assert(fs.existsSync(path.resolve(path.dirname(routerPath), target)), `broken link ${target}`)
  }
}
console.log('router-json-links-provenance-hashes: ok')
NODE
pnpm exec prettier --check docs/hosted-web-phases/START_HERE.md docs/hosted-web-phases/README.md docs/hosted-web-phases/EXECUTION_INDEX.json docs/hosted-web-phases/phase-01/README.md docs/hosted-web-phases/phase-01/controller-packet.md docs/hosted-web-phases/phase-01/execution-dag.md docs/hosted-web-phases/phase-01/lanes/p1-1d-additive-response-remediation.md
git diff --check
git status --short
```

Also require:

```bash
test "$(git rev-parse HEAD)" = "bbfd2551baaa904061e705511f07716e0f6db17d"
test "$(git diff --name-only)" = "$(printf '%s\n' 'docs/hosted-web-phases/EXECUTION_INDEX.json' 'docs/hosted-web-phases/README.md' 'docs/hosted-web-phases/START_HERE.md' 'docs/hosted-web-phases/phase-01/README.md' 'docs/hosted-web-phases/phase-01/controller-packet.md' 'docs/hosted-web-phases/phase-01/execution-dag.md' 'docs/hosted-web-phases/phase-01/lanes/p1-1d-additive-response-remediation.md')"
test -z "$(git diff --cached --name-only)"
router_paths=(docs/hosted-web-phases/START_HERE.md docs/hosted-web-phases/README.md docs/hosted-web-phases/EXECUTION_INDEX.json docs/hosted-web-phases/phase-01/README.md docs/hosted-web-phases/phase-01/controller-packet.md docs/hosted-web-phases/phase-01/execution-dag.md docs/hosted-web-phases/phase-01/lanes/p1-1d-additive-response-remediation.md)
rg -n -i '(-----BEGIN [A-Z ]*PR[I]VATE KEY-----|\bBearer[[:space:]]+[A-Za-z0-9]|\b(?:sk|ghp)_[A-Za-z0-9]{12,}|/(?:U[s]ers|h[o]me|r[o]ot)/|[A-Za-z]:\\U[s]ers\\|claude[-]runtime|(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|cookie|authorization|auth[_-]?payload|provider[_-]?payload|raw[_-]?(?:command|runtime)[_-]?body)[[:space:]]*[:=][[:space:]]*[^[:space:]]+)' "${router_paths[@]}"
file --mime-type "${router_paths[@]}"
```

The lexical scan must exit 1 with zero matches, every file must be textual, exactly the seven router
paths must be modified, and nothing may be staged.

## Monitoring, stop, and HOLD

Stop on stale or mixed identity, an unverified hash, a role-label mismatch, candidate mutation,
`7672e922` presented as candidate identity, missing ledger record, blocking output debt, non-independent
reviewer, second reviewer, producer activity, extra/staged path, secret/private path, binary content,
integration activity, later-node activity, or work in any of the five PR conflict files.

This docs author ends on `HOLD` without staging, committing, pushing, integrating, launching a reviewer
or controller, rerunning a producer, or starting later work. Product integration remains blocked.
