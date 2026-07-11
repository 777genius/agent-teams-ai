# Phase 1 packet inputs

## Supported inputs

| Input                       | Current support                                                                                | Use in this draft                                                                         |
| --------------------------- | ---------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Parent plan Phase 1 outcome | Tasks 1-12 and the Phase 1 exit gate at `docs/hosted-web-e2e-completion-plan.md`               | Defines the intended contract/conformance outcome only.                                   |
| Packet lifecycle            | `docs/hosted-web-phases/PACKET_STANDARD.md` and execution router                               | Requires a blocked draft until predecessor freeze facts exist.                            |
| Phase 0 start               | `a32f509e6d9bd31ba2135940e336729bf90c3d93`                                                     | Proven common producer base; not a Phase 0 completion SHA.                                |
| W1/W2 review                | Both rejected; only W1 selection invariants and W2 source-observed topology approved as useful | Blocks semantic parity/action and ingress/environment contract inputs pending correction. |
| W3/W5 review                | Pair rejected with RW35-001 through RW35-006                                                   | Blocks using current recovery/writer claims as frozen Phase 1 assumptions.                |
| W4/W6 review                | Pair rejected with R46-01 through R46-08                                                       | Blocks treating host/auth/artifact decisions as frozen.                                   |
| Current artifact conclusion | W6 producer and review agree current standalone output is not an acceptable v1 hosted artifact | Phase 1 must not enable hosted mutation or claim production composition.                  |
| Cross-lane audit            | Holds all adoption; 24 findings, nine held files, zero immediately adoptable files             | Confirms correction/re-review and controller-ledger reconciliation precede integration.   |

## Missing or contradicted inputs

| Required packet input                                    | State                | Owner/action                                                                                                                                     |
| -------------------------------------------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Frozen Phase 0 decision register                         | Missing              | Integration controller resolves all review/audit findings and records final states.                                                              |
| Predecessor integration commit                           | Missing              | Integration controller records the reviewed Phase 0 commit after adoption and final gates.                                                       |
| Predecessor evidence-index SHA-256                       | Missing              | Generate from adopted evidence, not this assembly snapshot.                                                                                      |
| W1/W2 accepted re-review                                 | Contradicted         | Producers correct R12 findings; reviewer re-runs focused review.                                                                                 |
| W3/W5 accepted re-review                                 | Contradicted         | Producers correct RW35 findings; reviewer re-runs focused review.                                                                                |
| W4/W6 accepted re-review and target topology             | Contradicted/missing | Producers correct R46 findings; run exact final-shape probes.                                                                                    |
| Cross-lane integration-prep audit registry finalization  | Incomplete           | Worktree-local manifest exists; controller records the result and refreshes it after corrections/re-review.                                      |
| Requirement-to-evidence audit registry finalization      | Incomplete           | Worktree-local matrix rejects acceptance (17 satisfied, 14 partial, 28 failed, 5 missing, 6 pending); controller records and later refreshes it. |
| Reconciled unique-bucket estimate                        | Missing              | Controller deduplicates all lane inputs and resolves >20% variance.                                                                              |
| Exact Phase 1 owned paths and shared integration writers | Missing              | Derive after frozen contracts/IDs and current integration tree are known.                                                                        |
| Inherited failure ledger after final Phase 0 gate        | Missing              | Run and classify the required final gates.                                                                                                       |
| Explicit Phase 1 authorization                           | Pending              | User/controller supplies authorization after packet becomes ready.                                                                               |

## Candidate contract vocabulary that is not yet frozen

The parent plan supports a tiny shared kernel of opaque IDs, request context, revisions/cursors, and
safe application-error categories; feature-specific DTOs/errors stay feature-owned. It also supports
separate RouteDescriptor, capability/action, and parity-ledger sources rather than a merged god
manifest. These are parent-plan constraints, not evidence that the exact Phase 1 contract IDs, paths,
schemas, or first read use case have been accepted.

The first proof remains a read-only team-lifecycle query shared by test, IPC, and Fastify adapters. Its
exact query name, DTO, route ID, IPC channel, ownership, and fixture IDs must be chosen in the frozen
packet rather than guessed here.
