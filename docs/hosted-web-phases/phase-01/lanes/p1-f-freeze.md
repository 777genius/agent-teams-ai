# P1.F Phase 1 milestone-freeze lane

## Authority and mission

- Project: `agent-teams-hosted-web-refactor`
- Phase/node: `phase-01` / `P1.F`
- Lane ID: `p1-f-freeze`
- Lane packet revision: `phase-01-p1-f-freeze-r3`
- Router revision: `phase-01-p1-f-environment-router-r3`
- Router authoring base: `69c4219b7ce3c7ad99e469ecd537a42e4bb4d2b5`
- Accepted true-merge SHA: `20706bd067ce5ccbf13697700411904faa2a00c8`
- Accepted P1.I integration commit: `134f64f0c5c7bbbab0552eddf08df1508118f4bb`
- Canonical merge second parent: `6bf43f140878f8b79f7ee17349bd21b177df901d`
- Evidence IDs: `P1.F.FREEZE` and `P1.F.PHASE_EXIT`
- Required worker profile: `gpt-5.6-sol`, `xhigh`, `serviceTier: "default"`; Fast is prohibited
- Root role: sole orchestrator
- Durable controller: `controller-v17`, `HOLD`, observation-only
- Terminal state after every authorized attempt: `HOLD`

P1.I received independent `ACCEPT` with P0/P1/P2 `0/0/0`. Attempt
`agent-teams-hosted-web-refactor-p1-i-integration-apply-v17-r2` integrated its exact five outputs in
`134f64f0c5c7bbbab0552eddf08df1508118f4bb^..134f64f0c5c7bbbab0552eddf08df1508118f4bb`.
Canonical `20706bd067ce5ccbf13697700411904faa2a00c8` is the accepted ordered two-parent PR #252 merge
where `20706bd067ce5ccbf13697700411904faa2a00c8^1` equals
`134f64f0c5c7bbbab0552eddf08df1508118f4bb` and the second parent is
`6bf43f140878f8b79f7ee17349bd21b177df901d`. The five P1.I output bytes are identical at the
integration commit and canonical merge. The second-parent-to-merge diff is accumulated current-base
history and never the exact P1.I proof.

Immutable r1 patch `2f7338a1e7b41955d15106f5fb3994b17db6749158bde8134a0a8e23d2081615` was independently
`REJECT`ed with exactly one P1 finding for using the second-parent diff as the five-output P1.I proof.
This r2 lane preserves every other useful r1 requirement and corrects only that proof.

The r2 patch `1b9d824436f076f751df91fe2d8abedb88995c5fe8a02f3fc0194921d669d5c1` received independent
`ACCEPT` with P0/P1/P2 `0/0/0`, and integration attempt `p1-f-router-r2-accepted-20260716` integrated
and pushed its exact seven paths as `69c4219b7ce3c7ad99e469ecd537a42e4bb4d2b5`. Three later P1.F
attempts started clean at that authority, wrote neither output, and ended `HOLD`: the network-disabled
worker could not query the remote and its sandbox could not spawn the normalizer child (`EPERM`). This
r3 lane changes only those environment-incompatible evidence routes. It does not relax a P1.F gate.

This lane authorizes exactly one serial, fresh, independent milestone-freeze worker. It verifies the
integrated Phase 1 result at the current router authority, writes only two freeze records, returns an
explicit `ACCEPT` or `REJECT`, and ends `HOLD`. It does not repeat P1.I, change product/test/runtime
source, launch a reviewer, integrate output, or start Phase 2.

This router author starts nothing. A new worker cannot start until the exact seven-path r3 router is
independently accepted, broker-integrated, pushed, and root binds the broker-returned pushed commit as
`postRouterIntegrationAuthoritySha` with both required immutable evidence inputs.

## Exact mandatory reads

Read in this order. Directory reads, globs, recursive research reads, rejected-job materialization,
implicit siblings, real-project reads, and the whole master plan are not authorized:

1. `AGENTS.md`
2. `docs/hosted-web-phases/START_HERE.md`
3. `docs/hosted-web-phases/EVIDENCE_LIFECYCLE.md`
4. `docs/hosted-web-phases/README.md`
5. `docs/hosted-web-phases/EXECUTION_INDEX.json`
6. `docs/hosted-web-phases/phase-01/controller-packet.md`
7. this lane packet
8. `CLAUDE.md`
9. `AGENT_CRITICAL_GUARDRAILS.md`
10. `docs/FEATURE_ARCHITECTURE_STANDARD.md`
11. `docs/hosted-web-phases/PACKET_STANDARD.md`
12. `docs/hosted-web-phases/phase-01/README.md`
13. `docs/hosted-web-phases/phase-01/execution-dag.md`
14. `docs/hosted-web-phases/phase-01/architecture-and-contracts.md`
15. `docs/hosted-web-phases/phase-01/conformance-and-tests.md`
16. `docs/hosted-web-phases/phase-01/operations-and-risk.md`
17. `docs/hosted-web-phases/phase-01/packet-inputs.md`
18. historical `docs/hosted-web-phases/phase-01/lanes/p1-i-integration.md`, read-only
19. the exact 74 paths in `EXECUTION_INDEX.json.phase1FreezeManifest.paths`, in exact order

Before reading the first manifest path, validate that the array contains exactly 74 distinct existing
paths and its UTF-8 compact JSON-array SHA-256 is
`0e8e2b82125eb3b8e559f9fa439e8942e0eea89d75da4cccc35d75099e868223`. Nothing nearby becomes an
input implicitly.

## Independence and start gate

The worker must be fresh and independent of:

- this P1.F router author and its independent router reviewer;
- every P1.I producer, remediation producer, reviewer, and integration actor;
- `agent-teams-hosted-web-refactor-p1-i-integration-apply-v17-r2`; and
- every earlier Phase 1 producer and reciprocal reviewer.

Root captures one immutable pre-start snapshot proving:

1. this exact seven-path r3 router is independently accepted, broker-integrated, and pushed;
2. `postRouterIntegrationAuthoritySha` is the exact broker-returned pushed commit and equals local
   `HEAD`, admission `expectedSourceCommit`, and all handoff authority fields;
3. the worktree is clean and a fresh immutable root/broker remote attestation proves the sole explicit
   remote ref equals that SHA with exact command, exit `0`, one-ref output, timestamp, root/broker
   provenance, and content hash;
4. `69c4219b...` is an ancestor of the pushed r3 router authority and the diff from it is exactly the
   seven router-owned paths; `20706bd...` remains the accepted immutable true-merge provenance;
5. historical `p1-i-integration.md` and the five accepted P1.I outputs remain byte-identical;
6. both P1.F output paths are absent;
7. no P1.F worker, remediation worker, Phase 2 worker/router, unrelated worker, or successor controller
   is active;
8. dependencies are broker-materialized offline and worker install/fetch/update is disabled; and
9. admission uses exactly the required default-only profile; and
10. root ran the exact normalizer command at the same clean pushed authority and the broker captured a
    fresh immutable root-attested normalizer record containing command, timestamps, runner provenance,
    normalizer exit `0`, compiler exit `2`, passing structured JSON, the exact seven inherited
    diagnostics, zero resolved/unexpected diagnostics, no unparsed output, and capture hashes.

Any mismatch ends `HOLD` without launch. Root uses this admission shape:

```text
operation: codex_goal_project_refill_worker
workerRole: reviewer
reviewKind: review
node: P1.F
model: gpt-5.6-sol
reasoningEffort: xhigh
serviceTier: default
sourceRemote: origin
sourceBranch: refactor/hosted-web-feature-boundaries
expectedSourceCommit: <postRouterIntegrationAuthoritySha>
preStartAdmission.mode: serial-builtin
preStartAdmission.contract.kind: worker-launch
preStartAdmission.contract.format: 1
preStartAdmission.contract.canonicalSha: <postRouterIntegrationAuthoritySha>
preStartAdmission.contract.baseSha: <postRouterIntegrationAuthoritySha>
preStartAdmission.contract.phaseStartSha: <postRouterIntegrationAuthoritySha>
preStartAdmission.contract.packetRevision: phase-01-p1-f-freeze-r3
preStartAdmission.contract.controllerPacket: docs/hosted-web-phases/phase-01/controller-packet.md
preStartAdmission.contract.lanePacket: docs/hosted-web-phases/phase-01/lanes/p1-f-freeze.md
preStartAdmission.contract.phaseId: phase-01
preStartAdmission.contract.laneId: p1-f-freeze
preStartAdmission.contract.inputPatchHash: null
preStartAdmission.contract.reviewKind: review
```

No fallback model, alternate tier, Fast mode, concurrent worker, retry, refill, worker-spawned
reviewer, moving source ref, or P1.I replay is authorized. The normalizer record is ineligible unless
the reviewer records that its sandbox could not spawn the exact command. Neither attestation grants
network access, bypasses a gate, or permits generic root substitution for local review.

## Exact ownership

The P1.F worker owns exactly these two paths, in writer order:

1. `.codex-handoff/phase-01-p1-f.json`
2. `docs/research/hosted-web/phase-1/reviews/phase-1-freeze.md`

The exact 74 manifest paths are read-only. In particular, these five frozen P1.I outputs may not be
rewritten, reformatted, regenerated, repaired, copied over, or reintegrated:

1. `.codex-handoff/phase-01-p1-i.json`
2. `docs/research/hosted-web/phase-1/decision-register.json`
3. `docs/research/hosted-web/phase-1/estimate-reconciliation.json`
4. `docs/research/hosted-web/phase-1/evidence-index.json`
5. `docs/research/hosted-web/phase-1/integration-report.json`

There is no product, test, fixture, runtime, packet, dependency, config, package, lockfile, registry,
repository-temporary-output, compile-coherence, cleanup, P1.I, or third-path exception.

## Canonical ancestry, remote, and merge proof

The worker independently performs every bounded, read-only, sandbox-compatible repository observation
required here. No checkout, reset, rebase, fetch, stage, commit, merge, push, apply in the repository
worktree, repository-index mutation, or network enablement is authorized.

Remote equality remains mandatory. Root runs exactly:

```bash
git ls-remote origin refs/heads/refactor/hosted-web-feature-boundaries
```

The broker must capture after r3 integration/push the exact command, exit `0`, exact one-ref output,
remote/ref, observed SHA, clean local `HEAD`, broker-returned commit, ISO-8601 timestamp, root actor and
tool provenance, and content SHA-256. All SHA fields must equal
`postRouterIntegrationAuthoritySha`. The record must postdate the push and becomes stale after any
later remote, authority, or worktree change. This fresh immutable root/broker remote attestation is an
authoritative reviewer input. The reviewer validates every field and capture hash. Upstream-tracking
state, a moving branch, a copied summary, or an earlier attestation is not evidence.

MUST NOT run `git ls-remote` from the restricted worker sandbox

The reviewer independently proves all sandbox-compatible local facts:

1. `HEAD` equals `postRouterIntegrationAuthoritySha` and descends from the r3 authoring base
   `69c4219b7ce3c7ad99e469ecd537a42e4bb4d2b5`.
2. The worktree is clean; local `HEAD`, admission `expectedSourceCommit`, all authority fields, and the
   inspected remote-attestation SHA are identical.
3. The exact path diff in
   `134f64f0c5c7bbbab0552eddf08df1508118f4bb^..134f64f0c5c7bbbab0552eddf08df1508118f4bb`
   is the five frozen P1.I outputs in writer order after deterministic path ordering.
4. Accepted true merge `20706bd067ce5ccbf13697700411904faa2a00c8` has exactly two parents in
   order: first parent `134f64f0c5c7bbbab0552eddf08df1508118f4bb`, second parent
   `6bf43f140878f8b79f7ee17349bd21b177df901d`.
5. `20706bd067ce5ccbf13697700411904faa2a00c8^1` equals
   `134f64f0c5c7bbbab0552eddf08df1508118f4bb`.
6. Both parents are ancestors of `20706bd...`; the commit is not squash, one-parent, octopus, or
   reversed-parent history.
7. Each of those five paths at `20706bd...` is byte-identical to the same path at `134f64f...`.
8. The second-parent-to-merge diff is accumulated current-base history. It is never used or reported
   as the exact five-output P1.I integration proof.
9. The exact path diff from `69c4219b...` to `postRouterIntegrationAuthoritySha` is the seven router
   paths in `EXECUTION_INDEX.json.routerExclusiveOwnership`; no P1.I or product/test path changed.

Any ambiguity, stale or malformed remote attestation, extra parent/path, missing ancestry, remote
drift, or byte difference is a P0/P1 finding and forces `REJECT`/`HOLD`. The root/broker remote
attestation replaces only the sandbox-incompatible network observation, never a local independent
proof.

## Exact 74-path and P1.I byte proof

Resolve `freeze_paths` only from `EXECUTION_INDEX.json.phase1FreezeManifest.paths`. Require 74 paths,
74 distinct values, all existing regular UTF-8 text files, and no symlink or NUL byte. The first 69
paths must exactly match the ordered `canonicalInputManifest.entries[].path` in the frozen P1.I
evidence index. Recompute every corresponding entry SHA-256 and require all 69 bytes to match the
recorded hashes.

The last five paths must be the exact P1.I outputs in writer order proven by the integration range
above. Their required SHA-256 values at `134f64f...`, `20706bd...`, and the current worker authority
are:

| Path                                                            | SHA-256                                                            |
| --------------------------------------------------------------- | ------------------------------------------------------------------ |
| `.codex-handoff/phase-01-p1-i.json`                             | `be6ca8a01fba06871b9246ae2baaf230e7b95222bb0da3eec8548016c5639903` |
| `docs/research/hosted-web/phase-1/decision-register.json`       | `1d275a95a189d7840a6d75591d90c138b0ec5399747db41794697de0cde32ba9` |
| `docs/research/hosted-web/phase-1/estimate-reconciliation.json` | `941c58195b9955b9807b896aedf7f46ea1a4ed455dc6713241ffefb074405328` |
| `docs/research/hosted-web/phase-1/evidence-index.json`          | `07a17cb6674916f65713e337f15deeb3f5405d36fbcccbbcdada3b5895724590` |
| `docs/research/hosted-web/phase-1/integration-report.json`      | `a64cc23427dd049e0ede0ce217a7401a5ec6f6df51ec6cb9b5ca3ef5458f4e8f` |

Compute and record a fresh SHA-256 for every one of the 74 current files and a compact JSON digest of
the ordered `{path, sha256}` manifest. A hash mismatch or path-order drift forces `REJECT`.

## Exact evidence and lifecycle proof

The worker validates the frozen evidence index against `EVIDENCE_LIFECYCLE.md`. The exact 14 Phase 1
acceptance evidence IDs, in order, are:

1. `P1.S0.BASELINE`
2. `P1.S0.BOOTSTRAP`
3. `P1.1A.KERNEL`
4. `P1.1A.VERSION`
5. `P1.1B.ROUTES`
6. `P1.1B.CAPABILITIES`
7. `P1.1C.CONFORMANCE`
8. `P1.1C.RATCHETS`
9. `P1.R1.ARCH_REVIEW`
10. `P1.1D.TEAM_LIFECYCLE_READ_CONTRACT`
11. `P1.1D.TEAM_LIFECYCLE_READ_USE_CASE`
12. `P1.1D.TEAM_LIFECYCLE_SEMANTIC_PROOF`
13. `P1.R2.SEMANTIC_REVIEW`
14. `P1.NEG.RATCHET_REGRESSION`

Require exactly these 14 IDs once each, with valid paths and current content hashes. Also require the
accepted lint-remediation provenance ID `P1.I.LINT.REMEDIATION` and both P1.I result IDs
`P1.I.INTEGRATION` and `P1.I.ROLLBACK`, producing exactly 17 distinct frozen catalog rows and no
unknown ID. Preserve the P1.I index bytes: the independent P1.I acceptance and integration records
are external adoption evidence and do not authorize rewriting `pending` fields inside that immutable
output.

The two new P1.F artifacts record only `P1.F.FREEZE` and `P1.F.PHASE_EXIT`. They must not claim to
have mutated the frozen evidence index or superseded an existing evidence row.

## Required quality and gate reruns

Rerun and capture exact command, exit code, duration, tool version, and final result for every
sandbox-compatible command:

```bash
pnpm exec vitest run test/features/team-lifecycle test/architecture/hosted-web/phase-1
pnpm exec vitest run test/architecture/hosted-web/phase-1/parity/parity-references.test.ts
node scripts/hosted-web/phase-0/final-gate/normalize-typescript-diagnostics.mjs --mode milestone
pnpm lint
pnpm exec prettier --check "${freeze_paths[@]}"
```

Required exact results:

- Phase 1 plus team-lifecycle Vitest: 13/13 files and 60/60 tests;
- focused ratchet Vitest: 1/1 file and 3/3 tests;
- native TypeScript: seven exact inherited diagnostics, zero resolved drift, and zero unexpected;
- full lint: exit `0` with zero errors; and
- pinned Prettier: exit `0` with exactly 74 matched paths.

The worker first runs the exact normalizer command locally. If it spawns, its local structured JSON is
the only admissible typecheck result. The capture must classify the normalizer process as `exited` with
exit `0`; the report must have `passed: true`, compiler `rawExitCode: 2`,
`observedDiagnosticCount: 7`, `normalizedInheritedCount: 7`, `resolvedInheritedCount: 0`,
`effectiveDiagnosticCount: 0`, empty unexpected/resolved/unparsed arrays, no signal or runner error,
and the exact file, code, line, column, and normalized message set in the checked-in baseline.

If and only if the restricted sandbox cannot spawn that exact command, the worker records the local
command, attempted timestamp, process disposition, error code/message, and absence of a valid local
report. It may then use the fresh immutable root-attested normalizer input captured at the identical
worker authority. It independently inspects the exact command, root execution start/completion
timestamps, root/broker actor and tool provenance, clean authority binding, stdout/stderr and record
hashes, normalizer exit `0`, compiler exit `2`, all structured fields above, and all seven diagnostics.
A failed root command, stale authority, incomplete provenance, hash mismatch, different command,
changed diagnostic, unparsed output, or use without a local sandbox spawn failure fails the gate.

This bounded exception is not a bypass, network enablement, or generic root substitution. The worker
must independently execute the two Vitest commands, full lint, exact-74 and exact-two Prettier, every
local Git/ancestry/diff/hash/link/scan proof, and every other sandbox-compatible check. After both P1.F
outputs are final, run a separate exact-two-path Prettier check over them; it does not widen or replace
the required exact-74 proof.

Independently validate every one of the 14 gate IDs in `EXECUTION_INDEX.json.requiredGateIds`. A gate
passes only from its current rerun or exact declared structural proof; a P1.I record alone is not a
substitute for current evidence.

## Rollback and current-base proof

Reperform the exact 54-path scratch-only rollback proof using
`EXECUTION_INDEX.json.rollbackPayload.paths` in declared order. Require 54 distinct paths, all absent
at bootstrap `5f30df49e052d1cc1d0e7efd03aa105673b5b614`, and generate the binary/full-index delta from that
bootstrap to `20706bd...` for only those paths.

In a newly created external scratch directory, never the repository or a real project:

1. apply-check and apply the forward patch;
2. prove all 54 resulting files are byte-identical to `20706bd...`;
3. reverse-check and reverse-apply the same patch; and
4. prove all 54 paths are absent again.

Record the ordered path-manifest hash, patch hash, all apply exit codes, 54/54 forward byte equality,
54/54 reverse absence, `scratchOnly: true`, and `workspaceApply: false`. Cleanup is limited to the
marker-owned scratch directory. Separately record the ordered-parent/current-base proof and the exact
P1.I integration-range proof above; the accumulated second-parent diff and rollback substitute for
neither.

## JSON, hash, link, diff, and classified scans

After the two outputs are final, define `candidate_paths` as the exact 74 manifest paths followed by
the exact two outputs. Require 76 distinct paths. Perform and record:

1. JSON parse of every `.json` path, rejection of duplicate keys where the parser supports it, and
   declared-schema/required-field validation for the five P1.I and two P1.F records.
2. SHA-256 verification of all 74 frozen inputs, both new outputs, the historical P1.I lane packet,
   and the current controller/lane packet hashes recorded in the execution index.
3. Local Markdown-link resolution for every `.md` path; ignore only empty anchors and explicit URI
   schemes. Every repository-relative target must exist.
4. Read-only diff/scope proof: no staged path, no tracked change, exactly the two P1.F outputs
   untracked, exactly two status paths, and no product/test/P1.I byte change.
5. `git diff --check` success and a complete reread of both output diffs/content.
6. UTF-8, NUL, symlink, regular-file, and MIME classification over all 76 paths.
7. Classified scans over all 76 paths for secret/credential terms and values, auth/provider payloads,
   private user/home paths, real-project names, task-temporary paths, raw command/runtime bodies,
   binary content, and unresolved placeholders.
8. Schema, content-hash, timestamp/freshness, authority-binding, and provenance validation of the
   immutable root/broker remote attestation and root-attested normalizer record; the latter is used as
   gate evidence only after a recorded local sandbox spawn failure.

The exact scan families include:

```bash
rg -n -i '(api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|bearer|cookie|authorization)' "${candidate_paths[@]}"
rg -n -i '(provider|anthropic|claude|openai|opencode|gpt-[0-9])' "${candidate_paths[@]}"
rg -n '(/Users/|/home/|/root/|/tmp/|~/|[A-Za-z]:\\Users\\|real[-_ ]project)' "${candidate_paths[@]}"
```

Fixture canaries, repository-relative control paths, required profile metadata, hashes, scan-command
text, historical provenance, and explicit prohibited-action language are expected control text, but
every match must still be classified. Any real credential, auth/provider payload, private or real-
project path, raw sensitive body, binary, unexplained placeholder, or unclassified match fails.

## Freeze report, handoff, and self-review

`docs/research/hosted-web/phase-1/reviews/phase-1-freeze.md` is the human-reviewable P1.F freeze record.
It contains:

1. authority, inspected root/broker remote attestation, independently executed local ancestry,
   exact-five P1.I integration range, ordered parents, first-parent equality, accumulated current-base
   history classification, and exact-seven router diff proof;
2. immutable P1.I independent acceptance/integration provenance and all five byte hashes;
3. the exact 74-path manifest digest and 74 current content hashes;
4. all 14 Phase 1 evidence IDs, both P1.I evidence IDs, lint-remediation provenance, and lifecycle
   validation;
5. all 14 gate IDs with exact current proof;
6. 60-test, three-ratchet-test, 7/0/0 typecheck, exact normalizer evidence source plus any local spawn
   failure, lint, exact-74 and exact-two Prettier results;
7. exact-54 rollback and current-base proofs;
8. JSON/hash/link/diff/scope/text and classified scan results;
9. complete P0/P1/P2 findings with explicit `ACCEPT` or `REJECT` rationale;
10. explicit Phase 1 phase-exit conclusion and the unverified later-phase claims; and
11. `HOLD`, with Phase 2 blocked and no integration or successor claim.

`.codex-handoff/phase-01-p1-f.json` follows `PACKET_STANDARD.md` and records:

- schema, phase/node/lane, packet/router revision, all authority SHAs and ordered parents;
- status, explicit disposition, P0/P1/P2 finding counts, the two evidence IDs, and exact two
  `changedPaths` in writer order;
- exact 74-path manifest count/digest, 74 content hashes, and five frozen P1.I output hashes;
- evidence/lifecycle and 14-gate summaries;
- every exact check, the remote-attestation inspection, the conditional normalizer-attestation
  inspection and evidence source when eligible, any local spawn failure, rollback, merge,
  JSON/hash/link/diff and scan result;
- complete self-review, unverified claims, blockers, and immutable findings;
- no claim of broker integration, pushed P1.F evidence, Phase 2 authority, or successor launch; and
- conditional next action plus terminal `HOLD`.

Before returning, the worker rereads both complete outputs and all observed diffs. Self-review must
explicitly confirm independence, exact authority, complete remote-attestation inspection, conditional
normalizer-attestation inspection when eligible, the bounded normalizer rule, independent execution of
every sandbox-compatible local check, all 74 frozen bytes, all evidence/gates, all check counts,
rollback/current-base proof, scan classifications, exact-two ownership, no P1.I/product/test change,
no unsupported claim, and finding counts.

## Explicit disposition and lifecycle boundary

If every required proof passes and finding counts are exactly P0/P1/P2 `0/0/0`, return exactly:

```text
P1_F_FREEZE_RESULT {"disposition":"ACCEPT","evidenceIds":["P1.F.FREEZE","P1.F.PHASE_EXIT"],"findingCounts":{"P0":0,"P1":0,"P2":0},"reviewedPathCount":74,"changedPathCount":2,"integrationPathCount":2,"nextAction":"broker-integrate-freeze-evidence","terminalState":"HOLD"}
```

Any substantiated finding returns `REJECT` with the same schema, nonzero finding counts, immutable
finding details in both outputs, and `nextAction: "bounded-two-path-remediation"`. Admission,
environment, authority, toolchain, or missing-result incidents that prevent a review return `HOLD`
without fabricating `REJECT`.

On `ACCEPT`, root mechanically validates the strict result and may call `mark_reviewed`; only then may
the broker integrate and push exactly the two outputs in writer order. The worker has no integration
authority. On `REJECT`, root may not mark reviewed and no integration or Phase 2 router may follow.
Only a separately admitted remediation confined to the same two paths and immutable findings is
permitted, followed by fresh independent verification.

Phase 2 remains blocked until P1.F `ACCEPT`. That acceptance is necessary but not sufficient: only
after accepted exact-two integration and a new exact pushed-authority/clean remote-equality
attestation may root separately commission a Phase 2 JIT docs router. That is not a Phase 2 worker
launch and grants no product authority. Phase 2 remains blocked until its separate router is authored,
independently accepted, integrated, pushed, and explicitly activated.

## Stop conditions and HOLD

Stop and end `HOLD` on authority/profile/independence drift, extra/missing path or parent,
stale/incomplete/mismatched attestation, remote mismatch, any sandbox remote query, normalizer root
substitution without a recorded sandbox spawn failure, P1.I byte drift, evidence or lifecycle mismatch,
any gate/test/typecheck/lint/format failure, rollback/current-base failure,
JSON/hash/link/diff/scope mismatch, unsafe or unclassified scan match, binary/symlink/NUL content,
false output field, incomplete self-review, early integration, or unsupported successor claim.

No current action authorizes P1.I repetition, product/test/runtime edits, real-project access,
dependency install/fetch/update, registry writes, app/server/team/provider flows, stage, commit, merge,
push, raw Git integration, worker-spawned review, controller replacement, successor controller, Phase
2 router authoring, or Phase 2 work. The router author performs none of those actions and ends `HOLD`.
