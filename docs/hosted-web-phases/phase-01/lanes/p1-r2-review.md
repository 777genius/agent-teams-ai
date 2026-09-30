# P1.R2 list semantics formal review lane

> **Post-freeze amendment (2026-07-16).** The wire request no longer embeds a query context:
> `ListTeamLifecycleRequest` is `{ schemaVersion, cursor, expectedRevision }` and the host passes
> the `QueryContext` to `execute(request, context)` separately. Review criteria below that require
> nested query-context request parsing describe the reviewed pre-fix snapshot.

## Authority and provenance

- Project: `agent-teams-hosted-web-refactor`
- Phase/node: `phase-01` / `P1.R2`
- Lane ID: `p1-r2`
- Packet revision: `phase-01-p1-r2-review-r1`
- Router revision: `phase-01-p1-r2-router-r1`
- Evidence ID: `P1.R2.SEMANTIC_REVIEW`
- Router remediation `packetBaseSha`:
  `48d79e2b13e258fc82ad55723875f15d6e162872` (authoring base only)
- Formal-review `postIntegrationAuthoritySha`: intentionally unresolved until the broker returns and
  pushes the exact accepted policy-integration commit; never hardcode it to `packetBaseSha` or a
  guessed SHA
- Authority state required before admission: root-resolved, clean, and bound by immutable pre-start
  attestation to the sole result of
  `git ls-remote origin refs/heads/refactor/hosted-web-feature-boundaries`; upstream-tracking
  assumptions are not evidence
- Reviewed product snapshot for all exact 32 unchanged inputs:
  `666042037a9c91df572b1d8274bf6024f8d00f40`
- Reviewed product snapshot's accepted true-merge parents, in order:
  1. `c3135d40c6e70e4b2ddc905dc815407397197634`
  2. `3b48f9391b4bff1d82bc85ef01a2d5e0e5b50e95`
- Accepted predecessors: PR #252 conflict gate and P1.1D, both complete and accepted
- Capacity: exactly one fresh independent reviewer
- Reviewer profile: `gpt-5.6-sol`, `xhigh`, `serviceTier: "default"`; Fast is not authorized
- Dependencies: broker-materialized offline before admission; worker installation is forbidden
- Terminal result: explicit `ACCEPT` or `REJECT`, then `HOLD`

This lane becomes executable only after the exact seven-path router containing it receives
independent acceptance, is policy-integrated, and is pushed. Root is the sole orchestrator and may
then resolve and attest `postIntegrationAuthoritySha` and start this one reviewer. The router author
starts none.

`controller-v17` remains `HOLD` and observation-only. It has no launch, admission, integration,
restart, replacement, or successor-controller authority. No successor controller exists or is
authorized by this packet.

## Independence gate

The reviewer identity, controller job, and worktree must be distinct from:

1. this P1.R2 router author;
2. every P1.1A or P1.1D producer, remediation worker, and reviewer;
3. every PR #252 conflict-resolution producer and reviewer; and
4. every prior Phase 1 formal reviewer.

The reviewer records its own identity, job, worktree, model, effort, service tier, and all four
exclusions in both outputs. Reuse, overlap, a second reviewer, non-default service tier, Fast mode,
or inability to prove independence is an admission runtime incident and requires `HOLD` without a
review disposition; substitution is not authorized. No concurrent duplicate may be started.

## Exact ProjectScopedControl reviewer admission

Root must use the existing refill-worker operation for this clean formal review. `prepare_verifier`
is not authorized. Angle-bracketed authority values below are resolved runtime values, not packet
literals or permission to guess a SHA:

```text
operation: codex_goal_project_refill_worker
workerRole: reviewer
reasoningEffort: xhigh
serviceTier: default
sourceRemote: origin
sourceBranch: refactor/hosted-web-feature-boundaries
expectedSourceCommit: <postIntegrationAuthoritySha>
preStartAdmission.mode: serial-builtin
preStartAdmission.contract.kind: worker-launch
preStartAdmission.contract.format: 1
preStartAdmission.contract.canonicalSha: <postIntegrationAuthoritySha>
preStartAdmission.contract.baseSha: <postIntegrationAuthoritySha>
preStartAdmission.contract.phaseStartSha: <postIntegrationAuthoritySha>
preStartAdmission.contract.packetRevision: phase-01-p1-r2-review-r1
preStartAdmission.contract.controllerPacket: docs/hosted-web-phases/phase-01/controller-packet.md
preStartAdmission.contract.lanePacket: docs/hosted-web-phases/phase-01/lanes/p1-r2-review.md
preStartAdmission.contract.phaseId: phase-01
preStartAdmission.contract.laneId: p1-r2
preStartAdmission.contract.inputPatchHash: null
preStartAdmission.contract.reviewKind: review
```

The resulting isolated review worktree must start at local `HEAD` equal to
`expectedSourceCommit`/`postIntegrationAuthoritySha`. Reviewer `planBundleCommit` and handoff
`baseSha`, `canonicalSha`, `planBundleCommit`, `phaseStartSha`, and `headSha` are separately bound to
that same resolved SHA. Root's immutable pre-start authority attestation must contain the exact
broker-returned pushed commit, remote name/ref, `git ls-remote` command, exit code, exact output,
equality result, clean-worktree result, and the `expectedSourceCommit` used for admission.

The reviewer has no GitHub, network, fetch, or remote-query authority. It validates the immutable
broker/root attestation and local canonical `HEAD`. A missing or invalid authority attestation,
authority checkout/admission failure, or root remote-query/network failure is a runtime incident that
ends `HOLD` without a semantic disposition. It is never a review finding or synthetic `REJECT`.

## Mission

Independently review the exact unchanged shared hosted kernel and P1.1D team-lifecycle list surface
from reviewed product snapshot `666042037a9c91df572b1d8274bf6024f8d00f40` in the clean authority
worktree whose `HEAD` is the resolved `postIntegrationAuthoritySha`.
Return one formal determination of whether list semantics, authorization context, safe errors,
revisions/cursors, deterministic bounded parsing, kernel size, and public boundaries match accepted
Phase 1 policy at that reviewed product snapshot.

This is a review, not a producer, repair, integration, or production-readiness pass. Do not modify a
reviewed product input or fix a finding. Do not add transport, filesystem, runtime, IPC, HTTP, preload,
renderer, production auth, provider, route, composition, dependency, or product behavior. Do not run
an app, runtime, team, server, provider check, browser check, filesystem integration, or real
project. Dependencies are already broker-materialized offline; do not install, fetch, update, or
repair them.

## Exact mandatory reads

Read in this order. Directory reads, globs, implicit siblings, and recursive research reads are not
authorized:

1. `AGENTS.md`
2. `docs/hosted-web-phases/START_HERE.md`
3. `docs/hosted-web-phases/EVIDENCE_LIFECYCLE.md`
4. `docs/hosted-web-phases/README.md`
5. `docs/hosted-web-phases/EXECUTION_INDEX.json`
6. `docs/hosted-web-phases/phase-01/controller-packet.md`
7. `docs/hosted-web-phases/phase-01/lanes/p1-r2-review.md`
8. `CLAUDE.md`
9. `AGENT_CRITICAL_GUARDRAILS.md`
10. `docs/FEATURE_ARCHITECTURE_STANDARD.md`
11. `docs/hosted-web-phases/PACKET_STANDARD.md`
12. `docs/hosted-web-phases/phase-01/README.md`
13. `docs/hosted-web-phases/phase-01/execution-dag.md`
14. `docs/hosted-web-phases/phase-01/architecture-and-contracts.md`
15. `docs/hosted-web-phases/phase-01/lanes/p1-s1-foundations.md`
16. `docs/hosted-web-phases/phase-01/lanes/p1-1d-team-lifecycle-read.md`
17. `docs/hosted-web-phases/phase-01/lanes/p1-1d-additive-response-remediation.md`
18. the exact 32 reviewed product inputs below, in listed order

The historical PR #252 lane remains frozen and is not a current review input. The two result paths
are new outputs, not inputs. Do not inspect other research or rejected artifacts.

## Exact 32-path reviewed product input

P1.1A contributes exactly these 12 paths:

1. `.codex-handoff/phase-01-p1-1a.json`
2. `src/shared/contracts/hosted/app-error.ts`
3. `src/shared/contracts/hosted/identifiers.ts`
4. `src/shared/contracts/hosted/index.ts`
5. `src/shared/contracts/hosted/query-context.ts`
6. `src/shared/contracts/hosted/revision.ts`
7. `test/architecture/hosted-web/phase-1/contracts/app-error.test.ts`
8. `test/architecture/hosted-web/phase-1/contracts/fixtures/invalid-contract-values.json`
9. `test/architecture/hosted-web/phase-1/contracts/fixtures/valid-contract-values.json`
10. `test/architecture/hosted-web/phase-1/contracts/identifiers.test.ts`
11. `test/architecture/hosted-web/phase-1/contracts/query-context.test.ts`
12. `test/architecture/hosted-web/phase-1/contracts/revision.test.ts`

P1.1D contributes exactly these 9 paths:

1. `.codex-handoff/phase-01-p1-1d.json`
2. `src/features/team-lifecycle/contracts/team-lifecycle-read.ts`
3. `src/features/team-lifecycle/contracts/index.ts`
4. `src/features/team-lifecycle/core/application/ListTeamLifecycle.ts`
5. `src/features/team-lifecycle/core/application/index.ts`
6. `src/features/team-lifecycle/index.ts`
7. `test/features/team-lifecycle/core/ListTeamLifecycle.test.ts`
8. `test/architecture/hosted-web/phase-1/team-lifecycle/team-lifecycle-read-contract.test.ts`
9. `test/architecture/hosted-web/phase-1/team-lifecycle/team-lifecycle-read-boundaries.test.ts`

The immutable semantic corpus contributes exactly these 11 paths:

1. `test/fixtures/hosted-web/phase-1/team-lifecycle/manifest.json`
2. `test/fixtures/hosted-web/phase-1/team-lifecycle/outcomes/corrupt.json`
3. `test/fixtures/hosted-web/phase-1/team-lifecycle/outcomes/draft.json`
4. `test/fixtures/hosted-web/phase-1/team-lifecycle/outcomes/empty.json`
5. `test/fixtures/hosted-web/phase-1/team-lifecycle/outcomes/not-found-inapplicable.json`
6. `test/fixtures/hosted-web/phase-1/team-lifecycle/outcomes/partial.json`
7. `test/fixtures/hosted-web/phase-1/team-lifecycle/outcomes/provisioning-inapplicable.json`
8. `test/fixtures/hosted-web/phase-1/team-lifecycle/outcomes/stale.json`
9. `test/fixtures/hosted-web/phase-1/team-lifecycle/outcomes/success.json`
10. `test/fixtures/hosted-web/phase-1/team-lifecycle/outcomes/unavailable.json`
11. `test/fixtures/hosted-web/phase-1/team-lifecycle/outcomes/unexpected.json`

The 12 + 9 + 11 sets are disjoint and total exactly 32 paths. Every byte is read-only, bound to
`reviewedProductSnapshotSha` `666042037a9c91df572b1d8274bf6024f8d00f40`, and required to be
byte-identical at post-integration authority `HEAD`. A missing, additional, overlapping, or modified
reviewed product input requires `REJECT` after valid admission.

## Exact exclusive reviewer writer authority

The reviewer may create and write exactly these two paths, in this order:

1. `.codex-handoff/phase-01-p1-r2.json`
2. `docs/research/hosted-web/phase-1/reviews/list-semantics.md`

Everything else is read-only. The reviewer may create a missing parent directory only when required
for one of these paths and may create no sibling. Any other changed, untracked, staged, generated,
formatted, or temporary repository path is `REJECT`, not repair or cleanup authority.

## Semantic, authorization, error, cursor, and bound review

The reviewer must independently prove all of the following:

1. Request parsing accepts only the exact versioned top-level and nested query-context fields,
   including own string and symbol behavior, and validates actor/session/deployment/boot/request IDs,
   `authorizedScope`, deadline, and cancellation without reading ambient or production auth state.
2. The use case invokes its injected value-only source exactly once for each valid request and zero
   times for an invalid request. It has no filesystem, adapter, transport, runtime, provider, or
   production mount.
3. Same-version success, failure, and inapplicable responses validate every known field before
   discarding additive own string/symbol fields and return fresh frozen known-field-only projections.
4. The success parser captures and bounds the untrusted `items` length at 1,000, rejects sparse or
   duplicate-ID input, reads each dense index exactly once, parses each element, uses a fresh plain
   array, and never dispatches an input-owned map, iterator, constructor, or species behavior.
5. All ten manifest scenarios retain their accepted success/failure/inapplicable outcome,
   deterministic ordering, revision/cursor values, safe fields, retryability, and empty-versus-error
   distinction. The deliberate semantic mismatch still rejects with
   `phase1-semantic-outcome-drift`.
6. Safe errors remain limited to the accepted application categories and bounded fields. Unsupported
   versions, malformed known fields, source throws, and invalid source responses fail closed without
   raw messages, stacks, auth/provider payloads, command bodies, or private paths.
7. Revisions and cursors remain opaque, kind-separated tokens. The contract never parses, increments,
   sorts, derives, or uses them as display/cache keys, and never silently converts an invalid cursor
   to page one. Production cursor integrity/scope/snapshot binding remains explicitly unverified
   because Phase 1 has no production adapter.
8. Public entrypoints expose only the narrow team-lifecycle contract and use case. They do not expose
   a legacy aggregate, universal envelope, transport status, route/capability metadata, provider
   value, filesystem/path value, production identity, or implementation folder.
9. The shared kernel remains exactly five product files and five primitive families: opaque IDs,
   query/authorization context, revision/cursor, safe application errors, and the public entrypoint.
   The five files remain exactly 159 lines and 7,242 bytes at the reviewed product snapshot and
   unchanged post-integration authority `HEAD`; the accepted P1.1A handoff remains 299 gross owned
   lines. No sixth primitive family or unproved export is accepted.
10. `P1.NEG.SCHEMA_VERSION` still fails with
    `phase1-schema-version-invalid-or-unsupported`, and its valid same-version neighbors pass. No
    production auth, transport parity, adapter integrity, filesystem/runtime integration, production
    mount, or full Phase 1 completion is claimed.

## Exact focused command

Run exactly this one focused test command from the authority review worktree at local `HEAD` equal to
`expectedSourceCommit`/`postIntegrationAuthoritySha`:

```bash
pnpm exec vitest run test/architecture/hosted-web/phase-1/contracts test/features/team-lifecycle
```

It must exit 0 with exactly 5 test files and 14/14 tests passing. Do not split, widen, replace, or add
another test command.

## Frozen typecheck baseline

Run `pnpm typecheck`. It may exit 1 only for these exact seven inherited diagnostics:

- `test/architecture/hosted-web/phase-0/auth-artifacts/auth-artifacts-spike.test.ts`: TS7016 at
  25:8; TS7031 at 66:31; TS18046 at 117:68; TS7031 at 413:48; TS7031 at 733:10;
- `test/architecture/hosted-web/phase-0/host-primitives/evidence-scanner.test.ts`: TS7016 at 12:8;
  and
- `test/architecture/hosted-web/phase-0/provider-runtime/scan-runtime-surfaces.test.ts`: TS2352 at
  162:44.

Acceptance requires exactly `7 inherited / 0 owned / 0 unexpected`. A new, removed, moved, or
changed inherited diagnostic, or any diagnostic in either reviewer output or a reviewed P1 input,
requires `REJECT`.

## Prettier, diff, and exact two-path scope

After the broker returns and pushes the accepted router-integration commit, root must bind
`brokerReturnedAndPushedCommitSha` and `postIntegrationAuthoritySha` to that exact value, run this
remote equality check, and capture the resolved values, command, exit code, exact output, equality,
and clean-worktree result in the immutable pre-start authority attestation. The reviewer never reruns
it or substitutes an upstream-tracking ref:

```bash
test -n "$brokerReturnedAndPushedCommitSha"
test "$postIntegrationAuthoritySha" = "$brokerReturnedAndPushedCommitSha"
remote_ref=refs/heads/refactor/hosted-web-feature-boundaries
remote_result=$(git ls-remote origin "$remote_ref")
test "$remote_result" = \
  "$(printf '%s\t%s' "$postIntegrationAuthoritySha" "$remote_ref")"
```

From the immutable attestation and admission contract, the reviewer binds the read-only shell values
`postIntegrationAuthoritySha` and `expectedSourceCommit` without querying the network. It then runs
these exact local authority, snapshot-topology, and 32-input byte-equality checks:

```bash
test -n "$postIntegrationAuthoritySha"
test "$expectedSourceCommit" = "$postIntegrationAuthoritySha"
test "$(git rev-parse HEAD)" = "$postIntegrationAuthoritySha"
test "$(git rev-list --parents -n 1 666042037a9c91df572b1d8274bf6024f8d00f40)" = \
  "666042037a9c91df572b1d8274bf6024f8d00f40 c3135d40c6e70e4b2ddc905dc815407397197634 3b48f9391b4bff1d82bc85ef01a2d5e0e5b50e95"
node <<'NODE'
const assert = require('node:assert/strict')
const index = require('./docs/hosted-web-phases/EXECUTION_INDEX.json')
const snapshot = '666042037a9c91df572b1d8274bf6024f8d00f40'
const inputs = index.reviewCanonicalInputs
const paths = [...inputs.p11aPaths, ...inputs.p11dPaths, ...inputs.semanticCorpusPaths]
assert.equal(inputs.authorityShaBinding, 'postIntegrationAuthoritySha')
assert.equal(inputs.reviewedProductSnapshotSha, snapshot)
assert.equal(paths.length, 32)
assert.equal(new Set(paths).size, 32)
console.log('P1.R2 exact reviewed product input manifest: 32 disjoint paths')
NODE
mapfile -t review_input_paths < <(node -e \
  "const i=require('./docs/hosted-web-phases/EXECUTION_INDEX.json').reviewCanonicalInputs; console.log([...i.p11aPaths,...i.p11dPaths,...i.semanticCorpusPaths].join('\\n'))")
test "${#review_input_paths[@]}" -eq 32
git diff --exit-code \
  666042037a9c91df572b1d8274bf6024f8d00f40 \
  HEAD \
  -- "${review_input_paths[@]}"
git diff --exit-code \
  HEAD \
  -- "${review_input_paths[@]}"
```

Run this exact Prettier check after both outputs are complete:

```bash
pnpm exec prettier --check \
  .codex-handoff/phase-01-p1-1a.json \
  src/shared/contracts/hosted/app-error.ts \
  src/shared/contracts/hosted/identifiers.ts \
  src/shared/contracts/hosted/index.ts \
  src/shared/contracts/hosted/query-context.ts \
  src/shared/contracts/hosted/revision.ts \
  test/architecture/hosted-web/phase-1/contracts/app-error.test.ts \
  test/architecture/hosted-web/phase-1/contracts/fixtures/invalid-contract-values.json \
  test/architecture/hosted-web/phase-1/contracts/fixtures/valid-contract-values.json \
  test/architecture/hosted-web/phase-1/contracts/identifiers.test.ts \
  test/architecture/hosted-web/phase-1/contracts/query-context.test.ts \
  test/architecture/hosted-web/phase-1/contracts/revision.test.ts \
  .codex-handoff/phase-01-p1-1d.json \
  src/features/team-lifecycle/contracts/team-lifecycle-read.ts \
  src/features/team-lifecycle/contracts/index.ts \
  src/features/team-lifecycle/core/application/ListTeamLifecycle.ts \
  src/features/team-lifecycle/core/application/index.ts \
  src/features/team-lifecycle/index.ts \
  test/features/team-lifecycle/core/ListTeamLifecycle.test.ts \
  test/architecture/hosted-web/phase-1/team-lifecycle/team-lifecycle-read-contract.test.ts \
  test/architecture/hosted-web/phase-1/team-lifecycle/team-lifecycle-read-boundaries.test.ts \
  test/fixtures/hosted-web/phase-1/team-lifecycle/manifest.json \
  test/fixtures/hosted-web/phase-1/team-lifecycle/outcomes/corrupt.json \
  test/fixtures/hosted-web/phase-1/team-lifecycle/outcomes/draft.json \
  test/fixtures/hosted-web/phase-1/team-lifecycle/outcomes/empty.json \
  test/fixtures/hosted-web/phase-1/team-lifecycle/outcomes/not-found-inapplicable.json \
  test/fixtures/hosted-web/phase-1/team-lifecycle/outcomes/partial.json \
  test/fixtures/hosted-web/phase-1/team-lifecycle/outcomes/provisioning-inapplicable.json \
  test/fixtures/hosted-web/phase-1/team-lifecycle/outcomes/stale.json \
  test/fixtures/hosted-web/phase-1/team-lifecycle/outcomes/success.json \
  test/fixtures/hosted-web/phase-1/team-lifecycle/outcomes/unavailable.json \
  test/fixtures/hosted-web/phase-1/team-lifecycle/outcomes/unexpected.json \
  .codex-handoff/phase-01-p1-r2.json \
  docs/research/hosted-web/phase-1/reviews/list-semantics.md
git diff --check
git diff --cached --quiet
git diff --exit-code
git status --short
```

Prettier and all three diff commands must be green. After both outputs exist, status must resolve to
exactly the two untracked writable paths above, in lexical Git status order, with no staged path.
Prove `expectedSourceCommit`, `HEAD`, base, canonical, plan bundle, and phase start remain the resolved
`postIntegrationAuthoritySha`; the immutable root attestation remains exact; and the reviewed product
snapshot and ordered merge parents remain exact. Do not run `git ls-remote`, fetch, or any GitHub or
network query in the reviewer worktree.

## Secret, provider, and private-path scans

Scan all 32 reviewed product inputs and both outputs. Use one exact path array so no untracked output
or reviewed product input is missed:

```bash
review_scan_paths=(
  .codex-handoff/phase-01-p1-1a.json
  src/shared/contracts/hosted/app-error.ts
  src/shared/contracts/hosted/identifiers.ts
  src/shared/contracts/hosted/index.ts
  src/shared/contracts/hosted/query-context.ts
  src/shared/contracts/hosted/revision.ts
  test/architecture/hosted-web/phase-1/contracts/app-error.test.ts
  test/architecture/hosted-web/phase-1/contracts/fixtures/invalid-contract-values.json
  test/architecture/hosted-web/phase-1/contracts/fixtures/valid-contract-values.json
  test/architecture/hosted-web/phase-1/contracts/identifiers.test.ts
  test/architecture/hosted-web/phase-1/contracts/query-context.test.ts
  test/architecture/hosted-web/phase-1/contracts/revision.test.ts
  .codex-handoff/phase-01-p1-1d.json
  src/features/team-lifecycle/contracts/team-lifecycle-read.ts
  src/features/team-lifecycle/contracts/index.ts
  src/features/team-lifecycle/core/application/ListTeamLifecycle.ts
  src/features/team-lifecycle/core/application/index.ts
  src/features/team-lifecycle/index.ts
  test/features/team-lifecycle/core/ListTeamLifecycle.test.ts
  test/architecture/hosted-web/phase-1/team-lifecycle/team-lifecycle-read-contract.test.ts
  test/architecture/hosted-web/phase-1/team-lifecycle/team-lifecycle-read-boundaries.test.ts
  test/fixtures/hosted-web/phase-1/team-lifecycle/manifest.json
  test/fixtures/hosted-web/phase-1/team-lifecycle/outcomes/corrupt.json
  test/fixtures/hosted-web/phase-1/team-lifecycle/outcomes/draft.json
  test/fixtures/hosted-web/phase-1/team-lifecycle/outcomes/empty.json
  test/fixtures/hosted-web/phase-1/team-lifecycle/outcomes/not-found-inapplicable.json
  test/fixtures/hosted-web/phase-1/team-lifecycle/outcomes/partial.json
  test/fixtures/hosted-web/phase-1/team-lifecycle/outcomes/provisioning-inapplicable.json
  test/fixtures/hosted-web/phase-1/team-lifecycle/outcomes/stale.json
  test/fixtures/hosted-web/phase-1/team-lifecycle/outcomes/success.json
  test/fixtures/hosted-web/phase-1/team-lifecycle/outcomes/unavailable.json
  test/fixtures/hosted-web/phase-1/team-lifecycle/outcomes/unexpected.json
  .codex-handoff/phase-01-p1-r2.json
  docs/research/hosted-web/phase-1/reviews/list-semantics.md
)
rg -n -i '(api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|bearer)' "${review_scan_paths[@]}"
rg -n -i '(provider|anthropic|claude|openai|opencode|gpt-[0-9])' "${review_scan_paths[@]}"
rg -n '(/Users/|/home/|/root/|~/|[A-Za-z]:\\Users\\|real[-_ ]project)' "${review_scan_paths[@]}"
```

Record every command and exit code and manually classify every lexical match. Expected test terms,
safe error-category words, and reviewer launch metadata are not secret/provider payloads. Any real
credential, secret, auth/provider payload, raw provider value, private user path, or real-project path
requires `REJECT`. A zero-match claim without all 34 paths is invalid.

## Disposition and evidence contract

Write `docs/research/hosted-web/phase-1/reviews/list-semantics.md` as the canonical review result. It
must contain:

1. exactly one formal `Disposition: ACCEPT` or `Disposition: REJECT`;
2. reviewer identity/job/worktree/profile and complete independence proof;
3. `packetBaseSha` as router-authoring provenance only; resolved `postIntegrationAuthoritySha`;
   `expectedSourceCommit`/base/canonical/plan-bundle/start/`HEAD` equality; clean state; root's exact
   immutable remote-ref equality attestation; separate `reviewedProductSnapshotSha`; and exact
   ordered-parent provenance;
4. exact 12 + 9 + 11 = 32 reviewed product input accounting, authority/snapshot byte-equality proof,
   and exact two-path output accounting;
5. findings for every semantic/auth/error/cursor/kernel-size requirement above;
6. the focused command, exact exit code, and observed file/test counts;
7. the complete seven-diagnostic typecheck classification with zero owned/unexpected;
8. Prettier, diff, status, secret/provider/private-path commands, exit codes, and match
   classifications;
9. explicit P0/P1/P2 findings or zero counts for each; and
10. an explicit statement that P1.I, P1.F, Phase 2+, product workers, integration, production auth,
    adapters, mounts, and successor controllers remain blocked or unverified as applicable.

Write `.codex-handoff/phase-01-p1-r2.json` following `PACKET_STANDARD.md`. It must include:

1. `schemaVersion: 1`, `phaseId: "phase-01"`, `laneId: "p1-r2"`, and packet revision
   `phase-01-p1-r2-review-r1`;
2. `baseSha`, `canonicalSha`, `planBundleCommit`, `phaseStartSha`, and `headSha`, all the exact resolved
   `postIntegrationAuthoritySha`, plus separate
   `reviewedProductSnapshotSha: "666042037a9c91df572b1d8274bf6024f8d00f40"` for the unchanged
   exact 32 product inputs;
3. status `verified` when the formal review completes with all required observations, whether its
   disposition is `ACCEPT` or `REJECT`; use `failed` only when the review contract cannot complete;
4. exactly one evidence row for `P1.R2.SEMANTIC_REVIEW`, result path
   `docs/research/hosted-web/phase-1/reviews/list-semantics.md`, and proof level
   `target_verified` when the exact authority/snapshot target and required commands were fully observed;
   otherwise record `unverified` without inventing proof;
5. `changedPaths` containing exactly the handoff path and result path, in writer-authority order;
6. every check command, exit code, observed count, typecheck classification, scan classification,
   scope proof, and result-file SHA-256;
7. explicit disposition and P0/P1/P2 findings/counts consistent with the Markdown result;
8. unverified claims and blocked successors exactly as required above; and
9. `nextAction: "controller-hold"` and `terminalState: "HOLD"`.

`ACCEPT` is legal only when every gate passes and P0/P1/P2 are `0/0/0`. There is no conditional
acceptance and no repair authority. A semantic, content, or review-gate finding—including incomplete
or ambiguous evidence content or scope/provenance drift—returns `REJECT` with the finding. Admission,
provider, or environment failure, including an unavailable required command, is a runtime incident
that returns no review disposition and ends `HOLD`. Absence of a strict terminal result is likewise
a runtime incident, not evidence and not a synthetic `REJECT`.
Missing or invalid authority attestation, authority checkout/admission failure, or root
remote-query/network failure is also a runtime incident under this rule. The reviewer must not turn
any of those failures into a semantic finding.

## Strict completion and attempt lifecycle

Root may declare this review complete only when the same admitted attempt has both:

1. a strict terminal result carrying the formal `ACCEPT` or `REJECT`, and
2. broker-captured immutable output binding both exact result paths, whose bytes and hashes match
   that terminal result.

`changedFiles`, heartbeat, PID, tmux, and `providerObserved` state are insufficient individually and
together. They never establish termination, disposition, or immutable evidence.

There is no concurrent duplicate, refill, or attempt after a semantic, content, or gate `REJECT`.
For an admission, provider, environment, or no-strict-result runtime incident, root may authorize at
most one exact corrected attempt. Before doing so, root must prove the affected attempt terminal or
prove no runner exists. The corrected attempt must preserve the exact assignment, resolved
`postIntegrationAuthoritySha`, immutable authority attestation,
reviewed product snapshot SHA, 32 unchanged inputs, two output paths, `gpt-5.6-sol` model, `xhigh`
effort, default service tier, no-Fast rule, commands, and independence requirements.

## Accepted-result integration boundary

For strict `ACCEPT` with P0/P1/P2 `0/0/0`, root mechanically verifies the strict result, immutable
output, bound evidence bytes and hashes, exact commands, findings, and two-path scope. Root then
invokes `mark_reviewed` and directs the broker to integrate and push exactly, and only:

1. `.codex-handoff/phase-01-p1-r2.json`
2. `docs/research/hosted-web/phase-1/reviews/list-semantics.md`

The reviewer and root do not stage, commit, integrate, or push. Broker integration adopts the
evidence but authorizes no successor. P1.I, P1.F, Phase 2+, and product workers remain blocked. Only
a later separately reviewed docs router may authorize P1.I; it reads the already integrated
evidence and must never integrate either P1.R2 evidence path again.

## Stop and HOLD

When a properly admitted reviewer reaches a strict terminal result, reviewed-product-snapshot,
ordered-parent, accepted-predecessor, input/output scope, semantic,
authorization, error, cursor, kernel-size, test-count, typecheck, Prettier, diff, scan, or evidence
content drift is a review-gate finding: record `REJECT` and stop `HOLD`. Do not repair or retry.

Unresolved or mismatched post-integration authority, missing or invalid immutable authority
attestation, local authority checkout mismatch, reviewer admission/count/independence/profile failure,
provider failure, root remote-query/network failure, environment failure, or no strict terminal result
is a runtime incident: record controller `HOLD` without inventing `REJECT`. Do not run a concurrent
duplicate. At most one exact corrected attempt is possible under the terminal/no-runner rule above.

Return the strict result, immutable output, and both bound result paths to root when they exist.
After any disposition, P1.I, P1.F, Phase 2+, and product workers remain blocked. Broker integration
of strict accepted evidence follows only the accepted-result boundary above; a later docs router
alone may authorize P1.I and never reintegrates the evidence. This packet authorizes no successor
controller. End `HOLD`.
