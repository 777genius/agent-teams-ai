# Phase 1 controller packet: P1.F milestone-freeze router

## Status and authority

- Phase/current node: `phase-01` / `P1.F`
- Router revision: `phase-01-p1-f-freeze-router-r2`
- Lane packet revision: `phase-01-p1-f-freeze-r2`
- Router `packetBaseSha`: `20706bd067ce5ccbf13697700411904faa2a00c8`
- Router-base role: clean, remote-equal canonical authority
- Accepted P1.I integration SHA: `134f64f0c5c7bbbab0552eddf08df1508118f4bb`
- Canonical merge second parent: `6bf43f140878f8b79f7ee17349bd21b177df901d`
- P1.F worker profile: `gpt-5.6-sol`, `xhigh`, `serviceTier: "default"`; Fast is prohibited
- Root role: sole orchestrator
- Durable controller: `controller-v17`, `HOLD`, observation-only
- Router terminal state: `HOLD`

P1.I received independent `ACCEPT` with P0/P1/P2 `0/0/0`. Attempt
`agent-teams-hosted-web-refactor-p1-i-integration-apply-v17-r2` integrated its exact five outputs in
`134f64f0c5c7bbbab0552eddf08df1508118f4bb^..134f64f0c5c7bbbab0552eddf08df1508118f4bb`.
Canonical `20706bd067ce5ccbf13697700411904faa2a00c8` is the accepted ordered two-parent PR #252 merge
where `20706bd067ce5ccbf13697700411904faa2a00c8^1` equals
`134f64f0c5c7bbbab0552eddf08df1508118f4bb` and the second parent is
`6bf43f140878f8b79f7ee17349bd21b177df901d`. Every exact P1.I output byte remains identical.

Immutable r1 patch `2f7338a1e7b41955d15106f5fb3994b17db6749158bde8134a0a8e23d2081615` was independently
`REJECT`ed with exactly one P1 finding for using the second-parent diff as the five-output P1.I proof.
This r2 packet preserves all other useful r1 contract content and corrects only that proof.

This router creates one bounded Phase 1 exit milestone. This docs job launches, reviews, integrates,
commits, and pushes nothing. `controller-v17` cannot launch, admit, integrate, restart, replace itself,
or create a successor.

## Outcome

After this exact seven-path router is independently accepted, broker-integrated, and pushed, root may
admit exactly one fresh independent `P1.F` milestone-freeze worker. The worker reads exactly 74 frozen
Phase 1 paths and writes exactly two evidence records:

1. `.codex-handoff/phase-01-p1-f.json`
2. `docs/research/hosted-web/phase-1/reviews/phase-1-freeze.md`

It verifies authority, remote equality, ancestry, ordered two-parent/current-base merge shape, P1.I
byte preservation, the exact evidence and gate registries, all declared current checks, rollback,
scans, and self-review. It records evidence IDs `P1.F.FREEZE` and `P1.F.PHASE_EXIT`, returns explicit
`ACCEPT` or `REJECT` with P0/P1/P2 counts, and ends `HOLD`.

`ACCEPT` with P0/P1/P2 `0/0/0` permits root mechanical validation and `mark_reviewed`, then exact-two-
path broker integration/push. `REJECT` permits no integration and only separately admitted remediation
within those two outputs and immutable findings. A separate Phase 2 JIT router may be commissioned
only after accepted P1.F integration is pushed and attested. Phase 2 work remains blocked.

## Authority transitions

`20706bd...` is immutable authoring provenance, not the later P1.F worker `HEAD`. After router
acceptance and integration, root resolves the exact broker-returned pushed commit once as
`postRouterIntegrationAuthoritySha`. Root proves a clean worktree and immutably attests that it is the
sole result of:

```bash
git ls-remote origin refs/heads/refactor/hosted-web-feature-boundaries
```

That exact pushed SHA binds worker `HEAD`, admission `expectedSourceCommit`, and every P1.F handoff
authority field. It must descend from `20706bd...`, and the diff between them must contain exactly the
seven router paths. A moving branch, upstream-tracking state, ambiguous result, or stale attestation is
not authority and ends `HOLD` without launch.

The P1.F worker independently rechecks this bounded remote and ancestry proof. It also proves the
exact five-path P1.I integration range specified above, that `20706bd...` has exactly the ordered
parents above, that `20706bd067ce5ccbf13697700411904faa2a00c8^1` equals the P1.I integration commit,
and that the exact five output bytes are identical at both commits. Its second-parent-to-merge diff is
accumulated current-base history and must never be used as the exact P1.I proof.

## DAG and capacity

```text
P1.I ACCEPT 0/0/0 -> exact five proven by
  134f64f0c5c7bbbab0552eddf08df1508118f4bb^..134f64f0c5c7bbbab0552eddf08df1508118f4bb
  -> accepted ordered merge 20706bd... [134f64f0c5c7bbbab0552eddf08df1508118f4bb,
                                       6bf43f140878f8b79f7ee17349bd21b177df901d]
     -> first parent equality + exact five byte preservation
     -> second-parent diff classified as accumulated current-base history, never exact P1.I proof
    -> exact seven-path P1.F router independent review
      -> broker integrate/push -> root pushed-authority attestation
        -> one fresh independent P1.F worker
          -> 74 read-only inputs + two output records
          -> authority/merge/P1.I-byte/evidence/gate proof
          -> 60 tests + 3 ratchet + typecheck 7/0/0 + lint + exact-74 format
          -> rollback + JSON/hash/link/diff/classified scans + self-review
          -> explicit ACCEPT or REJECT -> HOLD
            ACCEPT 0/0/0 -> root mark_reviewed -> broker exact-two integration/push
              -> root attestation -> separate Phase 2 JIT router may be commissioned
            REJECT -> no integration -> bounded same-two-path remediation only
```

Capacity is one worker at a time. No producer/reviewer pair or concurrent review exists at P1.F: the
single worker is itself the fresh independent milestone reviewer and owns its two freeze records.
Heartbeat, PID, tmux pane, provider observation, or changed-file notice is not completion. Completion
requires the strict result and broker-captured immutable bytes/hashes for both outputs.

## Exact ownership

The docs-router author owns exactly:

1. `docs/hosted-web-phases/EXECUTION_INDEX.json`
2. `docs/hosted-web-phases/README.md`
3. `docs/hosted-web-phases/START_HERE.md`
4. `docs/hosted-web-phases/phase-01/README.md`
5. `docs/hosted-web-phases/phase-01/controller-packet.md`
6. `docs/hosted-web-phases/phase-01/execution-dag.md`
7. `docs/hosted-web-phases/phase-01/lanes/p1-f-freeze.md`

The P1.F worker owns exactly the two outputs listed above, in that order. The exact 74-path manifest,
historical `p1-i-integration.md`, all P1.I outputs, product/test/runtime source, dependencies, config,
lockfiles, registries, and repository index are read-only. No third-path, cleanup, compile-coherence,
P1.I remediation, generated-output, or repository-temporary-file exception exists.

## P1.F start gate and admission

Root records one immutable snapshot proving:

1. exact router acceptance, broker integration, push, and seven-path scope;
2. exact `postRouterIntegrationAuthoritySha`, local `HEAD`, clean worktree, and remote equality;
3. `20706bd...` ancestry and exact seven-path router delta;
4. historical P1.I lane and exact five outputs byte-preserved;
5. the exact 74 read-only manifest paths present and both P1.F outputs absent;
6. no P1.F, remediation, Phase 2, unrelated worker, or successor controller active;
7. exact worker independence from every router/P1.I actor;
8. broker-materialized offline dependencies with install/fetch/update disabled; and
9. only `gpt-5.6-sol`, `xhigh`, `serviceTier: "default"`, with Fast disabled.

The admission is one `codex_goal_project_refill_worker` with `workerRole: reviewer`,
`reviewKind: review`, node `P1.F`, lane `p1-f-freeze`, packet revision
`phase-01-p1-f-freeze-r2`, and every authority binding set to
`postRouterIntegrationAuthoritySha`. There is no alternate model/tier, retry, refill, fallback,
concurrent reviewer, worker-spawned reviewer, or moving-source binding.

## Exact Phase 1 freeze scope

`EXECUTION_INDEX.json.phase1FreezeManifest.paths` is the sole manifest. Its compact JSON-array SHA-256
is `0e8e2b82125eb3b8e559f9fa439e8942e0eea89d75da4cccc35d75099e868223`. It contains exactly 74
distinct existing paths: the frozen 69 P1.I canonical inputs followed by the five accepted P1.I
outputs in writer order.

The worker recomputes every one of the first 69 hashes against the immutable entries in the P1.I
evidence index. It proves the five output paths are the exact diff in
`134f64f0c5c7bbbab0552eddf08df1508118f4bb^..134f64f0c5c7bbbab0552eddf08df1508118f4bb`,
then proves the final five files match these exact SHA-256 values at `134f64f...`, `20706bd...`, and
current worker authority:

- `.codex-handoff/phase-01-p1-i.json`:
  `be6ca8a01fba06871b9246ae2baaf230e7b95222bb0da3eec8548016c5639903`;
- `decision-register.json`: `1d275a95a189d7840a6d75591d90c138b0ec5399747db41794697de0cde32ba9`;
- `estimate-reconciliation.json`:
  `941c58195b9955b9807b896aedf7f46ea1a4ed455dc6713241ffefb074405328`;
- `evidence-index.json`: `07a17cb6674916f65713e337f15deeb3f5405d36fbcccbbcdada3b5895724590`;
- `integration-report.json`: `a64cc23427dd049e0ede0ce217a7401a5ec6f6df51ec6cb9b5ca3ef5458f4e8f`.

A path, order, existence, regular-file, UTF-8, NUL, symlink, or hash mismatch forces `REJECT`.

## Evidence, gate, and check contract

The exact 14 Phase 1 acceptance evidence IDs are frozen in
`EXECUTION_INDEX.json.requiredPhase1EvidenceIds`. They are the two P1.S0 IDs, two P1.1A IDs, two
P1.1B IDs, two P1.1C IDs, P1.R1, three P1.1D IDs, P1.R2, and
`P1.NEG.RATCHET_REGRESSION`. The worker requires each exactly once with valid content. It separately
requires accepted lint-remediation provenance plus `P1.I.INTEGRATION` and `P1.I.ROLLBACK`, yielding
exactly 17 frozen P1.I catalog rows with no unknown ID.

The 14 gate IDs in `EXECUTION_INDEX.json.requiredGateIds` are independently revalidated. Exact command
results are:

- Phase 1/team-lifecycle Vitest: 13/13 files and 60/60 tests;
- focused ratchet Vitest: 1/1 file and 3/3 tests;
- native TypeScript: 7 inherited/0 owned/0 unexpected exact diagnostics;
- full `pnpm lint`: exit `0`, zero errors;
- pinned Prettier over exact 74 manifest paths: exit `0`, 74 matches; and
- separate pinned Prettier over exact two P1.F outputs: exit `0`, two matches.

The worker also reruns exact-54 scratch-only forward/reverse rollback from bootstrap
`5f30df49e052d1cc1d0e7efd03aa105673b5b614` to `20706bd...`, with 54/54 forward byte equality and
54/54 reverse absence. It separately proves the ordered current-base merge shape and classifies the
second-parent diff as accumulated history; neither that diff nor rollback substitutes for the exact
P1.I integration range.

## Validation, scans, and findings

The worker parses and schema-validates every JSON in the 74 inputs plus two outputs, recomputes all
declared hashes, resolves every repository-relative Markdown link, validates controller/lane and
historical P1.I packet hashes, and proves exact-two diff/scope with no staged, tracked, product/test, or
P1.I change.

It scans the exact 76-path candidate set for secret/credential terms and values, auth/provider payloads,
private user/home/real-project/task-temporary paths, raw command/runtime bodies, binary/MIME/NUL/symlink
content, and unresolved placeholders. Fixture canaries and control text remain classified rather than
silently excluded. Any unsafe or unclassified match fails.

Both outputs contain complete P0/P1/P2 findings and self-review. `ACCEPT` requires zero findings at all
three severities and every proof above. `REJECT` requires immutable finding details and permits only
bounded two-output remediation.

## Result and integration boundary

The strict accepted result is:

```text
P1_F_FREEZE_RESULT {"disposition":"ACCEPT","evidenceIds":["P1.F.FREEZE","P1.F.PHASE_EXIT"],"findingCounts":{"P0":0,"P1":0,"P2":0},"reviewedPathCount":74,"changedPathCount":2,"integrationPathCount":2,"nextAction":"broker-integrate-freeze-evidence","terminalState":"HOLD"}
```

`REJECT` uses the same schema with nonzero counts, immutable details, and
`nextAction: "bounded-two-path-remediation"`. Admission/environment/missing-proof incidents remain
`HOLD` and are not synthetic review dispositions.

On `ACCEPT`, root may mechanically validate and call `mark_reviewed`; only then may the broker
integrate and push the exact two outputs. On `REJECT`, no lifecycle acceptance or integration occurs.
Only separate same-two-path remediation against immutable findings is legal.

After accepted integration/push and exact clean remote-equality attestation, root may commission a
separate Phase 2 JIT docs router. Phase 2 product workers remain blocked, and P1.F grants no authority
to author, review, integrate, or launch that later route itself.

## Stop policy and non-goals

Stop and end `HOLD` on authority/profile/independence drift, an extra/missing path/parent/evidence ID,
remote or merge mismatch, P1.I byte drift, gate/check/typecheck/format failure, rollback/current-base
failure, JSON/hash/link/diff/scope mismatch, unsafe/unclassified scan match, binary/symlink/NUL output,
false record, incomplete self-review, integration before `ACCEPT` and `mark_reviewed`, or unsupported
successor claim.

No current action authorizes P1.I repetition, product/test/runtime edits, real-project access,
dependency install/fetch/update, registry writes, app/server/team/provider flows, stage, commit, merge,
push, raw Git integration, reviewer launch, controller replacement, successor controller, Phase 2
router authoring, or Phase 2 work.

## Exact docs-router checks

Run from the repository root with `PATH=/usr/local/bin:/usr/bin:/bin:$PATH`. This docs job uses no Git
command. The semantic validator proves exact routing, counts, ownership, profile, current frozen P1.I
bytes, historical-packet preservation, packet hashes, JSON, and local Markdown links:

```bash
node <<'NODE'
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

const base = '20706bd067ce5ccbf13697700411904faa2a00c8'
const p1iIntegration = '134f64f0c5c7bbbab0552eddf08df1508118f4bb'
const currentBase = '6bf43f140878f8b79f7ee17349bd21b177df901d'
const rejectedR1Patch = '2f7338a1e7b41955d15106f5fb3994b17db6749158bde8134a0a8e23d2081615'
const revision = 'phase-01-p1-f-freeze-router-r2'
const laneRevision = 'phase-01-p1-f-freeze-r2'
const manifestHash = '0e8e2b82125eb3b8e559f9fa439e8942e0eea89d75da4cccc35d75099e868223'
const historicalP1IHash = '3f81d6e65f9848b6b3db593dda6eb87e5eeb7276af9e76d2fe79ba3fc6f094fe'
const outputs = [
  '.codex-handoff/phase-01-p1-i.json',
  'docs/research/hosted-web/phase-1/decision-register.json',
  'docs/research/hosted-web/phase-1/estimate-reconciliation.json',
  'docs/research/hosted-web/phase-1/evidence-index.json',
  'docs/research/hosted-web/phase-1/integration-report.json',
]
const outputHashes = [
  'be6ca8a01fba06871b9246ae2baaf230e7b95222bb0da3eec8548016c5639903',
  '1d275a95a189d7840a6d75591d90c138b0ec5399747db41794697de0cde32ba9',
  '941c58195b9955b9807b896aedf7f46ea1a4ed455dc6713241ffefb074405328',
  '07a17cb6674916f65713e337f15deeb3f5405d36fbcccbbcdada3b5895724590',
  'a64cc23427dd049e0ede0ce217a7401a5ec6f6df51ec6cb9b5ca3ef5458f4e8f',
]
const p1fOutputs = [
  '.codex-handoff/phase-01-p1-f.json',
  'docs/research/hosted-web/phase-1/reviews/phase-1-freeze.md',
]
const requiredEvidenceIds = [
  'P1.S0.BASELINE',
  'P1.S0.BOOTSTRAP',
  'P1.1A.KERNEL',
  'P1.1A.VERSION',
  'P1.1B.ROUTES',
  'P1.1B.CAPABILITIES',
  'P1.1C.CONFORMANCE',
  'P1.1C.RATCHETS',
  'P1.R1.ARCH_REVIEW',
  'P1.1D.TEAM_LIFECYCLE_READ_CONTRACT',
  'P1.1D.TEAM_LIFECYCLE_READ_USE_CASE',
  'P1.1D.TEAM_LIFECYCLE_SEMANTIC_PROOF',
  'P1.R2.SEMANTIC_REVIEW',
  'P1.NEG.RATCHET_REGRESSION',
]
const additionalEvidenceIds = [
  'P1.I.LINT.REMEDIATION',
  'P1.I.INTEGRATION',
  'P1.I.ROLLBACK',
]
const routerPaths = [
  'docs/hosted-web-phases/EXECUTION_INDEX.json',
  'docs/hosted-web-phases/README.md',
  'docs/hosted-web-phases/START_HERE.md',
  'docs/hosted-web-phases/phase-01/README.md',
  'docs/hosted-web-phases/phase-01/controller-packet.md',
  'docs/hosted-web-phases/phase-01/execution-dag.md',
  'docs/hosted-web-phases/phase-01/lanes/p1-f-freeze.md',
]
const exact = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const shaBytes = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex')
const sha = (file) => shaBytes(fs.readFileSync(file))
const collect = (value, key, out = []) => {
  if (!value || typeof value !== 'object') return out
  if (Object.prototype.hasOwnProperty.call(value, key)) out.push(value[key])
  for (const child of Object.values(value)) collect(child, key, out)
  return out
}

const index = JSON.parse(fs.readFileSync(routerPaths[0], 'utf8'))
assert.equal(index.currentExecutablePhase, 'phase-01')
assert.equal(index.currentExecutableSubphase, 'P1.F')
assert(exact(index.currentExecutableNodes, ['P1.F']))
assert.equal(index.currentRouterRevision, revision)
assert.equal(index.currentRouterTerminalState, 'HOLD')
assert.equal(index.canonicalAuthority.packetBaseSha, base)
assert.equal(index.acceptedP1I.integrationSha, p1iIntegration)
assert.equal(index.acceptedP1I.integrationRange, `${p1iIntegration}^..${p1iIntegration}`)
assert.equal(index.acceptedP1I.exactOutputPathProof, 'integration-range')
assert.equal(index.acceptedP1I.disposition, 'ACCEPT')
assert(exact(index.acceptedP1I.findingCounts, { P0: 0, P1: 0, P2: 0 }))
assert.equal(index.canonicalAuthority.firstParentRef, `${base}^1`)
assert.equal(index.canonicalAuthority.mergeParent1, p1iIntegration)
assert.equal(index.canonicalAuthority.mergeParent2, currentBase)
assert(index.canonicalAuthority.firstParentEqualsAcceptedP1IIntegrationSha)
assert.equal(
  index.canonicalAuthority.secondParentDiffRole,
  'accumulated-current-base-history-never-exact-p1i-proof',
)
assert(index.acceptedP1I.outputBytesIdenticalAtIntegrationAndPacketBase)
assert(!index.acceptedP1I.packetBaseSecondParentDiffAuthorizedAsExactP1IProof)
assert.equal(index.canonicalAuthority.postRouterIntegrationAuthoritySha, null)
assert.equal(index.currentRoute.lanePackets[0].packetRevision, laneRevision)
assert.equal(index.p1fAdmission.packetRevision, laneRevision)
assert.equal(index.historicalAuthority.rejectedP1FRouterR1.patchSha256, rejectedR1Patch)
assert.equal(index.historicalAuthority.rejectedP1FRouterR1.disposition, 'REJECT')
assert(exact(index.historicalAuthority.rejectedP1FRouterR1.findingCounts, { P0: 0, P1: 1, P2: 0 }))
assert.equal(
  index.historicalAuthority.rejectedP1FRouterR1.remediationScope,
  'merge-provenance-proof-only',
)

assert(exact(index.p1fWorkerProfile, {
  model: 'gpt-5.6-sol',
  reasoningEffort: 'xhigh',
  serviceTier: 'default',
  fastAuthorized: false,
}))
assert(collect(index, 'serviceTier').every((value) => value === 'default'))
assert(collect(index, 'fastAuthorized').every((value) => value === false))

const manifest = index.phase1FreezeManifest.paths
assert.equal(manifest.length, 74)
assert.equal(new Set(manifest).size, 74)
assert.equal(shaBytes(JSON.stringify(manifest)), manifestHash)
assert(manifest.every((file) => fs.existsSync(file)))
assert(exact(manifest.slice(-5), outputs))
assert(exact(index.p1fOutputs.writablePaths, p1fOutputs))
assert(exact(index.routerExclusiveOwnership, routerPaths))

const evidenceIndex = JSON.parse(fs.readFileSync(outputs[3], 'utf8'))
const inputs69 = evidenceIndex.canonicalInputManifest.entries
assert.equal(inputs69.length, 69)
assert(exact(inputs69.map((entry) => entry.path), manifest.slice(0, 69)))
for (const entry of inputs69) assert.equal(sha(entry.path), entry.sha256, entry.path)
for (let i = 0; i < outputs.length; i++) assert.equal(sha(outputs[i]), outputHashes[i])

assert(exact(index.requiredPhase1EvidenceIds, requiredEvidenceIds))
assert(exact(index.additionalFrozenCatalogIds, additionalEvidenceIds))
const catalogIds = evidenceIndex.evidence.map((entry) => entry.id)
assert.equal(catalogIds.length, 17)
assert.equal(new Set(catalogIds).size, 17)
assert(exact(catalogIds.filter((id) => requiredEvidenceIds.includes(id)), requiredEvidenceIds))
assert(exact(catalogIds.filter((id) => additionalEvidenceIds.includes(id)), additionalEvidenceIds))
for (const entry of evidenceIndex.evidence) {
  assert.equal(sha(entry.path), entry.contentSha256, entry.id)
}
assert.equal(index.requiredGateIds.length, 14)
assert.equal(new Set(index.requiredGateIds).size, 14)
assert.equal(index.rollbackPayload.paths.length, 54)
assert.equal(new Set(index.rollbackPayload.paths).size, 54)
assert(index.rollbackPayload.paths.every((file) => manifest.includes(file)))

assert.equal(index.orchestrationAuthority.rootRole, 'sole-orchestrator')
assert.equal(index.orchestrationAuthority.durableController, 'controller-v17')
assert.equal(index.orchestrationAuthority.controllerState, 'HOLD')
assert(!index.orchestrationAuthority.controllerLaunchAuthorized)
assert(!index.orchestrationAuthority.successorControllerAuthorized)
assert.equal(index.p1fAdmission.workerCount, 1)
assert.equal(index.p1fAdmission.workerRole, 'reviewer')
assert.equal(index.p1fAdmission.repositoryWriterAuthority, 'exact-two-p1f-output-paths-only')
assert.equal(index.authorization.acceptIntegrationPathCount, 2)
assert.equal(index.authorization.rejectFollowup, 'bounded-same-two-path-remediation-only')
assert(!index.authorization.phase2WorkerAuthorized)
assert(!index.authorization.p1iRepeatAuthorized)

assert.equal(
  sha('docs/hosted-web-phases/phase-01/lanes/p1-i-integration.md'),
  historicalP1IHash,
)
for (const packet of [index.packetHashes.controllerPacket, index.packetHashes.lanePacket]) {
  assert.equal(sha(packet.path), packet.sha256, `packet hash drift ${packet.path}`)
}
for (const output of p1fOutputs) assert(!fs.existsSync(output), `premature P1.F output ${output}`)

for (const routerPath of routerPaths.filter((file) => file.endsWith('.md'))) {
  const text = fs.readFileSync(routerPath, 'utf8')
  assert(text.includes(revision), `missing revision ${routerPath}`)
  for (const match of text.matchAll(/\]\(([^)]+)\)/g)) {
    const target = match[1].replace(/^<|>$/g, '').split('#')[0]
    if (!target || /^[a-z]+:/i.test(target)) continue
    assert(fs.existsSync(path.resolve(path.dirname(routerPath), target)), `broken link ${target}`)
  }
}
console.log('phase-01-p1-f-freeze-router-r2: semantic-ok')
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
  docs/hosted-web-phases/phase-01/lanes/p1-f-freeze.md
```

Run secret/provider and private-path scans over exactly those seven paths, classify every match, and
run JSON/text/NUL proof:

```bash
router_paths=(
  docs/hosted-web-phases/EXECUTION_INDEX.json
  docs/hosted-web-phases/README.md
  docs/hosted-web-phases/START_HERE.md
  docs/hosted-web-phases/phase-01/README.md
  docs/hosted-web-phases/phase-01/controller-packet.md
  docs/hosted-web-phases/phase-01/execution-dag.md
  docs/hosted-web-phases/phase-01/lanes/p1-f-freeze.md
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
JSON.parse(fs.readFileSync(paths[0], 'utf8'))
for (const path of paths) {
  const bytes = fs.readFileSync(path)
  assert(!bytes.includes(0), `NUL byte ${path}`)
  new TextDecoder('utf-8', { fatal: true }).decode(bytes)
}
console.log('router JSON/text scan: ok')
NODE
```

Matches caused by declared scan patterns, repository-relative control paths, required profile,
provenance hashes, fixture/security requirements, and explicit prohibited-action language are control
text, not payload values, but every match still requires classification. Any real credential,
auth/provider payload, private or real-project path, raw sensitive command/runtime body, binary, or
unclassified match fails.

Exact scope is frozen by `routerExclusiveOwnership`, the seven explicit patch targets, the validator,
historical P1.I and five-output hash checks, and final self-review. This router deliberately performs no
raw Git observation. Do not run source ESLint, Vitest, typecheck, full lint, app/runtime flow, lifecycle
action, or product writer for the docs transition. After all declared checks and a complete reread of
the seven final files, return exactly:

```text
P1_F_ROUTER_RESULT {"status":"VERIFIED","changedPathCount":7,"authorizedNode":"P1.F","nextAction":"independent-router-review","terminalState":"HOLD"}
```
