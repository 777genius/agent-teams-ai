# Phase 0 acceptance gap register

## Method

Each row maps a parent-plan or Phase 0 packet exit requirement to the strongest inspected evidence.
`Supported` means the current record proves the stated limited claim. `Partial` means useful evidence
exists but cannot close the requirement. `Contradicted` means a review reproduced or identified a
failure against the required contract. `Missing` means no authoritative record was found. None of these
labels claims controller adoption.

The independent requirements audit reached the same reject-pending-correction disposition across 70
checks: 17 satisfied, 14 partial, 28 failed, five missing, and six pending. This register is a compact
parent-exit/packet-DoD projection, not a replacement for that worktree-local machine matrix.

## Parent-plan exit gate

| Requirement                                                                      | Strongest current evidence                                              | Disposition  | Required closure                                                                                                                                |
| -------------------------------------------------------------------------------- | ----------------------------------------------------------------------- | ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Product decisions for the first vertical slice are explicit                      | 0A decision register plus lane recommendations                          | Partial      | Resolve reciprocal-review findings and freeze every required decision as accepted, narrowed, reopened, or blocked.                              |
| Current desktop behavior is characterized                                        | W1 renderer/action inventories and W3/W5 current-state catalogs         | Partial      | Correct the rejected W1 semantic inventory/scanner and complete the requirements audit.                                                         |
| Exact-base CI is green or failures have accepted isolation                       | 0A baseline classifies five lint errors in two `base_owned_fix` records | Partial      | Record adopted prerequisite fixes, run the packet's uncaptured commands, and run the final Phase 0 gate.                                        |
| Architecture tests fail on deliberate negatives and pass on the initial skeleton | Producer scanners include negative fixtures                             | Partial      | Review/adopt the valid fixtures and run combined checks against the integrated evidence; no Phase 1 skeleton exists yet.                        |
| Every runtime-control producer/verb has explicit ingress/outbound direction      | W2 runtime-ingress inventory                                            | Partial      | Correct the rejected nested schemas/fixtures and close permission-direction, relay, authority, and credential gaps.                             |
| Every legacy member and visible hosted action has one disposition                | W1 producer counts plus rejected semantic mapping                       | Contradicted | Replace heuristic JSX rows with reviewed stable semantic action IDs and reconcile W1/W2 ownership.                                              |
| Both real execution topologies have characterization fixtures                    | W2 topology approved as useful; fake-runtime matrix rejected            | Partial      | Add every required provider matrix case and prove provider/version assumptions and disjoint child environments before capability advertisement. |
| ADR-16 lease passes final volume/container topology                              | W4 current-host fixture                                                 | Missing      | Correct R46-04/R46-06, then run two final-image containers plus manual contender with stable-inode and descriptor-leak proof.                   |
| ADR-28 guard passes final-image race/exec/Git suite                              | W4 current-host guard and negative raw-Node control                     | Missing      | Correct paired artifact contract and rerun in the admitted non-root init/seccomp/filesystem topology.                                           |
| Hosted artifact has no required empty-stub or wrong-ABI dependency               | W6 artifact scan                                                        | Contradicted | Build the allowlisted hosted artifact with required worker/native artifacts and rerun ABI/stub/terminal-negative probes.                        |
| State families have compatibility range and migration owner                      | W3 catalog accepted as useful by reciprocal review                      | Partial      | Correct W3 backup characterization, complete provider/version writer evidence, and adopt a reviewed compatibility manifest.                     |
| External-writer operations have one safe ADR-29 class                            | W3 writer evidence; W5 classes                                          | Contradicted | Reclassify W5 task/inbox effects to agree with W3 and prove any automatic recovery through durable dedupe/lookup.                               |
| Child environment provenance and relay canaries prove ADR-30                     | W2 environment provenance rejected; relay absent                        | Contradicted | Discover source keys independently, require classifications, and obtain accepted fixture evidence for allowlists and relay isolation.           |
| ADR-31 anchor passes final-image ownership/drain/PID-reuse                       | W4 process fixture                                                      | Contradicted | Correct reusable numeric-PID signaling, cleanup truth, high-FD closure, and run final-image PID/PGID reuse/drain tests.                         |
| SQLite Online Backup is verified with WAL and no raw copy                        | W3 fixture-characterized Online Backup                                  | Partial      | Add the required production-worker/final-ABI proof and retain full deployment backup as disabled until quiescence is proven.                    |
| ADR-33 schedules are exhaustive and gap-free                                     | W5 scheduler                                                            | Contradicted | Make commit/compensation/publication boundaries real crash/restart transitions and rerun the negative schedules.                                |
| ADR-34 catalogs cover every mutation and effect class                            | W5 catalogs/goldens                                                     | Contradicted | Use an independent mutation census, reconcile W3 writer classes, add retained fingerprint/default vectors, and re-review.                       |
| ADR-7 restart/reset/proxy schedules close authority gaps                         | W6 auth fixture                                                         | Contradicted | Prevent revoked authority resurrection, bind reset to generation-scoped W4 `drained`, and run the final HTTPS edge matrix.                      |
| Unique-bucket estimate is reconciled and terminal is zero                        | 0A estimate plus lane estimates                                         | Partial      | Deduplicate W3/W5 and all other overlaps, resolve variances, regenerate the controller-owned ledger, and review it.                             |
| No new browser stub lacks a capability classification                            | Oversized W1 bypass projection and W6 scan                              | Partial      | Compact/hash the W1 projection, correct semantic actions, complete cross-lane audit, and validate the integrated capability ledger.             |

## Packet Definition of Done

| Packet requirement                                                               | Disposition                   | Evidence/gap                                                                                                                                                         |
| -------------------------------------------------------------------------------- | ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Reproducible 0A base/baseline                                                    | Partial                       | Base, plan, phase-start, and baseline records exist; literal 0A command coverage and final rerun remain incomplete.                                                  |
| All lanes start at `phaseStartSha`                                               | Supported                     | All six producer results record `a32f509e6d9bd31ba2135940e336729bf90c3d93`.                                                                                          |
| All six lanes reviewed and adopted or explicitly rejected by controller decision | Missing                       | All three pair reviews reject outputs; the cross-lane audit holds all adoption and reports zero immediately adoptable files; no controller adoption decision exists. |
| Every parent-plan exit gate has evidence                                         | Missing                       | This matrix identifies unsupported, contradicted, and missing gates; it does not close them.                                                                         |
| Native/container claims ran in supported target topology                         | Missing                       | W4 explicitly lacked Docker/final-image access.                                                                                                                      |
| Estimate/salvage/parity/state/provider/artifact ledgers generated and validated  | Partial                       | Producer ledgers exist in separate worktrees; review/adoption/audit and shared regeneration remain pending.                                                          |
| Required broad gates green or accepted isolated base failures only               | Missing                       | No final Phase 0 broad gate was inspected.                                                                                                                           |
| No hosted product mutation or terminal implementation enabled                    | Supported for inspected diffs | Producers and reviews report evidence-only scope; integration/audit confirmation remains pending.                                                                    |
| Integration worktree clean after Phase 0 commits                                 | Missing                       | No final adoption sequence or integration cleanliness record was inspected.                                                                                          |
| Phase 0 completion report with residual risks                                    | Missing                       | This gap register is not a completion report.                                                                                                                        |
| Phase 1 JIT packet generated from frozen decisions/current integration SHA       | Blocked                       | The draft packet intentionally has no predecessor freeze SHA or executable lane packets.                                                                             |

## Mandatory next sequence

1. Correct W1/W2, W3/W5, and W4/W6 findings, then repeat focused reciprocal reviews.
2. Registry-finalize and later refresh both audit records after corrections/reviews.
3. Adopt only approved evidence through the integration lifecycle; regenerate decision, estimate,
   salvage, and lane ledgers.
4. Run the required target-topology probes and Phase 0 combined/final gates.
5. Freeze Phase 0 and only then replace the blocked Phase 1 draft with a revisioned ready packet and
   exact non-overlapping lane ownership.
