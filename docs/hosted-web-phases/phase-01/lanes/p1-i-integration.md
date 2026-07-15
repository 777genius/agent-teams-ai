# P1.I lint remediation and integration lane

## Authority and provenance

- Project: `agent-teams-hosted-web-refactor`
- Phase: `phase-01`
- Current node: `P1.I.LINT.REMEDIATION`
- Serial successor: `P1.I.INTEGRATION`
- Lane packet revision: `phase-01-p1-i-integration-r2`
- Router revision: `phase-01-p1-i-lint-remediation-router-r1`
- Router `packetBaseSha`: `0d7f904abf2a3d4eaf7ba4e16ebd987d473535fe`
- Remediation evidence ID: `P1.I.LINT.REMEDIATION`
- Downstream evidence IDs: `P1.I.INTEGRATION` and `P1.I.ROLLBACK`
- Profile for every producer and reviewer: `gpt-5.6-sol`, `xhigh`,
  `serviceTier: "default"`; Fast is prohibited
- Root role: sole orchestrator
- Durable controller: `controller-v17`, `HOLD`, observation-only
- Terminal state after every authorized attempt: `HOLD`

The canonical authority is clean and remotely pushed. Its full `pnpm lint` result has exactly one
error and no other lint finding:

```text
src/shared/contracts/hosted/app-error.ts:29:65
@typescript-eslint/no-unnecessary-type-assertion
```

The redundant expression is the `as string` assertion in the validated `diagnosticId` projection.
This lane inserts one exact product remediation before the existing P1.I evidence-freeze producer.

This router author starts nothing. No worker starts until the router has independent acceptance,
broker integration and push, and root has immutably bound the exact broker-returned pushed commit as
`postRouterIntegrationAuthoritySha`, proved a clean worktree, and attested equality to the sole result
of `git ls-remote origin refs/heads/refactor/hosted-web-feature-boundaries`.

## Exact mandatory reads

Read in this order. Directory reads, globs, recursive research reads, implicit siblings, and the whole
master plan are not authorized:

1. `AGENTS.md`
2. `docs/hosted-web-phases/START_HERE.md`
3. `docs/hosted-web-phases/EVIDENCE_LIFECYCLE.md`
4. `docs/hosted-web-phases/README.md`
5. `docs/hosted-web-phases/EXECUTION_INDEX.json`
6. `docs/hosted-web-phases/phase-01/controller-packet.md`
7. `docs/hosted-web-phases/phase-01/lanes/p1-i-integration.md`
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
18. the exact 68 paths in `EXECUTION_INDEX.json.phase1CanonicalInputs`, in exact group and path order

The index must be expanded and validated as 68 distinct existing paths before reading the first
manifest path. Nothing nearby becomes an input implicitly.

## P1.I.LINT.REMEDIATION start gate

Root must capture one immutable pre-start snapshot proving:

1. this exact seven-path router is independently accepted, broker-integrated, and pushed;
2. `postRouterIntegrationAuthoritySha` is the exact broker-returned pushed commit and equals local
   `HEAD`, admission `expectedSourceCommit`, and the worker contract authority fields;
3. the worktree is clean and the explicit remote ref equals that SHA;
4. the original 68 Phase 1 input paths are present and unchanged from
   `0d7f904abf2a3d4eaf7ba4e16ebd987d473535fe`;
5. `.codex-handoff/phase-01-p1-i-lint-remediation.json` is absent;
6. full-lint baseline evidence is exactly the one diagnostic above;
7. no remediation producer/reviewer, P1.I producer/reviewer, P1.F, Phase 2+, unrelated product worker,
   or successor controller is active;
8. dependencies are broker-materialized offline and worker install/fetch/update is disabled; and
9. admission uses the exact default-only profile.

Any mismatch ends `HOLD` without launch. Root uses this admission shape:

```text
operation: codex_goal_project_refill_worker
workerRole: producer
node: P1.I.LINT.REMEDIATION
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
preStartAdmission.contract.packetRevision: phase-01-p1-i-integration-r2
preStartAdmission.contract.controllerPacket: docs/hosted-web-phases/phase-01/controller-packet.md
preStartAdmission.contract.lanePacket: docs/hosted-web-phases/phase-01/lanes/p1-i-integration.md
preStartAdmission.contract.phaseId: phase-01
preStartAdmission.contract.laneId: p1-i-lint-remediation
preStartAdmission.contract.inputPatchHash: null
preStartAdmission.contract.reviewKind: implementation
```

No fallback model, tier substitution, Fast mode, concurrent worker, retry, refill, producer-side
reviewer launch, network query, or moving source ref is authorized.

## Exact remediation ownership and edit

The product worker owns exactly these three paths, in this order:

1. `src/shared/contracts/hosted/app-error.ts`
2. `test/architecture/hosted-web/phase-1/contracts/app-error.test.ts`
3. `.codex-handoff/phase-01-p1-i-lint-remediation.json`

The source edit is exactly:

```diff
-    ...(input.diagnosticId === undefined ? {} : { diagnosticId: input.diagnosticId as string }),
+    ...(input.diagnosticId === undefined ? {} : { diagnosticId: input.diagnosticId }),
```

No other source token, assertion, branch, validation rule, error code, reason grammar, diagnostic
grammar, retry rule, projection key, freeze behavior, return type, import, export, or formatting may
change.

The test file adds one focused regression which proves all of the following together:

- a valid `diagnosticId` survives `createSafeAppError` unchanged;
- the returned safe error is frozen and contains only the expected known fields;
- an unsafe diagnostic ID still rejects with the existing safe-error failure behavior; and
- no raw message, transport field, retry rule, or `AppErrorCode` semantic changes.

The worker may not edit fixtures because the regression uses inline synthetic values. No fourth path,
temporary repository output, generated file, cache, dependency, config, lockfile, router, review,
P1.I output, registry entry, or real-project path is authorized.

## Required remediation checks

Run the focused regression:

```bash
pnpm exec vitest run test/architecture/hosted-web/phase-1/contracts/app-error.test.ts
```

Acceptance is exactly 1/1 file and 2/2 tests.

Run full lint, never the fast substitute or a writer/fix command:

```bash
pnpm lint
```

Acceptance is exit `0` with zero errors. Run the frozen native typecheck:

```bash
pnpm typecheck
```

It may exit `1` only for these exact inherited Phase 0 diagnostics:

- `auth-artifacts-spike.test.ts`: TS7016 at 25:8; TS7031 at 66:31; TS18046 at 117:68;
  TS7031 at 413:48; TS7031 at 733:10;
- `evidence-scanner.test.ts`: TS7016 at 12:8; and
- `scan-runtime-surfaces.test.ts`: TS2352 at 162:44.

Acceptance is exactly seven inherited, zero owned, and zero unexpected diagnostics. A removed, moved,
changed, or additional diagnostic fails closed.

After the handoff is final, run exact three-path Prettier:

```bash
pnpm exec prettier --check \
  src/shared/contracts/hosted/app-error.ts \
  test/architecture/hosted-web/phase-1/contracts/app-error.test.ts \
  .codex-handoff/phase-01-p1-i-lint-remediation.json
```

Formatting writers are prohibited.

Read-only Git is authorized only for these provenance, diff, and scope observations; staging,
checkout, apply, commit, merge, push, reset, integration, or index mutation is forbidden:

```bash
test "$(git rev-parse HEAD)" = "$postRouterIntegrationAuthoritySha"
git diff --check
git diff --cached --quiet
git diff --name-only "$postRouterIntegrationAuthoritySha" -- \
  src/shared/contracts/hosted/app-error.ts \
  test/architecture/hosted-web/phase-1/contracts/app-error.test.ts
git ls-files --others --exclude-standard
git status --short
```

The tracked diff must contain exactly the source and test in the declared order, the untracked set
must contain only the handoff, the staged set must be empty, and status must resolve to exactly three
paths. The source diff must equal the one-line assertion deletion above; the test diff must be only the
focused regression.

Scan the exact same three paths and classify every match:

```bash
remediation_paths=(
  src/shared/contracts/hosted/app-error.ts
  test/architecture/hosted-web/phase-1/contracts/app-error.test.ts
  .codex-handoff/phase-01-p1-i-lint-remediation.json
)
test "${#remediation_paths[@]}" -eq 3
rg -n -i '(api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|bearer|cookie|authorization)' "${remediation_paths[@]}"
rg -n -i '(provider|anthropic|claude|openai|opencode|gpt-[0-9])' "${remediation_paths[@]}"
rg -n '(/Users/|/home/|/root/|/tmp/|~/|[A-Za-z]:\\Users\\|real[-_ ]project)' "${remediation_paths[@]}"
file --mime-type "${remediation_paths[@]}"
```

Required model/profile metadata, repository-relative paths, synthetic unsafe values, and the recorded
scan command are control text, not payload values, but still require classification. Any real secret,
auth/provider payload, private/real-project/task-temporary path, raw command/runtime body, or binary
file fails.

## Remediation handoff and self-review

`.codex-handoff/phase-01-p1-i-lint-remediation.json` follows `PACKET_STANDARD.md` and records:

1. schema, phase, node, lane, packet/router revision, evidence ID, and terminal `HOLD`;
2. `baseSha`, `canonicalSha`, `planBundleCommit`, `phaseStartSha`, and `headSha`, all equal to
   `postRouterIntegrationAuthoritySha`;
3. the exact three `changedPaths` in writer order and SHA-256 for both non-handoff changed files;
4. the exact baseline lint diagnostic and exact post-edit full-lint zero result;
5. focused Vitest 1/2, typecheck 7/0/0, Prettier, diff, scope, scan, and binary results;
6. explicit confirmation that only the redundant assertion was removed and `AppError` semantics were
   preserved;
7. explicit self-review of the source diff, focused regression, output hashes, writer scope, frozen
   typecheck baseline, and zero-lint result;
8. no claim of independent acceptance, integration, or P1.I completion; and
9. `nextAction: "independent-verification"` and `terminalState: "HOLD"`.

Before returning, the producer rereads both tracked diffs and the complete handoff. Any ambiguity,
scope expansion, missing classification, semantic change, gate failure, or unsupported claim ends
`HOLD` with no self-repair outside the three paths.

The strict producer result is:

```text
P1_I_LINT_REMEDIATION_PRODUCER_RESULT {"status":"VERIFIED","evidenceId":"P1.I.LINT.REMEDIATION","changedPathCount":3,"fullLintErrorCount":0,"nextAction":"independent-verification","terminalState":"HOLD"}
```

`VERIFIED` is legal only when every gate passes. On failure, replace only `status` with `BLOCKED` or
`FAILED`. The result plus broker-captured immutable bytes/hashes for all three paths is required;
heartbeat, PID, tmux, changed-file notice, or provider observation is insufficient.

## Independent remediation review

After producer termination and immutable three-path capture, root proves no remediation producer or
reviewer is active and prepares exactly one fresh independent reviewer:

```text
operation: codex_goal_project_prepare_verifier
workerRole: reviewer
reviewScope: P1.I.LINT.REMEDIATION
model: gpt-5.6-sol
reasoningEffort: xhigh
serviceTier: default
sourceRemote: origin
sourceBranch: refactor/hosted-web-feature-boundaries
expectedSourceCommit: <postRouterIntegrationAuthoritySha>
inputPatchHash: <brokerCapturedRemediationImmutableOutputHash>
reviewKind: review
```

The reviewer is fresh and independent of the router author, producer, and prior Phase 1 workers. It is
read-only over the exact three candidate paths plus the execution documents needed to evaluate them.
It has no writer, repair, lifecycle, integration, retry, refill, network, provider, runtime,
agent-flow, registry, or real-project authority. It independently inspects the exact source/test diff,
reruns focused Vitest, full lint, frozen typecheck, exact Prettier and scans, validates the handoff and
self-review, and returns exactly one immutable result:

```text
P1_I_LINT_REMEDIATION_REVIEW_RESULT {"disposition":"ACCEPT","findingCounts":{"P0":0,"P1":0,"P2":0},"reviewedPathCount":3,"integrationPathCount":3,"fullLintErrorCount":0,"terminalState":"HOLD"}
```

`ACCEPT` requires complete proof and zero P0/P1/P2 findings. `REJECT` uses the same schema with
nonzero finding counts and immutable finding details. Admission, provider, environment, or
missing-result incidents remain `HOLD` and are not synthetic `REJECT`.

On `ACCEPT`, root may mechanically call `mark_reviewed`; only then may the broker integrate and push
exactly the three paths in writer order. On `REJECT`, root may not mark reviewed, the broker may not
integrate, and P1.I may not start. The only permitted follow-up is a separately admitted bounded
remediation addressing the immutable findings within these same three paths and the same default-only
profile. It grants no broad cleanup, unrelated edit, direct retry, or integration authority.

## Direct P1.I.INTEGRATION continuation

After accepted remediation integration, root resolves the exact broker-returned pushed commit as
`postRemediationIntegrationAuthoritySha` and proves:

1. clean worktree and exact equality to the explicit remote branch ref;
2. the integration commit changes exactly the three accepted remediation paths;
3. all integrated bytes/hashes equal the independently accepted immutable candidate;
4. the original 68-path Phase 1 manifest is present, with only the two remediation-owned manifest
   paths changed from the pre-remediation snapshot;
5. the accepted remediation handoff is present and makes the P1.I input set 69 distinct paths;
6. all five P1.I outputs are absent; and
7. a fresh `pnpm lint` at `postRemediationIntegrationAuthoritySha` exits `0` with zero errors.

Those facts directly satisfy the new prerequisite for the existing five-output producer. No further
docs router is required. Root then admits one `P1.I.INTEGRATION` producer at
`postRemediationIntegrationAuthoritySha` using the same default-only profile and lane packet revision.

The P1.I producer retains exact output ownership:

1. `.codex-handoff/phase-01-p1-i.json`
2. `docs/research/hosted-web/phase-1/decision-register.json`
3. `docs/research/hosted-web/phase-1/estimate-reconciliation.json`
4. `docs/research/hosted-web/phase-1/evidence-index.json`
5. `docs/research/hosted-web/phase-1/integration-report.json`

Its read-only input set is the 68 paths in `phase1CanonicalInputs`, evaluated at the accepted
remediation authority, followed by
`.codex-handoff/phase-01-p1-i-lint-remediation.json`: 69 distinct inputs. The two remediated source/test
paths must match the accepted candidate; the other 66 original inputs must remain byte-identical to
`0d7f904abf2a3d4eaf7ba4e16ebd987d473535fe`.

The existing 14 P1 gate IDs remain mandatory. Updated exact checks are:

- full Phase 1 plus team-lifecycle Vitest: 13/13 files and 60/60 tests;
- focused ratchet Vitest: 1/1 file and 3/3 tests;
- typecheck: seven inherited, zero owned, zero unexpected;
- full `pnpm lint`: exit `0`;
- Prettier and classified scans: exact 69 inputs plus five outputs, 74 paths;
- scratch-only rollback/apply proof: the same exact 54 payload paths, from P1.S0 to
  `postRemediationIntegrationAuthoritySha`, with forward byte equality and reverse absence;
- diff/scope: exactly five untracked P1.I outputs with no staged or tracked change; and
- decision, estimate, evidence lifecycle, integration report, handoff, self-review, and terminal
  `HOLD` requirements from the accepted P1.I contract.

The P1.I producer strict result remains:

```text
P1_I_PRODUCER_RESULT {"status":"VERIFIED","evidenceIds":["P1.I.INTEGRATION","P1.I.ROLLBACK"],"changedPathCount":5,"nextAction":"independent-verification","terminalState":"HOLD"}
```

After its terminal immutable five-path output, root may start the already authorized one fresh
independent P1.I milestone reviewer. That reviewer is read-only over 69 inputs plus five outputs (74
paths), uses the same default-only profile, and returns `ACCEPT` or `REJECT`. On `ACCEPT`, root may
`mark_reviewed` and the broker may integrate and push exactly the five P1.I outputs. On `REJECT`, no
integration occurs.

## Stop conditions and HOLD

Stop and end `HOLD` on authority drift, profile mismatch, extra/missing path, source edit beyond the
one assertion deletion, unfocused test change, `AppError` semantic drift, focused-test failure, any
lint error, typecheck drift, Prettier failure, staged path, scope/diff mismatch, unsafe or unclassified
scan match, binary output, false handoff field, incomplete self-review, early/concurrent reviewer,
integration before `ACCEPT` and `mark_reviewed`, or unsupported successor claim.

No current action authorizes fetch, install, app/server/runtime/team launch, agent-flow test,
real-project access, registry write, stage, commit, merge, push, raw Git integration, P1.F, Phase 2+,
unrelated product work, controller replacement, or a successor controller. The router author performs
none of those actions and ends `HOLD`.
