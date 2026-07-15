# Phase 1 controller packet: P1.I format-remediation router

## Status and authority

- Phase/current node: `phase-01` / `P1.I.FORMAT.REMEDIATION`
- Serial successor: `P1.I.INTEGRATION`
- Router revision: `phase-01-p1-i-format-remediation-router-r1`
- Lane packet revision: `phase-01-p1-i-integration-r3`
- Router `packetBaseSha`: `b482e816a90e9bb988a0797565241bae4d60b690`
- Router-base role: clean, remote-equal canonical authority
- Every producer/reviewer profile: `gpt-5.6-sol`, `xhigh`,
  `serviceTier: "default"`; Fast is prohibited
- Root role: sole orchestrator
- Durable controller: `controller-v17`, `HOLD`, observation-only
- Router terminal state: `HOLD`

Terminal P1.I job `agent-teams-hosted-web-refactor-p1-i-integration-v17-r1` produced immutable
`BLOCKED`/`HOLD` patch
`d94f8dfa6548427e007402e8771c469c8e661cd64de3a8728dec042a509aebbe` and manifest
`1b88a6e8e53199f0b1905d4f4c194525bcb86db185f0e4748acf60f69bb78f94`. Its audited rejection ledger
exists. Every gate passed except exact 74-path Prettier, whose sole unformatted path was:

```text
docs/research/hosted-web/phase-1/reviews/routes-ratchets.md
```

The rejected patch is provenance only. It must not be materialized, applied, copied, salvaged, or
integrated, and its five blocked outputs must never be integrated.

This router inserts exactly one two-path formatting prerequisite before a fresh five-output P1.I
producer. This docs job launches, reviews, integrates, commits, and pushes nothing. `controller-v17`
cannot launch, admit, integrate, restart, replace itself, or create a successor.

## Outcome

After this exact seven-path router is independently accepted, broker-integrated, and pushed, root may
admit exactly one producer for `P1.I.FORMAT.REMEDIATION`. It applies repository-pinned Prettier only
to the canonical P1.R1 Markdown, proves exact formatter derivation and semantic-token preservation,
records one handoff and hashes, completes every declared check, self-reviews, emits a strict result,
and ends `HOLD`.

After producer termination and immutable two-path capture, root may admit exactly one fresh
independent remediation reviewer. `ACCEPT` with zero P0/P1/P2 findings permits root to
`mark_reviewed`, then permits the broker to integrate and push exactly the two accepted paths.
`REJECT` permits no integration and only a separately admitted bounded remediation of immutable
findings within the same two paths.

After accepted format integration, exact authority attestation, and a successful pinned-Prettier
check over the exact 69 canonical inputs, one fresh `P1.I.INTEGRATION` five-output producer may launch
directly. No other docs router is required. It uses the existing 69 inputs and all 14 gates, generates
new outputs from canonical authority, and then runs exact 74-path Prettier over inputs and outputs. It
does not use the rejected attempt. P1.F, Phase 2+, unrelated nodes and product workers, controller
replacement, and successor controllers remain blocked.

## Authority transitions

The router-base SHA is authoring provenance, not future worker authority. After router acceptance and
integration, root resolves the exact broker-returned pushed commit as
`postRouterIntegrationAuthoritySha`, proves a clean worktree, and immutably attests that it is the sole
result of:

```bash
git ls-remote origin refs/heads/refactor/hosted-web-feature-boundaries
```

That exact SHA binds format-remediation `HEAD`, admission `expectedSourceCommit`, and every handoff
authority field. A moving branch, upstream tracking, or worker-side network query is not authority.

After remediation `ACCEPT`, root `mark_reviewed`, and exact broker integration/push, root resolves the
broker-returned commit as `postFormatRemediationIntegrationAuthoritySha` and repeats the
clean-worktree and explicit-remote-ref attestation. That SHA binds the fresh downstream P1.I producer.
Missing, ambiguous, or mismatched authority ends `HOLD` without launch.

## DAG and capacity

```text
clean remote-equal b482e816a... + existing 69 canonical P1.I inputs
  -> terminal P1.I BLOCKED/HOLD; only exact-74 Prettier fails on routes-ratchets.md
    -> rejected patch/manifest and five outputs frozen as never-integrate provenance
      -> exact seven-path router independently accepted
        -> broker integrates + pushes router
          -> root attests postRouterIntegrationAuthoritySha
            -> exactly one P1.I.FORMAT.REMEDIATION producer
              -> pinned Prettier writes exact Markdown + handoff
                -> exact formatter derivation + semantic-token equality + hashes
                  -> exact-two Prettier + diff/scope/scans + self-review + strict result
                    -> HOLD
                      -> exactly one fresh independent format reviewer
                        -> ACCEPT 0/0/0 -> root mark_reviewed
                          -> broker integrates + pushes exact two paths
                            -> root attests postFormatRemediationIntegrationAuthoritySha
                              -> fresh exact-69-input Prettier passes
                                -> fresh P1.I.INTEGRATION producer launches directly
                                  -> existing 69 inputs + five new outputs + all 14 gates
                                    including exact-74 Prettier
                                    -> HOLD -> fresh independent P1.I milestone review
                        -> REJECT -> HOLD + bounded same-two-path remediation only
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

The format-remediation producer owns exactly, in writer order:

1. `docs/research/hosted-web/phase-1/reviews/routes-ratchets.md`
2. `.codex-handoff/phase-01-p1-i-format-remediation.json`

There is no semantic-edit, product, test, fixture, generated repository file, compile-coherence,
cleanup, repository-temporary-output, config, package, lockfile, router, registry, or third-path
exception. The only repository writer command is the exact pinned-Prettier command over the Markdown.

The fresh downstream P1.I producer retains exactly five outputs:

1. `.codex-handoff/phase-01-p1-i.json`
2. `docs/research/hosted-web/phase-1/decision-register.json`
3. `docs/research/hosted-web/phase-1/estimate-reconciliation.json`
4. `docs/research/hosted-web/phase-1/evidence-index.json`
5. `docs/research/hosted-web/phase-1/integration-report.json`

## Immutable rejected-attempt record

The controller records these facts without importing rejected bytes:

1. job: `agent-teams-hosted-web-refactor-p1-i-integration-v17-r1`;
2. disposition/state: `BLOCKED` / `HOLD`;
3. patch SHA-256: `d94f8dfa6548427e007402e8771c469c8e661cd64de3a8728dec042a509aebbe`;
4. manifest SHA-256:
   `1b88a6e8e53199f0b1905d4f4c194525bcb86db185f0e4748acf60f69bb78f94`;
5. audited rejection ledger: present and binding;
6. gate result: 13 pass, only `P1.GATE.FORMAT` fails;
7. failing scope: exact 69 existing inputs plus five candidate outputs, 74 paths;
8. sole finding: canonical `routes-ratchets.md` is not pinned-Prettier formatted; and
9. rejection consequence: patch materialization/application is forbidden and all five candidate
   outputs are permanently ineligible for integration.

The hashes identify terminal provenance only. They are never an input-patch binding for a producer or
reviewer and never authorize a salvage or retry job.

## Format-remediation start gate

Root proves all of the following in one immutable pre-start snapshot:

1. the router is independently accepted, broker-integrated, and pushed;
2. `postRouterIntegrationAuthoritySha` is exact, clean, and remote-equal;
3. all existing 69 P1.I inputs are present at canonical bytes, including the accepted
   lint-remediation handoff;
4. the format-remediation handoff and all five P1.I outputs are absent;
5. the canonical Markdown is the sole path failing the exact 74-path Prettier finding;
6. rejected patch/output bytes have not been materialized or applied;
7. no format-remediation/P1.I worker, P1.F, Phase 2+, unrelated worker, or successor controller is
   active;
8. dependencies are broker-materialized offline and install/fetch/update is disabled; and
9. admission uses only `gpt-5.6-sol`, `xhigh`, `serviceTier: "default"`, with Fast disabled.

Any mismatch ends `HOLD`. No fallback, alternate tier, retry, refill, concurrent worker, rejected-byte
salvage, or moving source ref is authorized. The complete admission contract is frozen in
`EXECUTION_INDEX.json` and the lane packet.

## Exact remediation implementation

Before the write, the producer reads the canonical Markdown bytes once and records their SHA-256,
their semantic-token SHA-256, the repository-pinned Prettier version, and the SHA-256 of
`prettier.format(canonicalBytes, { filepath })`. It then runs exactly:

```bash
pnpm exec prettier --write docs/research/hosted-web/phase-1/reviews/routes-ratchets.md
```

No other writer command or writer target is legal. The post-write Markdown SHA-256 must equal the
precomputed formatter-output SHA-256. A second pinned formatting evaluation must reproduce identical
bytes, proving idempotence and exact derivation.

The semantic-token fingerprint is computed before and after by the exact lane-packet algorithm. It
normalizes line endings, canonicalizes only Markdown table-delimiter hyphen padding while preserving
alignment colons, preserves fenced-code and inline-code tokens byte-for-byte, and hashes the ordered
non-whitespace Markdown token sequence. Before/after fingerprints must match. This proof is
supplemental to exact formatter derivation; neither permits a semantic edit.

No word, link target, heading level, list marker, table cell value/alignment, code span, fenced-code
byte, HTML token, identifier, SHA, command, finding, disposition, or successor statement may change.
The complete diff must be explainable only by the pinned formatter.

## Required remediation gates

After the handoff is complete, producer and reviewer run exact two-path Prettier:

```bash
pnpm exec prettier --check \
  docs/research/hosted-web/phase-1/reviews/routes-ratchets.md \
  .codex-handoff/phase-01-p1-i-format-remediation.json
```

Acceptance is exit `0` with exactly two matched paths. They validate the handoff as JSON; recompute
the canonical-input, expected-format, formatted-output, token, and non-handoff path hashes; rerun the
exact derivation and token-equivalence proof; and prove pinned-Prettier idempotence.

Read-only Git is authorized only for provenance, diff, and scope observations listed in the lane
packet. Staging, checkout, apply, commit, merge, push, reset, integration, rejected patch access, or
repository-index mutation is forbidden. The tracked diff must be exactly the Markdown, the handoff
must be the only untracked path, staging must be empty, and status must resolve to exactly two paths.

The same two paths receive exact secret/credential, provider-term, private/real-project/task-temporary
path, UTF-8/NUL, and MIME classifications. Required model/profile metadata, repository-relative paths,
hashes, synthetic scan expressions, and explicit prohibited-action language are control text, but
every match is still classified. Any real payload, unsafe path, binary, or unclassified match fails.

The handoff binds all authority SHAs to `postRouterIntegrationAuthoritySha`, records exact paths and
all non-self hashes, exact formatter version/derivation, semantic-token proof, Prettier, diff, scope,
scan and text results, and complete self-review. It claims neither independent acceptance nor
integration. Its next action is `independent-verification` and terminal state is `HOLD`.

The producer returns exactly:

```text
P1_I_FORMAT_REMEDIATION_PRODUCER_RESULT {"status":"VERIFIED","evidenceId":"P1.I.FORMAT.REMEDIATION","changedPathCount":2,"semanticTokenChangeCount":0,"nextAction":"independent-verification","terminalState":"HOLD"}
```

`VERIFIED` is legal only if every gate passes; otherwise only `BLOCKED` or `FAILED` may replace the
status. In all cases the worker ends `HOLD`.

## Independent remediation review and integration boundary

Only after producer termination and immutable two-path capture may root admit exactly one fresh
reviewer. The reviewer is independent of the router author, producer, terminal blocked-attempt worker,
and prior Phase 1 workers. It uses the same default-only profile and is read-only over the two
candidate paths plus execution documents and broker-captured canonical base bytes. It has no writer,
repair, lifecycle, integration, retry, refill, network, runtime, agent-flow, registry, rejected-patch,
or real-project authority.

It independently evaluates the exact diff and handoff and reruns every remediation gate. It returns:

```text
P1_I_FORMAT_REMEDIATION_REVIEW_RESULT {"disposition":"ACCEPT","findingCounts":{"P0":0,"P1":0,"P2":0},"reviewedPathCount":2,"integrationPathCount":2,"semanticTokenChangeCount":0,"terminalState":"HOLD"}
```

`ACCEPT` requires zero P0/P1/P2 findings. `REJECT` uses the same schema with nonzero finding counts
and immutable finding details. Admission, environment, provider, or missing-result incidents remain
`HOLD`, not synthetic `REJECT`.

On `ACCEPT`, root mechanically verifies the result and may call `mark_reviewed`; only then may the
broker integrate and push the exact two paths in writer order. On `REJECT`, there is no lifecycle
acceptance, integration, or P1.I start. Only a separately admitted bounded remediation of the
immutable findings within the same two paths and default-only profile is permitted.

## Direct downstream P1.I continuation

After accepted remediation integration, root proves exact two-path integrated bytes/hashes, clean
remote-equal authority, all 69 existing input paths present, only the Markdown changed among those
inputs from `b482e816a90e9bb988a0797565241bae4d60b690`, the accepted format handoff present but excluded
from the P1.I input set, and all five P1.I outputs absent. It also proves the rejected patch was never
materialized/applied and none of its five bytes is being integrated or reused.

Root runs exact pinned Prettier over the 69 canonical inputs and confirms the formerly failing
Markdown now passes. The fresh producer creates the five outputs and then runs exact 74-path
Prettier over the 69 inputs plus those outputs. No further docs router is required.

The fresh P1.I producer inputs remain the 68 manifest paths evaluated at accepted format authority,
followed by `.codex-handoff/phase-01-p1-i-lint-remediation.json`: 69 distinct read-only paths. The
format-remediation handoff is review/integration provenance, not a 70th input. The producer regenerates
exactly the five declared JSON outputs from canonical inputs.

All existing 14 gate IDs remain mandatory: full Phase 1/team-lifecycle Vitest 13/13 files and 60/60
tests, focused ratchet 1/1 and 3/3, typecheck 7/0/0, full lint zero, Prettier and classified scans over
69 inputs plus five outputs (74 paths), and the same exact 54-path scratch-only rollback/apply proof.
Decision, estimate, evidence lifecycle, integration-report, handoff, self-review and terminal `HOLD`
requirements remain unchanged.

The fresh producer returns:

```text
P1_I_PRODUCER_RESULT {"status":"VERIFIED","evidenceIds":["P1.I.INTEGRATION","P1.I.ROLLBACK"],"changedPathCount":5,"nextAction":"independent-verification","terminalState":"HOLD"}
```

After its terminal immutable five-path output, root may start exactly one fresh independent P1.I
milestone reviewer. `ACCEPT` permits root `mark_reviewed` and exact-five-path broker integration;
`REJECT` permits no integration. P1.F still requires a separate reviewed router transition.

## Stop policy and non-goals

Stop and end `HOLD` on authority/profile drift, an extra/missing path, formatter output not exactly
derived from canonical input, semantic-token drift, any semantic/content change, hash mismatch,
Prettier failure, staged content, scope mismatch, unsafe or unclassified scan match, binary output,
false handoff field, incomplete self-review, early/concurrent review, integration before `ACCEPT` and
`mark_reviewed`, rejected-byte materialization/use, or unsupported successor claim.

No current action authorizes product/test edits, raw Git integration, repository-index mutation,
fetch/install/update, network/provider checks, registry writes, app/server/runtime/team launch,
agent-flow tests, real-project access, stage, commit, merge, push, lifecycle action, integration, P1.F,
Phase 2+, unrelated work, controller replacement, or a successor controller.

## Exact docs-router checks

Run from the repository root with `PATH=/usr/local/bin:/usr/bin:/bin:$PATH`. This docs job uses no Git
command. The semantic validator proves exact authority, routing, counts, ownership, profiles, current
canonical source state, rejected-attempt quarantine, packet hashes, and local Markdown links:

```bash
node <<'NODE'
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

const base = 'b482e816a90e9bb988a0797565241bae4d60b690'
const revision = 'phase-01-p1-i-format-remediation-router-r1'
const laneRevision = 'phase-01-p1-i-integration-r3'
const rejectedPatch = 'd94f8dfa6548427e007402e8771c469c8e661cd64de3a8728dec042a509aebbe'
const rejectedManifest = '1b88a6e8e53199f0b1905d4f4c194525bcb86db185f0e4748acf60f69bb78f94'
const remediationPaths = [
  'docs/research/hosted-web/phase-1/reviews/routes-ratchets.md',
  '.codex-handoff/phase-01-p1-i-format-remediation.json',
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
assert.equal(index.currentExecutableSubphase, 'P1.I.FORMAT.REMEDIATION')
assert(exact(index.currentExecutableNodes, ['P1.I.FORMAT.REMEDIATION']))
assert.equal(index.currentRouterRevision, revision)
assert.equal(index.currentRouterTerminalState, 'HOLD')
assert.equal(index.canonicalAuthority.packetBaseSha, base)
assert.equal(index.canonicalAuthority.postRouterIntegrationAuthoritySha, null)
assert.equal(index.canonicalAuthority.postFormatRemediationIntegrationAuthoritySha, null)
assert.equal(index.canonicalAuthority.formatRemediationProducerAuthorityBinding, 'postRouterIntegrationAuthoritySha')
assert.equal(index.canonicalAuthority.downstreamP1IProducerAuthorityBinding, 'postFormatRemediationIntegrationAuthoritySha')

const blocked = index.terminalBlockedP1IAttempt
assert.equal(blocked.job, 'agent-teams-hosted-web-refactor-p1-i-integration-v17-r1')
assert.equal(blocked.status, 'BLOCKED')
assert.equal(blocked.terminalState, 'HOLD')
assert.equal(blocked.patchSha256, rejectedPatch)
assert.equal(blocked.manifestSha256, rejectedManifest)
assert.equal(blocked.requiredGateCount, 14)
assert.equal(blocked.passedGateCount, 13)
assert.equal(blocked.failingGateId, 'P1.GATE.FORMAT')
assert.equal(blocked.soleUnformattedPath, remediationPaths[0])
assert(blocked.auditedRejectionLedgerExists)
assert(!blocked.patchMaterializationAuthorized)
assert(!blocked.patchApplicationAuthorized)
assert(!blocked.blockedOutputsIntegrationAuthorized)
assert.equal(blocked.blockedOutputPathCount, 5)

assert.equal(index.orchestrationAuthority.rootRole, 'sole-orchestrator')
assert.equal(index.orchestrationAuthority.durableController, 'controller-v17')
assert.equal(index.orchestrationAuthority.controllerState, 'HOLD')
assert(!index.orchestrationAuthority.controllerLaunchAuthorized)
assert(!index.orchestrationAuthority.controllerIntegrationAuthorized)
assert(!index.orchestrationAuthority.successorControllerAuthorized)
for (const name of [
  'formatRemediationProducerProfile',
  'formatRemediationReviewerProfile',
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
assert.equal(index.currentRoute.lanePackets[0].node, 'P1.I.FORMAT.REMEDIATION')
assert.equal(index.currentRoute.lanePackets[0].serialSuccessorNode, 'P1.I.INTEGRATION')
assert.equal(index.currentRoute.lanePackets[0].packetRevision, laneRevision)
assert.equal(index.currentRoute.remediationProducerCompletionBoundary.freshIndependentReviewerCount, 1)
assert.equal(index.currentRoute.remediationProducerCompletionBoundary.acceptedIntegrationPathCount, 2)
assert(!index.currentRoute.remediationProducerCompletionBoundary.producerAndReviewerConcurrencyAuthorized)
assert(index.currentRoute.remediationProducerCompletionBoundary.directDownstreamP1ILaunchAfterAcceptedIntegrationAndExactFormat)
assert(exact(index.currentRoute.remediationIndependentReview.allowedDispositions, ['ACCEPT', 'REJECT']))
assert.equal(index.currentRoute.remediationIndependentReview.rejectLifecycle.at(-1), 'bounded-same-two-path-remediation-only')
assert(!index.currentRoute.remediationIndependentReview.repositoryWritesAuthorized)
assert(!index.currentRoute.directDownstreamP1I.newRouterRequired)
assert.equal(index.currentRoute.directDownstreamP1I.readOnlyInputPathCount, 69)
assert.equal(index.currentRoute.directDownstreamP1I.outputPathCount, 5)
assert.equal(index.currentRoute.directDownstreamP1I.prettierAndScanPathCount, 74)
assert.equal(index.currentRoute.directDownstreamP1I.requiredGateCount, 14)

const groups = index.phase1CanonicalInputs
const inputs68 = [
  ...groups.bootstrapPaths,
  ...groups.p11aPaths,
  ...groups.p11aRemediationProvenancePaths,
  ...groups.p11bPaths,
  ...groups.p11cPaths,
  ...groups.p1r1Paths,
  ...groups.p11dPaths,
  ...groups.p1r2Paths,
]
const inputs69 = [...inputs68, groups.acceptedLintRemediationHandoffPath]
assert.equal(inputs68.length, 68)
assert.equal(new Set(inputs68).size, 68)
assert.equal(inputs69.length, 69)
assert.equal(new Set(inputs69).size, 69)
assert(inputs69.every((file) => fs.existsSync(file)))
assert.equal(groups.currentSnapshotSha, base)
assert.equal(groups.requiredManifestPathCount, 68)
assert.equal(groups.existingDistinctInputPathCount, 69)
assert(exact(groups.formatMutablePaths, [remediationPaths[0]]))
assert.equal(groups.unchangedFromPreFormatSnapshotPathCountRequired, 68)
assert.equal(groups.formatRemediationHandoffPath, remediationPaths[1])
assert(groups.formatRemediationHandoffExcludedFromP1IInputs)

assert.equal(index.rollbackPayload.paths.length, 54)
assert.equal(new Set(index.rollbackPayload.paths).size, 54)
assert(index.rollbackPayload.paths.every((file) => inputs68.includes(file)))
assert(!index.rollbackPayload.workspaceApplyAuthorized)
assert(index.rollbackPayload.scratchRoundTripRequired)
assert(exact(index.formatRemediationOutputs.writablePaths, remediationPaths))
assert(exact(index.downstreamP1IOutputs.writablePaths, p1iOutputs))
assert(exact(index.routerExclusiveOwnership, routerPaths))
assert.equal(index.formatRemediationAdmission.producerCount, 1)
assert.equal(index.formatRemediationReviewerAdmission.reviewerCount, 1)
assert.equal(index.formatRemediationReviewerAdmission.repositoryWriterAuthority, 'none-read-only')
assert.equal(index.formatRemediationReviewerAdmission.rejectFollowupAuthority, 'bounded-same-two-path-remediation-only')
assert(index.authorization.directP1ILaunchWithoutAnotherRouterAuthorizedAfterExactFormatGate)
assert(!index.authorization.blockedP1IAttemptIntegrationAuthorized)
assert(!index.authorization.p1fAuthorized)
assert(!index.authorization.phase2PlusAuthorized)
assert(!index.authorization.controllerReplacementAuthorized)
assert(!index.authorization.successorControllerAuthorized)
assert.equal(index.requiredGateIds.length, 14)
assert.equal(new Set(index.requiredGateIds).size, 14)

const source = fs.readFileSync('src/shared/contracts/hosted/app-error.ts', 'utf8')
assert(!source.includes('diagnosticId: input.diagnosticId as string'))
assert(source.includes('diagnosticId: input.diagnosticId'))
const regression = fs.readFileSync('test/architecture/hosted-web/phase-1/contracts/app-error.test.ts', 'utf8')
assert(regression.includes('diagnostic IDs survive only in frozen known-field projections'))
assert(!fs.existsSync(remediationPaths[1]))
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
console.log('phase-01-p1-i-format-remediation-router-r1: semantic-ok')
NODE
```

Confirm the immutable local format finding without a writer:

```bash
pnpm exec prettier --check docs/research/hosted-web/phase-1/reviews/routes-ratchets.md
```

For this router-authoring base only, the expected result is exit `1` with that single path reported as
unformatted. Any other reported path or any different failure contradicts the packet.

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

Run secret/provider and private-path scans over exactly those seven paths, classify every match, and
run the text/NUL proof:

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

Matches caused by declared scan patterns, repository-relative control paths, required profile,
rejected-attempt provenance hashes, and explicit prohibited-action language are control text, not
payload values, but still require classification. Any real credential, auth/provider payload, private
or real-project path, raw runtime/command body, binary content, or unclassified match fails.

Exact scope is frozen by `routerExclusiveOwnership`, the seven explicit patch targets, the validator,
and final self-review; this router deliberately performs no raw Git observation. Do not run source
ESLint, Vitest, typecheck, full lint, or product writers for the docs transition. After all declared
checks and a complete reread of the seven final files, return exactly:

```text
P1_I_FORMAT_ROUTER_RESULT {"status":"VERIFIED","changedPathCount":7,"authorizedNode":"P1.I.FORMAT.REMEDIATION","serialSuccessor":"P1.I.INTEGRATION","nextAction":"independent-router-review","terminalState":"HOLD"}
```
