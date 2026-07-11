# Phase 1: single-source contracts and conformance

## Status and authority

- Status: `blocked`
- Packet revision: `phase-01-draft-r0`
- Parent plan commit: `f1ad7a8cba2f26abf5f42ddd206937c24d143f77` (Phase 0 plan-bundle adoption)
- Predecessor integration commit: `missing`
- Predecessor evidence index SHA-256: `missing`
- Plan bundle commit: `missing for Phase 1`
- Phase start SHA: `missing`
- Required ADR IDs: ADR-15, ADR-19, ADR-20, plus frozen Phase 0 decisions
- Explicit authorization: `pending after Phase 0 freeze`

This draft is not an active packet. It records the supported packet skeleton without inventing the
predecessor facts, contract IDs, exact owned paths, or proof topology that Phase 0 must freeze.

## Outcome

Establish one small shared contract kernel, feature-owned route/capability descriptors, repeatable
conformance gates, and one read-only team-lifecycle vertical proof whose test, IPC, and Fastify adapters
reach the same application use case without transport types entering application code.

## Inputs and inherited failures

- Parent-plan Phase 1 tasks 1-12 and exit gate.
- Packet lifecycle and proof semantics from `docs/hosted-web-phases/PACKET_STANDARD.md`.
- Common Phase 0 producer base `a32f509e6d9bd31ba2135940e336729bf90c3d93`, which is not a
  predecessor completion commit.
- Registry projection and gaps under `docs/research/hosted-web/phase-0/evidence/`.
- The 0A inherited lint ledger remains historical input only; its adoption/rerun outcome must be
  refreshed by the final Phase 0 gate.
- Reopened/blocking evidence includes every R12, RW35, and R46 finding, the cross-lane audit's hold on
  all adoption, the requirements audit's rejection of acceptance/freeze, and all target-topology gaps.

No producer ADR recommendation is treated as frozen merely because its lane completed.

## Non-goals

- No Phase 2 identity substrate, state migration, hosted team read rollout, or renderer screen
  migration.
- No mutation command/effect implementation, runtime launch/control, auth enablement, proxy/CORS
  change, hosted production composition, or final Docker artifact.
- No hosted terminal route, gateway, daemon, SDK, migration, capability, or generic WebSocket layer.
- No ElectronAPI-compatible browser client, generated mega-client, all-parity DTO, god facade,
  universal repository, service locator, or dependency-injection container.
- No broad extraction from `teams.ts`, TeamDataService, teamSlice, or TeamDetailView beyond the one
  accepted read-only proof and its explicitly owned migration adapter.

## Definition of Ready

- [ ] Phase 0 freeze is complete and records all decisions as accepted, narrowed, reopened, or blocked.
- [ ] Corrected W1/W2 evidence has passed focused reciprocal re-review.
- [ ] Corrected W3/W5 and W4/W6 evidence has passed focused reciprocal re-review.
- [ ] Cross-lane and requirements audit records are complete, current after corrections, and
      registry-final.
- [ ] Predecessor integration SHA and evidence-index SHA-256 are recorded.
- [ ] Phase 0 target-topology requirements and final broad gate are satisfied or have explicit
      capability-narrowing decisions permitted by the parent plan.
- [ ] Reconciled estimate and inherited-failure ledgers are frozen.
- [ ] Exact Phase 1 contract IDs, first read use case, owned paths, shared writers, lane checks, and
      review pairs have no overlap.
- [ ] Required deterministic fixture topology exists.
- [ ] Rollback/ratchet behavior is recorded for every changed bypass or read path.
- [ ] Child worktrees will be created only after the Phase 1 packet bundle and serial bootstrap
      evidence are included in a new `phaseStartSha`.
- [ ] Explicit Phase 1 implementation authorization has been received.

Until every item is checked, producer target is zero and no worker prompt may be rendered.

## Proposed DAG and work-package registry

The following is the parent-plan dependency shape, not an executable lane registry.

| Work package             | Parent-plan result                                                                             | Dependencies                                              | Evidence shape                                          | Ownership state |
| ------------------------ | ---------------------------------------------------------------------------------------------- | --------------------------------------------------------- | ------------------------------------------------------- | --------------- |
| 1A Contract conventions  | Opaque IDs, request context, revisions/cursors, safe errors, first read DTO/schema conventions | Frozen Phase 0 decisions and reviewed W1 ledger           | Contract import/schema/version negatives                | Unassigned      |
| 1B Capability and routes | Feature-owned RouteDescriptor/CapabilityDescriptor sources and narrow renderer facets          | 1A; accepted W1/W2 terminology                            | Route/capability/client/policy cross-reference evidence | Unassigned      |
| 1C Conformance gates     | Import, dependency, no-stub, route/client/schema, IPC/HTTP outcome, and mount/action negatives | Frozen conventions; reviewed W1 bypass/action inputs      | Deliberate positive/negative fixtures                   | Unassigned      |
| 1D First read proof      | One read-only lifecycle query through test, IPC, and Fastify adapters                          | 1A; route convention from 1B; conformance harness from 1C | Semantic conformance and transport-boundary proof       | Unassigned      |

Serial bootstrap must freeze conventions and exact IDs before parallel work. The parent plan permits 1B
and 1C to proceed in parallel against frozen conventions; 1D closes the phase only after the
conformance seams exist. Shared RouteCatalog, architecture gates, public feature entrypoints, IPC
registration, HTTP composition, and any global ratchet have one serialized integration owner.

No lane packet is materialized in this draft because exact non-overlapping writable paths, evidence
IDs, review pairs, and commands are predecessor-dependent.

## Capacity epochs

When a ready revision exists, it must define unique slots for serial bootstrap, contract/route/gate
production, cross-review, and serialized integration. A slot can be retried only with a recorded
supersession/salvage decision. Static templates are not a refill queue. The generic producer target
remains zero for this draft.

## Monitoring and intervention

- Check project-scoped useful progress at least every ten minutes while jobs are active.
- Stop a lane on stale predecessor facts, contract-ID drift, overlapping writes, out-of-scope renderer
  migration, a fake browser stub, or a new god-contract/facade.
- Treat a failing negative fixture as evidence to narrow the design, not permission to weaken the gate.
- Do not admit later work to preserve worker count; 1A ordering and serialized integration take
  precedence.
- Keep all fixtures on temporary/test-only projects and redact secrets, raw auth/provider payloads,
  host paths, and sensitive command bodies.

## Integration gate

The ready packet must require, per lane, scope review, deterministic positive/negative fixtures,
targeted `pnpm lint:fast:files`, focused tests, a diff check that covers new files, schema validation,
secret/path scan, evidence-ID reconciliation, and a clean integration attempt. TypeScript production
changes also require the project typecheck at the integration stage.

Integration must prove:

1. contract/domain/application-port code imports no Electron, Fastify, React, Zustand, `fs`, `path`,
   or `@main`;
2. RouteCatalog, capability/action descriptors, authorization policy, client routes, and parity records
   cross-reference stable IDs without becoming one runtime god manifest;
3. direct Electron/global-client/transport access fails the ratchet for the migrated slice;
4. unsupported controls and effects are absent before mount, not handled by a thrown/no-op call;
5. one read use case produces semantically equivalent outcomes through test, IPC, and HTTP adapters;
6. no hosted facet can implement ElectronAPI and no all-parity DTO/interface is introduced.

A finding returns the owning package for correction and focused re-review. It is not resolved by
editing another lane during integration.

## Definition of Done

- Every ready-packet evidence ID is reviewed and adopted, rejected, or explicitly deferred.
- RouteCatalog and the separate capability/action ledger cross-reference owner, auth policy, handler,
  client, schema, and test/E2E status for the first accepted slice.
- ADR-19 records fail on legacy signature drift, missing semantic obligations, and a hosted-visible
  desktop-only action.
- The first read route/client/parser reaches one application use case through the semantic conformance
  harness.
- Every current renderer TeamsAPI call remains classified and every direct bypass is either failing the
  gate or quarantined by an exact owner/removal phase.
- New contracts satisfy the dependency/import negatives and no all-parity mega DTO/interface exists.
- Inherited and new failures are classified; the integration attempt and required checks are green.
- Ratchet/rollback evidence proves the old authority was removed or explicitly quarantined for the
  migrated read seam.
- Phase 1 decisions and unique estimate buckets are frozen.
- The Phase 2 packet is materialized only from the resulting Phase 1 integration evidence.

None of these completion conditions is claimed by this draft.
