# Phase 1 inputs and prerequisite gates

Status: blocked proposal. All IDs and paths below are proposed until serial bootstrap.

## Provenance

| Fact                                            | Current value                                                      | Consequence                                                                         |
| ----------------------------------------------- | ------------------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| Exact planning base                             | `3bc0dfa7c00261785c0c752270cb302a9294e751`                         | Exact base for this reconciled bundle; not a Phase 1 start SHA.                     |
| Prior approved-plan predecessor                 | `42ec333848e29e97c41699b9fed73ed199740e3f`                         | Source of the independently approved plan content; superseded as the planning base. |
| Phase 0 start                                   | `a32f509e6d9bd31ba2135940e336729bf90c3d93`                         | Provenance only; not completion evidence.                                           |
| Earlier integrated Phase 0 evidence predecessor | `c958c872fa22edf9b2d6a0741d7781b00957903c`                         | Remains the evidence role recorded by the current freeze candidate.                 |
| Phase 0 freeze integration commit               | Missing                                                            | Phase 1 remains blocked.                                                            |
| Candidate evidence-index SHA-256                | `d5c8725dfb22f7e0228e0dd51f53d978d117ed7253fdb279c8ddba7000ff8758` | Candidate only; must be replaced by the integrated digest.                          |
| Target-image decision                           | `P0.D.TARGET_IMAGE`: accepted narrowing                            | Closes the Phase 0 target-image gate; does not admit an image.                      |
| Phase 1 plan-bundle commit                      | Missing                                                            | Controller records it only after fresh review and integration.                      |
| Phase 1 start SHA                               | Missing                                                            | Created only after an authorized serial bootstrap.                                  |
| Implementation authorization                    | Not granted                                                        | This task authorizes planning only.                                                 |

`3bc0dfa7…` is one direct descendant of `42ec33384…`. It adds the accepted target-image narrowing but
does not rewrite the distinct Phase 0 evidence roles inside the freeze candidate.

## Plan-review provenance

- The remediation patch with SHA-256
  `cb38128a28e4f1edfacf5242579d421c16c295a638f98ec71cdb0a5aee42e830` received independent
  `APPROVE` for its exact blocked planning scope. Its architecture, DAG, transport boundaries,
  conformance design, gap dispositions, and operational controls are preserved here.
- The subsequent adoption patch with SHA-256
  `82e07f79d9f53d1ec9ba9253a380f24a786d547387857a5df4229f09b2a16295` was rejected only because
  it carried the stale exact-image prerequisite onto `3bc0dfa7…`. It is superseded by this
  reconciliation and is not integration authority.
- Because this bundle changes the approved prerequisite semantics, `P1.GATE.PLAN_REVIEW` remains
  pending fresh exact-base review. Prior approval is evidence for preserved content, not approval of
  this new diff.

## Supported inputs

- Parent-plan Phase 1 tasks 1–12, exit gate, ADR-15, ADR-19, ADR-20, and the feature architecture
  standard define the intended result.
- The current W1 parity ledger classifies `P0.W1.API.TeamsAPI.list` as a decomposed
  `team-lifecycle` read with proposed action `team.lifecycle.list`.
- Current source confirms four inconsistent legacy seams: `TeamsAPI.list`, `team:list`,
  `GET /api/teams`, and a browser implementation that warns and returns `[]`.
- Phase 0 W1/W2, W3/W5, and W4/W6 current dispositions may inform Phase 1 without upgrading
  characterization to target verification.
- `docs/research/hosted-web/phase-0/auth-artifacts/target-image-admission.json` records
  `P0.D.TARGET_IMAGE` as accepted, `phase0Gate=closed_by_accepted_narrowing`, and
  `exactImageEarliestOwner=phase-5`. Its Phase 5 admission remains fail closed with all 51
  canonical-source gaps and nine terminal-sensitive surfaces preserved.
- The freeze candidate's older statement that final target-image proof is a current Phase 0 blocker
  is narrowly superseded by that accepted decision. Its pending integration/digest, estimate, final
  gate, decision-register, bootstrap, and authorization blockers are not superseded.
- Historical R12, RW35, R46, hold-all-adoption, and failed-freeze conclusions remain superseded as
  current authority. Their bytes remain historical evidence.

## Blocking prerequisite gates

Every row must have controller-owned evidence and an explicit pass before implementation packet
materialization.

| Proposed gate              | State                  | Required proof                                                                                                                                                                                                                                 |
| -------------------------- | ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `P1.GATE.BASE`             | Pass for planning only | Exact planning base is `3bc0dfa7…`; no Phase 1 implementation worktree exists.                                                                                                                                                                 |
| `P1.GATE.P0_FREEZE`        | Blocked                | Independent review and integration of a Phase 0 freeze candidate reconciled with `P0.D.TARGET_IMAGE`.                                                                                                                                          |
| `P1.GATE.P0_DIGEST`        | Blocked                | Integrated evidence-index digest and byte provenance recorded.                                                                                                                                                                                 |
| `P1.GATE.TARGET_IMAGE`     | Pass by narrowing      | Base records the Phase 0 gate closed by accepted narrowing. Exact image/profile, target-executed provider canaries, full inventory, terminal-negative admission, and standalone production composition remain fail-closed Phase 5 obligations. |
| `P1.GATE.P0_FINAL`         | Blocked                | Final Phase 0 broad gate, including comparison with the inherited seven-diagnostic typecheck set; failures are classified, not normalized into passes.                                                                                         |
| `P1.GATE.ESTIMATE`         | Blocked                | Unique-bucket estimate reconciliation with duplicates removed and variance resolved.                                                                                                                                                           |
| `P1.GATE.DECISIONS`        | Blocked                | The complete Phase 0 decision register is frozen with the accepted target-image narrowing and every other outcome recorded as accepted, narrowed, reopened, or blocked; no producer recommendation is silently frozen.                         |
| `P1.GATE.PLAN_REVIEW`      | Pending                | This reconciled bundle receives fresh architecture, security, test, and scope review against its exact commit.                                                                                                                                 |
| `P1.GATE.SERIAL_BOOTSTRAP` | Blocked                | Proposed IDs, paths, fixtures, commands, shared writers, and review pairs are checked against integrated source and frozen in one bootstrap commit.                                                                                            |
| `P1.GATE.AUTHORIZATION`    | Blocked                | Fresh explicit user/controller authorization for Phase 1 implementation.                                                                                                                                                                       |

The passed target-image row is not an image-admission claim and cannot be used to mount a route,
advertise a capability, enable mutation, or compose a standalone production server. Those actions
remain behind the fail-closed Phase 5 gate.

## Definition of Ready

- [ ] Every blocking prerequisite above passes at its required proof level.
- [ ] The router marks Phase 1 ready and Phase 0 frozen; no two phases are active.
- [ ] The reviewed plan bundle commit, parent-plan commit, predecessor commit, evidence digest, and
      inherited-failure ledger are recorded without conflating provenance roles.
- [ ] Serial bootstrap resolves every proposed identifier and confirms every proposed path exists or
      is legal to create on the integrated predecessor.
- [ ] The first slice remains read-only; both IPC-shaped and HTTP-shaped adapters are test-only and
      production-unreachable, so no identity or auth shortcut is required.
- [ ] Exact non-overlapping writer sets, shared-writer owner, reciprocal reviews, estimates, and checks
      are frozen.
- [ ] No dependency or lockfile change is required; otherwise the controller issues a separately
      reviewed packet revision.
- [ ] Baseline tests and architecture scans run from the eventual `phaseStartSha`; inherited failures
      have owners and fingerprints.
- [ ] Explicit implementation authorization is attached.

Failure of any item keeps producer target at zero. Planning completeness is not implementation
readiness.

## Gap-audit disposition register

Every audited gap remains carried by ID into serial bootstrap. “Proposal-resolved” means this bundle
chooses a coherent design; it is not target verification or permission to implement. “Acceptance
gate” means the choice must become an executable positive/negative fixture at `P1.S0`. A deferred row
names its later owner and a Phase 1 gate that prevents the deferred concern from entering this phase.

| Audit ID     | Proposal disposition                                                                                                                                                                                                                                           | Required carry-forward evidence                                                                                                                                                                                               |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `P1-GAP-001` | Proposal-resolved: Phase 1 owns a non-advertised conformance specimen; Phase 2 owns canonical identity, real readers, and production registration. Both IPC and HTTP adapters are test-only.                                                                   | `P1.NEG.PRODUCTION_ADAPTER_MOUNT` proves neither adapter is production-importable or mountable.                                                                                                                               |
| `P1-GAP-002` | Proposal-resolved: the allowlisted `TeamLifecycleSummary` projection is not a legacy aggregate and contains no raw name/path identity.                                                                                                                         | `P1.NEG.LEGACY_GOD_DTO` plus schema fixtures.                                                                                                                                                                                 |
| `P1-GAP-003` | Proposal-resolved and acceptance-gated by the complete outcome applicability/oracle table in [conformance-and-tests.md](./conformance-and-tests.md).                                                                                                           | `P1.NEG.SEMANTIC_OUTCOME` and normalized-vector manifest, including all audited states.                                                                                                                                       |
| `P1-GAP-004` | Proposal-resolved: no Phase 1 production route or IPC channel exists; test admission binders are conformance inputs, not product auth.                                                                                                                         | Production mount/import failure and absent-capability assertions.                                                                                                                                                             |
| `P1-GAP-005` | Acceptance-gated: the finite proposed kernel grammar must be frozen without widening during `P1.S0`.                                                                                                                                                           | Round-trip and malformed/version/ID/revision/cursor fixtures.                                                                                                                                                                 |
| `P1-GAP-006` | Proposal-resolved: pairwise writer sets and the sole integration writer are listed in [execution-dag.md](./execution-dag.md).                                                                                                                                  | Exact no-glob path manifest and overlap check at `P1.S0`.                                                                                                                                                                     |
| `P1-GAP-007` | Acceptance-gated: every named negative in [conformance-and-tests.md](./conformance-and-tests.md) requires an adjacent positive, mutation, stable diagnostic, command, and owner.                                                                               | Frozen fixture manifest; category-only evidence is rejected.                                                                                                                                                                  |
| `P1-GAP-008` | Acceptance-gated: path/symbol baselines are monotonic and exception rows have owner, reason, introduced revision, removal phase, and expiry test.                                                                                                              | Rollback keeps all legacy production behavior unchanged and both specimen adapters unreachable.                                                                                                                               |
| `P1-GAP-009` | Explicitly deferred to Phase 2's first filesystem-backed adapter: `P1.NEG.TEST_ROOT_ESCAPE` will require fresh marked temporary project/runtime roots, pre-access rejection of unmarked/ambient/home/symlink-escaped roots, and marker-checked narrow cleanup. | Phase 1 must instead pass `P1.NEG.NO_FILESYSTEM_ADAPTER_PHASE1`, rejecting any path-taking, filesystem-backed, ambient-root, watcher, repair, or cleanup dependency in the specimen, reader, adapters, fixtures, or commands. |
| `P1-GAP-010` | Acceptance-gated: deterministic latency, cancellation, payload/count, invocation, cache/revision, fallback/source, and redacted telemetry budgets are mandatory.                                                                                               | Performance and determinism vectors at fixed 1/50/200-item scales.                                                                                                                                                            |

No disposition may be dropped from the bootstrap decision record. Any proposal-resolved row that
cannot be frozen reopens as a blocker; deferral of `P1-GAP-009` is valid only while the strict Phase 1
no-filesystem-adapter gate passes.

## R1 remediation register

These are planning corrections pending independent re-review, not closed implementation evidence.

| Finding     | Correction in this bundle                                                                                                                                                                  | Re-review proof                                                                                  |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| `P1-R1-001` | Both IPC-shaped and HTTP-shaped adapters, identities, identifiers, and composition are isolated under the test tree; Phase 1 adds no IPC/preload/renderer/HTTP registration.               | Deliberate production import/mount failures for both adapters and an unchanged production graph. |
| `P1-R1-002` | Diagram, lane dependencies, capacity, review order, and adoption order all use exactly `1B + 1C -> R1 -> 1D -> R2 -> I`.                                                                   | Structural DAG comparison across the plan bundle.                                                |
| `P1-R1-003` | `P1.NEG.TEST_ROOT_ESCAPE` is explicitly deferred to Phase 2's first filesystem adapter with marked-root controls; Phase 1 has a strict no-path/no-filesystem-adapter gate.                 | Positive in-memory fixture plus a path-taking adapter that fails before execution.               |
| `P1-R1-004` | Every audited state is classified applicable or inapplicable, with a normalized outcome, warnings/partial policy, ordering, revisions, adapter metadata, negative vector, and later owner. | Complete semantic vector manifest and R2 comparison across all three test paths.                 |
