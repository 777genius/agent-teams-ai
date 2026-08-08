# P1.1D shadowed-map implementation remediation lane

> **Post-freeze amendment (2026-07-16).** The wire request no longer embeds a query context:
> `ListTeamLifecycleRequest` is `{ schemaVersion, cursor, expectedRevision }` and the host passes
> the `QueryContext` to `execute(request, context)` separately. Criteria below that require
> nested query-context request objects describe the reviewed pre-fix snapshot.

## Current r4 producer contract

- Packet revision: `phase-01-p1-1d-shadowed-map-remediation-r4`
- Mode/capacity: implementation remediation / exactly one producer
- Original product `baseSha`: `1b37afb02bec25a1f08432d733595b553101ecab`
- `canonicalSha`, `phaseStartSha`, `planBundleCommit`, and worktree `HEAD`:
  `3405da177b040c65caad10ef2df4d4f4338feed0`
- Runtime carrier: `1f9c6a2a28e5540c61d1395bc51a34a7c0db31855bae575abc9582f839118b49`
- Semantic reconstruction: `fa46617652b072e887563f5a751f7bd0260e0e1d4fb96b628badea91ea7ae9d6`

Read the exact mandatory sources below in order through item 38, using the current r4 controller and
lane values; the absent candidate reads and ledger reads in items 39-42 are superseded by this
materialization contract. Do not glob or inspect siblings. The runtime must materialize reviewed
output `693d79c9314c46b9ac0ae13c8c62cb7951461fb7d335ec426119fc8a86a23c91` as `output.patch`, verified
by `inputPatchHash` `521d8bab2ed7bc4334b38a5786dd5685f5e4f033c3962cab566f9ab3b60d0000`.

Canonical HEAD contains none of the candidate files. Materialize the complete exact nine-path carrier
listed below. Preserve these six paths byte-for-byte from reviewed output: the four product entrypoint
and application files other than `team-lifecycle-read.ts`, `ListTeamLifecycle.test.ts`, and
`team-lifecycle-read-boundaries.test.ts`. Semantically edit only:

1. `src/features/team-lifecycle/contracts/team-lifecycle-read.ts`
2. `test/architecture/hosted-web/phase-1/team-lifecycle/team-lifecycle-read-contract.test.ts`
3. `.codex-handoff/phase-01-p1-1d.json` (regenerated)

For `items`, capture a validated length before traversal, allocate a trusted fresh plain array, own
each output index, reject every sparse input, read every input index exactly once, and call `parseItem`
for every element. Never dispatch input-owned `map`, iterator, constructor, or species behavior.
Perform deterministic ordering and freeze only on trusted arrays. Preserve strict request rejection,
same-version additive response validation/discard, safe projections, all ten fixture outcomes,
transport neutrality, source-call behavior, original negative diagnostics, and public boundaries.

Run every focused test, lint, typecheck-classification, Prettier-check, diff, ownership, provenance,
hash, and safety gate already listed below. Typecheck may report only the exact seven unchanged Phase 0
diagnostics in the same three files. Regenerate the handoff with the r4 packet identity, exact nine
changed paths, six byte-preservation proofs, three semantic-edit hashes, command results, and
`nextAction: "review"`.

Admission is `codex_goal_project_refill_worker`, outer `workerRole: producer`, `serial-builtin`
internal `kind: worker-launch`, `format: 1`, `reviewKind: implementation`, and the reviewed snapshot
patch as `inputPatchHash`. After producer completion, require a fresh independent exact-read reviewer.
Do not integrate, commit, push, launch a reviewer/controller, start P1.R2/P1.I/P1.F/Phase 2+, or touch
the exact five PR conflict files. End `HOLD`.

Reviewer r2 binding evidence is strict result
`b8dca625e5eedfc457fd9908a7c0f41489db1dc784c98b52598a1e26504dc895`, audited attempt
`p1-1d-review-v17-r2-formal-reject`, with product P1-001 and process-only fail-closed P1-002. Broad r3
output `5e1f1bcb6bfc076d59346b0fddc97db271800af4a9e17e85c604de0f2d046822`, patch
`8f74ea9cf5b3e187a75a36c0e4e90378752e52d5e1b06893d961811c54ab5dcf`, audited attempt
`p1-1d-shadowed-map-router-v17-r3-scope-reject` is rejected evidence and must never be copied/applied.

## Retained rejected r2 review packet

The review-only text below is preserved as prior provenance and is non-executable. Its focused checks,
exact scope lists, safety rules, and blocked successors remain binding where compatible with r4.

## Authority and provenance

- Project: `agent-teams-hosted-web-refactor`
- Phase/node: `phase-01` / `P1.1D-additive-response-remediation`
- Lane ID: `p1-1d-additive-response-remediation-review`
- Packet revision: `phase-01-p1-1d-additive-response-review-r2`
- Mode: review-only
- Immutable product candidate `baseSha`: `1b37afb02bec25a1f08432d733595b553101ecab`
- Reviewer `canonicalSha`, `phaseStartSha`, `planBundleCommit`, and worktree `HEAD`:
  `bbfd2551baaa904061e705511f07716e0f6db17d`
- Superseded producer revision: `phase-01-p1-1d-additive-response-remediation-r1`
- Reviewer configuration: reasoning effort `xhigh`, service tier `default`
- Capacity: exactly one fresh independent reviewer; no producer, retry, refill, integration, or later
  work
- Required terminal disposition: explicit `ACCEPT` or `REJECT`

This packet becomes executable only after its exact seven-path correction router is policy-integrated
and the same durable controller has atomically adopted this review-only scope while remaining exactly
`live=true`. This docs job authorizes but does not launch the reviewer.

## Binding input roles

| Input                                    | SHA-256                                                            | Binding role                            |
| ---------------------------------------- | ------------------------------------------------------------------ | --------------------------------------- |
| Runtime nine-path handoff carrier        | `1f9c6a2a28e5540c61d1395bc51a34a7c0db31855bae575abc9582f839118b49` | Complete immutable candidate carrier    |
| Final eight-path semantic reconstruction | `fa46617652b072e887563f5a751f7bd0260e0e1d4fb96b628badea91ea7ae9d6` | Five product plus three test paths      |
| Reviewed-workspace snapshot              | `521d8bab2ed7bc4334b38a5786dd5685f5e4f033c3962cab566f9ab3b60d0000` | Prior rejection-ledger consumption only |
| Prior independent-review strict result   | `29ad2243be1a1e0c7aa95cb1a32ae32b8f15db8ebe1a260cd41dd85d2c079934` | Binding `REJECT` P1 record              |

Never substitute one role for another. In particular, the reviewed-workspace snapshot does not name
candidate bytes and must not be used as the carrier, handoff, patch, or semantic reconstruction hash.

## Binding prior rejection and correction

The prior independent reviewer returned formal `REJECT` P1. Preserve that disposition exactly; it is
not `ACCEPT` and this packet does not reinterpret it.

The sole finding was an incorrect external review instruction that asserted transient interim hash
`7672e922` was the final handoff hash. The assertion was external to the candidate. The final candidate
does not contain or claim `7672e922`. Correct fresh-review input names the nine-path carrier and
eight-path semantic reconstruction separately, as listed above.

Both producer output and prior reviewer output have formal rejected integration-ledger records.
Admission reports no blocking output debt. Ledger closure permits this one fresh review only and is not
evidence of product acceptance or integration authority.

The predecessor docs-router output is also immutable rejected evidence: reviewed output
`1ad2849056be658ab629b9810914ace7eab3287745ecb39c1d76ac1c124d0eb7`, patch SHA-256
`657c1c5ff6421f6b206ef14509586d09fad72e8c511efe1a6f9bf6b8dce5f577`. This packet reproduces its
useful review-only transition with the two admission defects corrected. It does not modify, revive, or
integrate that output.

## Mission

Independently review the existing immutable P1.1D additive-response remediation candidate. Rerun all
bound checks without changing any candidate, handoff, documentation, research, runtime, configuration,
package, lockfile, or conflict-resolution path. Return one explicit `ACCEPT` or `REJECT` result with
P0/P1/P2 findings and exact hash observations.

No producer retry/refill, product rerun, product change, product integration, commit, push, P1.R2,
P1.I, P1.F, Phase 2+, or work in any of the five PR conflict files is authorized.

## Exact ProjectScopedControl reviewer admission

The hosting subscription runtime may admit work only through the existing ProjectScopedControl
operation and stable reviewer shape below. It introduces no separate tool or public contract:

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

The controller must also supply the stable contract's exact `ownedPaths`, `mandatoryDocs`,
`mandatoryScripts`, `mandatoryFixtures`, non-empty `requiredChecks`, and sandbox-only
`executionPolicy` from this packet. Reviewer `planBundleCommit` is separately bound to
`bbfd2551baaa904061e705511f07716e0f6db17d`; it is not invented as an unsupported internal contract
field. The serial controller state enforces exactly one reviewer.

The semantic reconstruction, ledger snapshot, prior result, prior `REJECT`, and stale `7672e922`
classification remain review evidence with their roles from the table above. They are not substituted
for `inputPatchHash` or added as guessed contract fields.

The reviewer must be a new identity and isolated review worktree, distinct from this router author,
all P1.1D producers, and the prior rejected reviewer. A reused identity/worktree, service tier other
than `default`, reasoning effort other than `xhigh`, second reviewer, stale packet, mixed hash role, or
non-live controller fails closed.

## Exact mandatory reads

Read in this order. Directory reads, globs, implicit siblings, recursive documentation/research reads,
and the whole master plan are not authorized:

1. `AGENTS.md`
2. `docs/hosted-web-phases/START_HERE.md`
3. `docs/hosted-web-phases/EVIDENCE_LIFECYCLE.md`
4. `docs/hosted-web-phases/README.md`
5. `docs/hosted-web-phases/EXECUTION_INDEX.json`
6. `docs/hosted-web-phases/phase-01/controller-packet.md`
7. `docs/hosted-web-phases/phase-01/lanes/p1-1d-additive-response-remediation.md`
8. `docs/hosted-web-phases/phase-01/lanes/p1-1d-team-lifecycle-read.md`
9. `CLAUDE.md`
10. `AGENT_CRITICAL_GUARDRAILS.md`
11. `src/features/CLAUDE.md`
12. `docs/hosted-web-phases/PACKET_STANDARD.md`
13. `docs/hosted-web-phases/phase-01/execution-dag.md`
14. `docs/hosted-web-phases/phase-01/architecture-and-contracts.md`
15. `docs/FEATURE_ARCHITECTURE_STANDARD.md`
16. only the two headings `Phase 1 work packages: create one contract system, not another mega-API`
    and `Phase 1: single-source contracts and conformance` in
    `docs/hosted-web-e2e-completion-plan.md`
17. `docs/research/hosted-web/phase-1/reviews/routes-ratchets.md`
18. `src/shared/contracts/hosted/index.ts`
19. `src/shared/contracts/hosted/app-error.ts`
20. `src/shared/contracts/hosted/identifiers.ts`
21. `src/shared/contracts/hosted/query-context.ts`
22. `src/shared/contracts/hosted/revision.ts`
23. `src/main/composition/hosted/routing/route-types.ts`
24. `test/architecture/hosted-web/phase-1/conformance/semantic-harness.ts`
25. `test/architecture/hosted-web/phase-1/conformance/semantic-harness.test.ts`
26. `scripts/hosted-web/phase-1/check-feature-dependencies.ts`
27. `test/architecture/hosted-web/phase-1/dependencies/feature-dependencies.test.ts`
28. `test/fixtures/hosted-web/phase-1/team-lifecycle/manifest.json`
29. `test/fixtures/hosted-web/phase-1/team-lifecycle/outcomes/corrupt.json`
30. `test/fixtures/hosted-web/phase-1/team-lifecycle/outcomes/draft.json`
31. `test/fixtures/hosted-web/phase-1/team-lifecycle/outcomes/empty.json`
32. `test/fixtures/hosted-web/phase-1/team-lifecycle/outcomes/not-found-inapplicable.json`
33. `test/fixtures/hosted-web/phase-1/team-lifecycle/outcomes/partial.json`
34. `test/fixtures/hosted-web/phase-1/team-lifecycle/outcomes/provisioning-inapplicable.json`
35. `test/fixtures/hosted-web/phase-1/team-lifecycle/outcomes/stale.json`
36. `test/fixtures/hosted-web/phase-1/team-lifecycle/outcomes/success.json`
37. `test/fixtures/hosted-web/phase-1/team-lifecycle/outcomes/unavailable.json`
38. `test/fixtures/hosted-web/phase-1/team-lifecycle/outcomes/unexpected.json`
39. the immutable candidate's exact five product paths, in the order below
40. the immutable candidate's exact three test paths, in the order below
41. the immutable `.codex-handoff/phase-01-p1-1d.json`
42. the controller-supplied formal producer and reviewer rejected integration-ledger records, only
    after verifying the ledger snapshot role and prior strict-result SHA-256 above

Every input is read-only. The prior result and ledger records are rejection provenance, never a
substitute for independently reviewing the candidate.

## Exact immutable review scope

### Product paths: exactly five

1. `src/features/team-lifecycle/contracts/team-lifecycle-read.ts`
2. `src/features/team-lifecycle/contracts/index.ts`
3. `src/features/team-lifecycle/core/application/ListTeamLifecycle.ts`
4. `src/features/team-lifecycle/core/application/index.ts`
5. `src/features/team-lifecycle/index.ts`

### Test paths: exactly three

1. `test/features/team-lifecycle/core/ListTeamLifecycle.test.ts`
2. `test/architecture/hosted-web/phase-1/team-lifecycle/team-lifecycle-read-contract.test.ts`
3. `test/architecture/hosted-web/phase-1/team-lifecycle/team-lifecycle-read-boundaries.test.ts`

### Handoff path: exactly one

1. `.codex-handoff/phase-01-p1-1d.json`

The sets are disjoint: five product + three test + one handoff = nine candidate paths. The reviewer has
no repository writer authority. Formatting, generated output, review notes, evidence, or ledger
records must not be written to the worktree.

## Required semantic review

The reviewer must independently prove:

1. top-level and nested query-context request objects remain strict and reject unknown own string and
   symbol fields;
2. every supported same-version success, failure, and inapplicable response validates all known fields
   before ignoring additive fields;
3. top-level responses, success `items[]`, and failure safe `error` objects return fresh frozen
   known-field-only projections with additive own string and symbol fields absent;
4. unsupported versions, missing/invalid known fields, invalid discriminants/combinations, malformed
   IDs/revisions/cursors, and unsafe error fields still reject when additive data is present;
5. no response returns or spreads an untrusted source object/array, mutates it, or preserves additive
   state;
6. all ten immutable manifest scenarios preserve their required success/failure/inapplicable outcome,
   ordering, cursor/revision treatment, safe errors, and deterministic application behavior;
7. the source port is injected and called exactly once for a valid request, with no filesystem,
   runtime, adapter, transport, or production mount; and
8. the contract and public entrypoints remain narrow, browser-safe, path-free, secret-free, and free
   of legacy aggregate, Electron, renderer, preload, `@main`, fixture, and research dependencies.

The original negative IDs and exact diagnostics remain binding:

| Negative ID                           | Exact diagnostic                      | Required neighbor                                          |
| ------------------------------------- | ------------------------------------- | ---------------------------------------------------------- |
| `P1.NEG.SEMANTIC_OUTCOME`             | `phase1-semantic-outcome-drift`       | all ten actual outcomes match the immutable manifest       |
| `P1.NEG.LEGACY_GOD_DTO`               | `phase1-legacy-god-dto-forbidden`     | only the narrow feature-owned contract is publicly exposed |
| `P1.NEG.NO_FILESYSTEM_ADAPTER_PHASE1` | `phase1-filesystem-adapter-forbidden` | pure injected port and test-owned in-memory value pass     |

## Focused required checks

Run every command independently from the immutable review worktree. Do not use a formatting writer or
any command that mutates candidate bytes:

```bash
pnpm exec vitest run test/features/team-lifecycle/core/ListTeamLifecycle.test.ts
pnpm exec vitest run test/architecture/hosted-web/phase-1/team-lifecycle/team-lifecycle-read-contract.test.ts
pnpm exec vitest run test/architecture/hosted-web/phase-1/team-lifecycle/team-lifecycle-read-boundaries.test.ts
pnpm exec vitest run test/architecture/hosted-web/phase-1/conformance/semantic-harness.test.ts test/architecture/hosted-web/phase-1/dependencies/feature-dependencies.test.ts
pnpm lint:fast:files -- src/features/team-lifecycle/contracts/team-lifecycle-read.ts src/features/team-lifecycle/contracts/index.ts src/features/team-lifecycle/core/application/ListTeamLifecycle.ts src/features/team-lifecycle/core/application/index.ts src/features/team-lifecycle/index.ts test/features/team-lifecycle/core/ListTeamLifecycle.test.ts test/architecture/hosted-web/phase-1/team-lifecycle/team-lifecycle-read-contract.test.ts test/architecture/hosted-web/phase-1/team-lifecycle/team-lifecycle-read-boundaries.test.ts
pnpm typecheck
pnpm exec prettier --check src/features/team-lifecycle/contracts/team-lifecycle-read.ts src/features/team-lifecycle/contracts/index.ts src/features/team-lifecycle/core/application/ListTeamLifecycle.ts src/features/team-lifecycle/core/application/index.ts src/features/team-lifecycle/index.ts test/features/team-lifecycle/core/ListTeamLifecycle.test.ts test/architecture/hosted-web/phase-1/team-lifecycle/team-lifecycle-read-contract.test.ts test/architecture/hosted-web/phase-1/team-lifecycle/team-lifecycle-read-boundaries.test.ts .codex-handoff/phase-01-p1-1d.json
git diff --check
git status --short
```

The three candidate test files and two accepted ratchet files must pass. Lint, Prettier, diff,
ownership, hash, and safety gates must be green. `pnpm typecheck` may exit 1 only for exactly the seven
unchanged inherited Phase 0 diagnostics accepted by P1.R1, in exactly these files:

- `test/architecture/hosted-web/phase-0/auth-artifacts/auth-artifacts-spike.test.ts`
- `test/architecture/hosted-web/phase-0/host-primitives/evidence-scanner.test.ts`
- `test/architecture/hosted-web/phase-0/provider-runtime/scan-runtime-surfaces.test.ts`

Any new, removed, moved, or changed diagnostic or any candidate-path diagnostic is a finding. Do not
run an app, browser, Electron, server, IPC/HTTP smoke, real project, provider/runtime, or filesystem
integration check.

## Hash, provenance, ownership, and safety review

Before disposition, independently:

1. prove immutable product candidate `baseSha` is exactly
   `1b37afb02bec25a1f08432d733595b553101ecab`, while reviewer `canonicalSha`, `phaseStartSha`,
   `planBundleCommit`, and worktree `HEAD` are exactly
   `bbfd2551baaa904061e705511f07716e0f6db17d`;
2. prove the candidate set is exactly the nine paths above with nothing staged and no extra tracked or
   untracked change;
3. verify the complete carrier as
   `1f9c6a2a28e5540c61d1395bc51a34a7c0db31855bae575abc9582f839118b49` using its runtime carrier
   procedure;
4. reconstruct the eight non-handoff paths using the handoff's canonical deterministic procedure and
   require `fa46617652b072e887563f5a751f7bd0260e0e1d4fb96b628badea91ea7ae9d6`;
5. use `521d8bab2ed7bc4334b38a5786dd5685f5e4f033c3962cab566f9ab3b60d0000` only to consume the prior
   rejection-ledger record;
6. verify strict result
   `29ad2243be1a1e0c7aa95cb1a32ae32b8f15db8ebe1a260cd41dd85d2c079934` and preserve `REJECT`;
7. scan only the exact nine candidate paths and prove none contains or claims `7672e922`;
8. verify both formal rejected integration-ledger records and the no-blocking-output-debt admission;
9. scan all nine candidate paths for credentials, secrets, auth/provider payloads, private locations,
   user directories, real-project paths, raw command/runtime bodies, and binary content, classifying
   every match; and
10. compare status and hashes again after all checks to prove review caused no mutation.

A mismatch is a finding or `REJECT`; it is never permission to edit, regenerate, restage, retry a
producer, or relabel a hash.

## Strict result contract

Return one runtime-owned structured result; write no repository evidence file. The result must include:

1. reviewer identity, independence proof, `xhigh` reasoning effort, and `default` service tier;
2. packet revision, distinct product-base and reviewer canonical/start/plan/HEAD facts, and controller
   binding;
3. explicit `disposition: "ACCEPT"` or `disposition: "REJECT"`;
4. P0/P1/P2 finding counts and complete findings;
5. each of the four SHA-256 values above with its exact role and independently observed result;
6. explicit confirmation that prior `REJECT` was preserved and not laundered into acceptance;
7. explicit confirmation that `7672e922` was external/transient only and absent as a candidate claim;
8. command exit codes, observed test counts, inherited-diagnostic classification, and negative/additive
   matrix results;
9. exact nine-path scope, candidate immutability, ledger-record status, no-blocking-output-debt status,
   and secret/private-path/binary classifications; and
10. `nextAction: "controller-hold"`.

`ACCEPT` is legal only if every gate passes with no P0/P1 finding and the evidence is complete.
Otherwise return `REJECT` with the finding; blocked, incomplete, ambiguous, or missing output is not
acceptance.

## Explicit stop conditions

Stop without changing files if any input hash or role is stale, the prior disposition is not
`REJECT`, the candidate contains or claims `7672e922`, a ledger record is missing, admission reports
blocking output debt, the controller is not the same live durable identity, the review-only scope was
not atomically adopted, reviewer independence/configuration fails, a second reviewer exists, an extra
or staged path appears, or a required check cannot be run without mutation or expanded scope.

Also stop on any secret/private/real-project value, binary, product edit, producer retry/refill,
integration, commit, push, P1.R2, P1.I, P1.F, Phase 2+, controller replacement, or work in any of the
five PR conflict files. Do not widen scope or repair an immutable input.

## Completion and HOLD

The review completes only with one explicit `ACCEPT` or `REJECT` result and no repository mutation.
Return it to the same durable controller and hold. This packet never authorizes product integration;
that remains blocked pending a later separately authorized router even if the fresh result is
`ACCEPT`.

The correction-router author likewise ends on `HOLD` without launching the reviewer, staging,
committing, pushing, integrating, rerunning a producer, or starting any later or conflict-resolution
work.
