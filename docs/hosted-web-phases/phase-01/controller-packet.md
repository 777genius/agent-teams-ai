# Phase 1 controller packet: P1.I lint-remediation router

## Status and authority

- Phase/current node: `phase-01` / `P1.I.LINT.REMEDIATION`
- Serial successor: `P1.I.INTEGRATION`
- Router revision: `phase-01-p1-i-lint-remediation-router-r1`
- Lane packet revision: `phase-01-p1-i-integration-r2`
- Router `packetBaseSha`: `0d7f904abf2a3d4eaf7ba4e16ebd987d473535fe`
- Router-base role: clean, remotely pushed canonical authority
- Remediation producer/reviewer profile: `gpt-5.6-sol`, `xhigh`,
  `serviceTier: "default"`; Fast is prohibited
- Downstream P1.I producer/reviewer profile: the same default-only profile
- Root role: sole orchestrator
- Durable controller: `controller-v17`, `HOLD`, observation-only
- Router terminal state: `HOLD`

Canonical full lint has exactly one error and no other lint finding:

```text
src/shared/contracts/hosted/app-error.ts:29:65
@typescript-eslint/no-unnecessary-type-assertion
```

The accepted P1.I lane requires zero-error full lint, so this router inserts exactly one serial
prerequisite before the existing five-output P1.I producer. This docs job launches, reviews,
integrates, commits, and pushes nothing. `controller-v17` cannot launch, admit, integrate, restart,
replace itself, or create a successor.

## Outcome

After this exact seven-path router is independently accepted, broker-integrated, and pushed, root may
admit exactly one product worker for `P1.I.LINT.REMEDIATION`. It removes only the redundant
`diagnosticId` type assertion, adds one focused safe-error regression, records one handoff, completes
every gate, self-reviews, emits a strict result, and ends `HOLD`.

After producer termination and immutable three-path capture, root may admit exactly one fresh
independent remediation reviewer. `ACCEPT` with zero P0/P1/P2 findings permits root to
`mark_reviewed`, then permits the broker to integrate and push exactly the three accepted paths.
`REJECT` permits no integration and only a separately admitted bounded remediation of immutable
findings within the same three paths.

After accepted remediation integration, exact authority attestation, and a fresh zero-error full
lint, the already specified `P1.I.INTEGRATION` five-output producer may launch directly. No other docs
router is required. P1.F, Phase 2+, unrelated nodes and product workers, controller replacement, and
successor controllers remain blocked.

## Authority transitions

The router-base SHA is authoring provenance, not future worker authority. After router acceptance and
integration, root resolves the exact broker-returned pushed commit as
`postRouterIntegrationAuthoritySha`, proves a clean worktree, and immutably attests that it is the sole
result of:

```bash
git ls-remote origin refs/heads/refactor/hosted-web-feature-boundaries
```

That exact SHA binds remediation `HEAD`, admission `expectedSourceCommit`, and every handoff authority
field. A moving branch, upstream tracking, or worker-side network query is not authority.

After remediation `ACCEPT`, root `mark_reviewed`, and exact broker integration/push, root resolves the
broker-returned commit as `postRemediationIntegrationAuthoritySha` and repeats the clean-worktree and
explicit-remote-ref attestation. That SHA binds the downstream P1.I producer. Missing, ambiguous, or
mismatched authority ends `HOLD` without launch.

## DAG and capacity

```text
clean pushed canonical 0d7f904abf2a... with exactly one full-lint error
  -> exact seven-path router independently accepted
    -> broker integrates + pushes router
      -> root attests postRouterIntegrationAuthoritySha
        -> exactly one P1.I.LINT.REMEDIATION producer
          -> exact source assertion deletion + focused regression + handoff
            -> focused Vitest 1/2 + full lint 0 + typecheck 7/0/0
              -> Prettier + diff/scope/scans + self-review + strict result
                -> HOLD
                  -> exactly one fresh independent remediation reviewer
                    -> ACCEPT 0/0/0 -> root mark_reviewed
                      -> broker integrates + pushes exact three paths
                        -> root attests postRemediationIntegrationAuthoritySha
                          -> fresh full lint 0
                            -> existing P1.I.INTEGRATION producer launches directly
                              -> 69 inputs + five outputs + 14 gates
                                -> HOLD -> existing independent P1.I milestone review
                    -> REJECT -> HOLD + bounded same-three-path remediation only
```

Capacity is one worker at a time. Producer and reviewer never overlap. Heartbeat, PID, tmux pane,
`providerObserved`, or a changed-file notice is not completion. Completion requires the strict
terminal result plus broker-captured immutable output bytes and hashes.

## Exact ownership

The docs-router author owns exactly:

1. `docs/hosted-web-phases/EXECUTION_INDEX.json`
2. `docs/hosted-web-phases/README.md`
3. `docs/hosted-web-phases/START_HERE.md`
4. `docs/hosted-web-phases/phase-01/README.md`
5. `docs/hosted-web-phases/phase-01/controller-packet.md`
6. `docs/hosted-web-phases/phase-01/execution-dag.md`
7. `docs/hosted-web-phases/phase-01/lanes/p1-i-integration.md`

The remediation product worker owns exactly, in writer order:

1. `src/shared/contracts/hosted/app-error.ts`
2. `test/architecture/hosted-web/phase-1/contracts/app-error.test.ts`
3. `.codex-handoff/phase-01-p1-i-lint-remediation.json`

There is no fixture, generated-file, formatting, compile-coherence, cleanup, temporary-output, config,
package, lockfile, router, registry, or fourth-path exception.

The downstream P1.I producer retains exactly its existing five outputs:

1. `.codex-handoff/phase-01-p1-i.json`
2. `docs/research/hosted-web/phase-1/decision-register.json`
3. `docs/research/hosted-web/phase-1/estimate-reconciliation.json`
4. `docs/research/hosted-web/phase-1/evidence-index.json`
5. `docs/research/hosted-web/phase-1/integration-report.json`

## Remediation start gate

Root proves all of the following in one immutable pre-start snapshot:

1. the router is independently accepted, broker-integrated, and pushed;
2. `postRouterIntegrationAuthoritySha` is exact, clean, and remote-equal;
3. the original 68 Phase 1 manifest inputs are unchanged from `0d7f904abf2a...`;
4. the remediation handoff is absent and the full-lint baseline is exactly the one diagnostic above;
5. no remediation/P1.I worker, P1.F, Phase 2+, unrelated worker, or successor controller is active;
6. dependencies are broker-materialized offline and install/fetch/update is disabled; and
7. admission uses only `gpt-5.6-sol`, `xhigh`, `serviceTier: "default"`, with Fast disabled.

Any mismatch ends `HOLD`. No fallback, alternate tier, retry, refill, concurrent worker, or moving
source ref is authorized. The complete admission contract is frozen in `EXECUTION_INDEX.json` and
the lane packet.

## Exact remediation implementation

The source diff is exactly:

```diff
-    ...(input.diagnosticId === undefined ? {} : { diagnosticId: input.diagnosticId as string }),
+    ...(input.diagnosticId === undefined ? {} : { diagnosticId: input.diagnosticId }),
```

No other source token or `AppError` semantic may change. The test file adds one inline focused
regression proving that a valid `diagnosticId` survives `createSafeAppError` unchanged, the safe
error remains frozen and known-field-only, and an unsafe diagnostic ID still rejects with the
existing safe-error behavior. It must not change raw-message handling, transport fields, retry rules,
error codes, validation grammar, projection keys, imports, exports, or fixture ownership.

## Required remediation gates

The producer and independent reviewer run the focused test:

```bash
pnpm exec vitest run test/architecture/hosted-web/phase-1/contracts/app-error.test.ts
```

Acceptance is exactly 1/1 file and 2/2 tests. They run `pnpm lint`, never fast lint or a writer/fix
command; acceptance is exit `0` with zero errors. They run `pnpm typecheck`; acceptance is the frozen
seven inherited Phase 0 diagnostics, zero owned, and zero unexpected diagnostics.

After the handoff is complete they run exact three-path Prettier, read-only provenance/diff/scope
checks, the exact secret/provider/private-path scans, MIME classification, and a complete source/test/
handoff self-review specified by the lane packet. The tracked diff is exactly the source and test,
the handoff is the only untracked path, staging is empty, and the source diff is exactly the one-line
assertion deletion.

The handoff binds all authority SHAs to `postRouterIntegrationAuthoritySha`, records exact paths and
non-handoff hashes, every gate result, the original lint diagnostic, post-edit lint zero, semantic
preservation, classified scans, and self-review. It claims neither independent acceptance nor
integration. Its next action is `independent-verification` and its terminal state is `HOLD`.

The producer returns exactly:

```text
P1_I_LINT_REMEDIATION_PRODUCER_RESULT {"status":"VERIFIED","evidenceId":"P1.I.LINT.REMEDIATION","changedPathCount":3,"fullLintErrorCount":0,"nextAction":"independent-verification","terminalState":"HOLD"}
```

`VERIFIED` is legal only if every gate passes; otherwise only `BLOCKED` or `FAILED` may replace the
status. In all cases the worker ends `HOLD`.

## Independent remediation review and integration boundary

Only after producer termination and immutable three-path capture may root admit exactly one fresh
reviewer. The reviewer is independent of the router author, producer, and prior Phase 1 workers. It
uses the same default-only profile and is read-only over the three candidate paths plus execution
documents. It has no writer, repair, lifecycle, integration, retry, refill, network, runtime,
agent-flow, registry, or real-project authority.

It independently evaluates the diff and handoff and reruns every remediation gate. It returns:

```text
P1_I_LINT_REMEDIATION_REVIEW_RESULT {"disposition":"ACCEPT","findingCounts":{"P0":0,"P1":0,"P2":0},"reviewedPathCount":3,"integrationPathCount":3,"fullLintErrorCount":0,"terminalState":"HOLD"}
```

`ACCEPT` requires zero P0/P1/P2 findings. `REJECT` uses the same schema with nonzero finding counts
and immutable finding details. Admission, environment, provider, or missing-result incidents remain
`HOLD`, not synthetic `REJECT`.

On `ACCEPT`, root mechanically verifies the result and may call `mark_reviewed`; only then may the
broker integrate and push the exact three paths in writer order. On `REJECT`, there is no lifecycle
acceptance, integration, or P1.I start. Only a separately admitted bounded remediation of the
immutable findings within the same three paths and default-only profile is permitted.

## Direct downstream P1.I continuation

After accepted remediation integration, root proves exact three-path integrated bytes/hashes, clean
remote-equal authority, original 68-path manifest presence, only the two remediation-owned manifest
paths changed from the pre-remediation snapshot, the accepted remediation handoff present, all five
P1.I outputs absent, and fresh full lint at `postRemediationIntegrationAuthoritySha` zero.

The P1.I producer then launches directly without another router. Its inputs are the original 68
manifest paths evaluated at accepted remediation authority, followed by the accepted remediation
handoff: 69 distinct read-only paths. The two remediated paths match the accepted candidate; the other
66 remain byte-identical to `0d7f904abf2a...`.

Its existing 14 gate IDs remain mandatory with updated exact totals: full Phase 1/team-lifecycle
Vitest 13/13 files and 60/60 tests, focused ratchet 1/1 and 3/3, typecheck 7/0/0, full lint zero,
Prettier and scans over 69 inputs plus five outputs (74 paths), and the same exact 54-path scratch-only
rollback/apply proof from P1.S0 to accepted remediation authority. Its strict five-output producer
result, later fresh independent milestone review, and `ACCEPT`-only five-path broker integration are
unchanged.

P1.F still requires a separate reviewed router transition. P1.F, Phase 2+, unrelated nodes/product
workers, and controller succession remain blocked even after P1.I evidence integration.

## Stop policy and non-goals

Stop and end `HOLD` on authority/profile drift, an extra/missing path, source diff beyond the assertion
deletion, unfocused test change, semantic drift, test/lint/typecheck/Prettier failure, staged content,
scope mismatch, unsafe or unclassified scan match, binary output, false handoff field, incomplete
self-review, early/concurrent review, integration before `ACCEPT` and `mark_reviewed`, or unsupported
successor claim.

No current action authorizes product edits, raw Git, repository-index mutation, fetch/install/update,
network/provider checks, registry writes, app/server/runtime/team launch, agent-flow tests,
real-project access, stage, commit, merge, push, launch, stop, integration, P1.F, Phase 2+, unrelated
work, controller replacement, or a successor controller.

## Exact docs-router checks

Run from the repository root with `PATH=/usr/local/bin:/usr/bin:/bin:$PATH`. This docs job uses no Git
command. The semantic validator proves exact authority, routing, counts, ownership, profiles, current
canonical source state, packet hashes, and local Markdown links:

```bash
node <<'NODE'
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

const base = '0d7f904abf2a3d4eaf7ba4e16ebd987d473535fe'
const revision = 'phase-01-p1-i-lint-remediation-router-r1'
const laneRevision = 'phase-01-p1-i-integration-r2'
const remediationPaths = [
  'src/shared/contracts/hosted/app-error.ts',
  'test/architecture/hosted-web/phase-1/contracts/app-error.test.ts',
  '.codex-handoff/phase-01-p1-i-lint-remediation.json',
]
const p1iOutputs = [
  '.codex-handoff/phase-01-p1-i.json',
  'docs/research/hosted-web/phase-1/decision-register.json',
  'docs/research/hosted-web/phase-1/estimate-reconciliation.json',
  'docs/research/hosted-web/phase-1/evidence-index.json',
  'docs/research/hosted-web/phase-1/integration-report.json',
]
const routerPaths = [
  'docs/hosted-web-phases/EXECUTION_INDEX.json',
  'docs/hosted-web-phases/README.md',
  'docs/hosted-web-phases/START_HERE.md',
  'docs/hosted-web-phases/phase-01/README.md',
  'docs/hosted-web-phases/phase-01/controller-packet.md',
  'docs/hosted-web-phases/phase-01/execution-dag.md',
  'docs/hosted-web-phases/phase-01/lanes/p1-i-integration.md',
]
const exact = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const sha = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
const collect = (value, key, out = []) => {
  if (!value || typeof value !== 'object') return out
  if (Object.prototype.hasOwnProperty.call(value, key)) out.push(value[key])
  for (const child of Object.values(value)) collect(child, key, out)
  return out
}

const index = JSON.parse(fs.readFileSync(routerPaths[0], 'utf8'))
assert.equal(index.currentExecutablePhase, 'phase-01')
assert.equal(index.currentExecutableSubphase, 'P1.I.LINT.REMEDIATION')
assert(exact(index.currentExecutableNodes, ['P1.I.LINT.REMEDIATION']))
assert.equal(index.currentRouterRevision, revision)
assert.equal(index.currentRouterTerminalState, 'HOLD')
assert.equal(index.canonicalAuthority.packetBaseSha, base)
assert.equal(index.canonicalAuthority.postRouterIntegrationAuthoritySha, null)
assert.equal(index.canonicalAuthority.postRemediationIntegrationAuthoritySha, null)
assert.equal(index.canonicalAuthority.remediationProducerAuthorityBinding, 'postRouterIntegrationAuthoritySha')
assert.equal(index.canonicalAuthority.downstreamP1IProducerAuthorityBinding, 'postRemediationIntegrationAuthoritySha')
assert.equal(index.canonicalLintBlocker.path, remediationPaths[0])
assert.equal(index.canonicalLintBlocker.line, 29)
assert.equal(index.canonicalLintBlocker.column, 65)
assert.equal(index.canonicalLintBlocker.rule, '@typescript-eslint/no-unnecessary-type-assertion')
assert.equal(index.canonicalLintBlocker.errorCount, 1)
assert.equal(index.orchestrationAuthority.rootRole, 'sole-orchestrator')
assert.equal(index.orchestrationAuthority.durableController, 'controller-v17')
assert.equal(index.orchestrationAuthority.controllerState, 'HOLD')
assert(!index.orchestrationAuthority.controllerLaunchAuthorized)
assert(!index.orchestrationAuthority.controllerIntegrationAuthorized)
assert(!index.orchestrationAuthority.successorControllerAuthorized)
for (const name of [
  'remediationProducerProfile',
  'remediationReviewerProfile',
  'downstreamP1IProducerProfile',
  'downstreamP1IReviewerProfile',
]) {
  assert(exact(index[name], {
    model: 'gpt-5.6-sol',
    reasoningEffort: 'xhigh',
    serviceTier: 'default',
    fastAuthorized: false,
  }))
}
assert(collect(index, 'serviceTier').every((value) => value === 'default'))
assert(collect(index, 'fastAuthorized').every((value) => value === false))
assert.equal(index.currentRoute.lanePackets.length, 1)
assert.equal(index.currentRoute.lanePackets[0].node, 'P1.I.LINT.REMEDIATION')
assert.equal(index.currentRoute.lanePackets[0].serialSuccessorNode, 'P1.I.INTEGRATION')
assert.equal(index.currentRoute.lanePackets[0].packetRevision, laneRevision)
assert.equal(index.currentRoute.remediationProducerCompletionBoundary.freshIndependentReviewerCount, 1)
assert.equal(index.currentRoute.remediationProducerCompletionBoundary.acceptedIntegrationPathCount, 3)
assert(!index.currentRoute.remediationProducerCompletionBoundary.producerAndReviewerConcurrencyAuthorized)
assert(index.currentRoute.remediationProducerCompletionBoundary.directDownstreamP1ILaunchAfterAcceptedIntegrationAndZeroFullLint)
assert(exact(index.currentRoute.remediationIndependentReview.allowedDispositions, ['ACCEPT', 'REJECT']))
assert.equal(index.currentRoute.remediationIndependentReview.rejectLifecycle.at(-1), 'bounded-same-three-path-remediation-only')
assert(!index.currentRoute.remediationIndependentReview.repositoryWritesAuthorized)
assert(!index.currentRoute.directDownstreamP1I.newRouterRequired)
assert.equal(index.currentRoute.directDownstreamP1I.readOnlyInputPathCount, 69)
assert.equal(index.currentRoute.directDownstreamP1I.outputPathCount, 5)
assert.equal(index.currentRoute.directDownstreamP1I.fullPhase1TestCount, 60)
assert.equal(index.currentRoute.directDownstreamP1I.prettierAndScanPathCount, 74)
assert.equal(index.currentRoute.directDownstreamP1I.rollbackPayloadPathCount, 54)

const groups = index.phase1CanonicalInputs
const inputs = [
  ...groups.bootstrapPaths,
  ...groups.p11aPaths,
  ...groups.p11aRemediationProvenancePaths,
  ...groups.p11bPaths,
  ...groups.p11cPaths,
  ...groups.p1r1Paths,
  ...groups.p11dPaths,
  ...groups.p1r2Paths,
]
assert.equal(inputs.length, 68)
assert.equal(new Set(inputs).size, 68)
assert(inputs.every((file) => fs.existsSync(file)))
assert.equal(groups.preRemediationSnapshotSha, base)
assert.equal(groups.requiredTotalPathCount, 68)
assert(exact(groups.remediationMutablePaths, remediationPaths.slice(0, 2)))
assert.equal(groups.unchangedFromPreRemediationSnapshotPathCountRequired, 66)
assert.equal(groups.acceptedRemediationHandoffPath, remediationPaths[2])
assert.equal(groups.downstreamDistinctInputPathCount, 69)
assert.equal(index.rollbackPayload.paths.length, 54)
assert.equal(new Set(index.rollbackPayload.paths).size, 54)
assert(index.rollbackPayload.paths.every((file) => inputs.includes(file)))
assert(!index.rollbackPayload.workspaceApplyAuthorized)
assert(index.rollbackPayload.scratchRoundTripRequired)

assert(exact(index.lintRemediationOutputs.writablePaths, remediationPaths))
assert(exact(index.downstreamP1IOutputs.writablePaths, p1iOutputs))
assert(exact(index.routerExclusiveOwnership, routerPaths))
assert.equal(index.lintRemediationAdmission.producerCount, 1)
assert.equal(index.lintRemediationReviewerAdmission.reviewerCount, 1)
assert.equal(index.lintRemediationReviewerAdmission.repositoryWriterAuthority, 'none-read-only')
assert.equal(index.lintRemediationReviewerAdmission.rejectFollowupAuthority, 'bounded-same-three-path-remediation-only')
assert(index.authorization.directP1ILaunchWithoutAnotherRouterAuthorizedAfterZeroLintGate)
assert(!index.authorization.p1fAuthorized)
assert(!index.authorization.phase2PlusAuthorized)
assert(!index.authorization.controllerReplacementAuthorized)
assert(!index.authorization.successorControllerAuthorized)
assert(exact(index.requiredExactResults.lintRemediationFocusedVitest, {
  command: 'pnpm exec vitest run test/architecture/hosted-web/phase-1/contracts/app-error.test.ts',
  testFiles: 1,
  passed: 2,
  total: 2,
}))
assert.equal(index.requiredExactResults.fullPhase1Vitest.testFiles, 13)
assert.equal(index.requiredExactResults.fullPhase1Vitest.passed, 60)
assert.equal(index.requiredExactResults.fullPhase1Vitest.total, 60)
assert(exact(index.requiredExactResults.nativeTypeScript, { inherited: 7, owned: 0, unexpected: 0 }))
assert(exact(index.requiredExactResults.fullLint, { command: 'pnpm lint', exitCode: 0 }))
assert.equal(index.requiredGateIds.length, 14)
assert.equal(new Set(index.requiredGateIds).size, 14)

const source = fs.readFileSync(remediationPaths[0], 'utf8')
const assertion = 'diagnosticId: input.diagnosticId as string'
assert.equal(source.split(assertion).length - 1, 1)
assert(!fs.existsSync(remediationPaths[2]))
for (const output of p1iOutputs) assert(!fs.existsSync(output), `premature P1.I output ${output}`)
for (const packet of [index.packetHashes.controllerPacket, index.packetHashes.lanePacket]) {
  assert.equal(sha(packet.path), packet.sha256, `packet hash drift ${packet.path}`)
}
for (const routerPath of routerPaths.filter((file) => file.endsWith('.md'))) {
  const text = fs.readFileSync(routerPath, 'utf8')
  assert(text.includes(revision), `missing revision ${routerPath}`)
  for (const match of text.matchAll(/\]\(([^)]+)\)/g)) {
    const target = match[1].replace(/^<|>$/g, '').split('#')[0]
    if (!target || /^[a-z]+:/i.test(target)) continue
    assert(fs.existsSync(path.resolve(path.dirname(routerPath), target)), `broken link ${target}`)
  }
}
console.log('phase-01-p1-i-lint-remediation-router-r1: semantic-ok')
NODE
```

Run exact seven-path formatting verification:

```bash
pnpm exec prettier --check \
  docs/hosted-web-phases/EXECUTION_INDEX.json \
  docs/hosted-web-phases/README.md \
  docs/hosted-web-phases/START_HERE.md \
  docs/hosted-web-phases/phase-01/README.md \
  docs/hosted-web-phases/phase-01/controller-packet.md \
  docs/hosted-web-phases/phase-01/execution-dag.md \
  docs/hosted-web-phases/phase-01/lanes/p1-i-integration.md
```

Run the secret/provider and private-path scans over exactly those seven paths, classify every match,
and run the text/NUL proof:

```bash
router_paths=(
  docs/hosted-web-phases/EXECUTION_INDEX.json
  docs/hosted-web-phases/README.md
  docs/hosted-web-phases/START_HERE.md
  docs/hosted-web-phases/phase-01/README.md
  docs/hosted-web-phases/phase-01/controller-packet.md
  docs/hosted-web-phases/phase-01/execution-dag.md
  docs/hosted-web-phases/phase-01/lanes/p1-i-integration.md
)
test "${#router_paths[@]}" -eq 7
rg -n -i '(api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|bearer|cookie|authorization)' "${router_paths[@]}"
rg -n -i '(provider|anthropic|claude|openai|opencode|gpt-[0-9])' "${router_paths[@]}"
rg -n '(/Users/|/home/|/root/|/tmp/|~/|[A-Za-z]:\\Users\\|real[-_ ]project)' "${router_paths[@]}"
node - "${router_paths[@]}" <<'NODE'
const assert = require('node:assert/strict')
const fs = require('node:fs')
const paths = process.argv.slice(2)
assert.equal(paths.length, 7)
for (const path of paths) {
  const bytes = fs.readFileSync(path)
  assert(!bytes.includes(0), `NUL byte ${path}`)
  new TextDecoder('utf-8', { fatal: true }).decode(bytes)
}
console.log('router text scan: ok')
NODE
```

Matches caused by the declared scan patterns, repository-relative control paths, required profile,
and explicit prohibited-action language are control text, not payload values, but still require
classification. Any real credential, auth/provider payload, private or real-project path, raw
runtime/command body, binary content, or unclassified match fails.

Exact scope is frozen by `routerExclusiveOwnership`, the seven explicit patch targets, the validator,
and final self-review; this router deliberately performs no raw Git observation. Do not run source
ESLint, Vitest, typecheck, or product checks for the docs transition. After all declared checks and a
complete reread of the seven final files, return exactly:

```text
P1_I_LINT_ROUTER_RESULT {"status":"VERIFIED","changedPathCount":7,"authorizedNode":"P1.I.LINT.REMEDIATION","serialSuccessor":"P1.I.INTEGRATION","nextAction":"independent-router-review","terminalState":"HOLD"}
```
