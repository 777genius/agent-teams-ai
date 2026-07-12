# Phase 1 controller plan: single-source contracts and conformance

## Status and authority

- Status: current execution authority for serial `P1.S0` only
- Proposed packet revision: `phase-01-proposal-r2`
- Canonical planning base: `3bc0dfa7c00261785c0c752270cb302a9294e751`
- Phase 0 accepted freeze commit: `f4fa24aac9615a4ce10632965a2244a2e11a273e`
- Plan bundle commit / Phase 1 start SHA: not created
- Required decisions: ADR-15, ADR-19, ADR-20, plus the eventual frozen Phase 0 register
- Explicit authorization: `P1.S0` bootstrap only
- Authorized producer target: **one serial S0 worker**
- Later-subphase producer target: **zero**

All identifiers, paths, ownership, commands, thresholds, and pairings after S0 remain proposed until
serial bootstrap. This controller plan may render one bounded S0 bootstrap contract. It cannot render
or admit an S1-or-later worker, and S0 cannot edit product source.

The accepted `P0.D.TARGET_IMAGE` narrowing in the planning base closes that single Phase 0 gate for
the Phase 0-to-Phase 1 transition. It does not admit an image or composition: Phase 5 retains the exact
image/profile, provider canaries, complete inventory, terminal-negative scan, and standalone
production-composition gate. The accepted freeze removes this item from Phase 0 transition blockers.
Exact-image/profile proof, provider canaries, production composition, and terminal-negative admission
remain fail-closed implementation risks owned by later phases.

## P1.S0 authorization boundary

S0 starts from the accepted Phase 0 freeze and may only freeze the Phase 1 start SHA, packet revision,
exact identifiers, exact paths, owners, synthetic fixtures, commands, baseline fingerprints, and the
unique estimate allocation. It must preserve proposal status for every downstream work package. S0
does not create the contract kernel, adapters, feature code, routes, preload channels, renderer
facets, migrations, provider runtime, artifact composition, or terminal behavior.

S0 completion is evidence for a later router decision; it is not self-authority to start `P1.S1`.
The only current lane packet is
[`lanes/p1-s0-serial-bootstrap.md`](./lanes/p1-s0-serial-bootstrap.md). A worker-start contract that
binds any other Phase 1 lane conflicts with this controller and must be rejected.

## Outcome

Prove one small shared contract kernel and one read-only team-lifecycle query whose direct,
IPC-shaped, and HTTP-shaped test adapters call the same application use case and produce semantically
equivalent outcomes. Both transport-shaped adapters live under the test tree, are assembled only by
the conformance harness, and are rejected by production import/mount checks. Establish separate
feature-owned route/capability sources and enforceable
architecture/parity ratchets without creating an ElectronAPI clone, route framework, mega DTO, or
second lifecycle authority.

## Goals

- Freeze minimal conventions for opaque IDs, query context, revisions/cursors, safe errors, schemas,
  parsing, and version behavior.
- Create only the contracts needed by `ListTeamLifecycleSummaries` and its descriptors.
- Prove transport-neutral application semantics through three isolated test adapters.
- Cross-reference route, capability, auth policy, handler, client, schema, IPC, parity, and tests by
  stable proposed IDs while keeping their sources separate.
- Turn direct Electron/global transport use, hidden unsupported controls, forbidden imports, stale
  ledger signatures, and route/client/policy drift into failing tests.
- Leave a reviewed, reversible seam that Phase 2 can bind to canonical identity and production reads.

## Non-goals

- No Phase 2 identity substrate, canonical legacy adoption, filesystem-backed lifecycle repository,
  renderer cutover, hosted team list rollout, or state migration.
- No mutations, events publication, runtime launch/control, auth implementation, proxy/CORS changes,
  production hosted composition, Docker artifact, terminal, SSE, or WebSocket work.
- No production IPC channel, preload/global facet, or HTTP route. The IPC-shaped and Fastify adapters
  exist only in the isolated conformance test tree until canonical identity, a real authorized reader,
  and authenticated hosted composition exist.
- No change to existing `TeamsAPI.list`, `team:list`, `GET /api/teams`, `teamSlice`, or browser stub
  behavior except an integration-owned ratchet/quarantine annotation if bootstrap proves it necessary.
- No broad extraction from `src/main/ipc/teams.ts`, `src/main/http/teams.ts`, `TeamDataService`, or
  `teamSlice`; no all-parity schema/client generation.
- No generic DI container, service locator, transport framework, universal repository, or capability
  boolean per legacy method.

## Practical clean boundary

The new use case owns pagination, immutable projections, revision/cursor rules, and application
outcomes. Its consumer-owned port returns normalized legacy-safe records from an in-memory fixture in
Phase 1. Test-only input adapters own fake principal binding, wire parsing, and transport mapping. They
do not own filtering, errors, or pagination. Phase 2 may add production IPC/HTTP registration and
legacy/filesystem output adapters after stable identity exists without changing application semantics.

The new proof does not claim that a name is a `TeamId`. Fixture `TeamId` values are explicitly
synthetic and test-only. Production identity generation, persistence, and legacy mapping remain
blocked on Phase 2.

## Proposed subphases

| Subphase                       | Result                                                                                 | Admission                                       |
| ------------------------------ | -------------------------------------------------------------------------------------- | ----------------------------------------------- |
| `P1.S0` serial bootstrap       | Freeze exact IDs, files, owners, fixtures, baseline fingerprints, and packet revision. | Authorized now from accepted freeze `f4fa24aa`. |
| `P1.S1` foundations            | Contract kernel and route/catalog conventions.                                         | `P1.S0` integrated.                             |
| `P1.S2` parallel production    | Capability/route assertions and conformance/ratchet harnesses on disjoint paths.       | Foundation review passes.                       |
| `P1.S3` seam review            | R1 falsifies 1B/1C architecture, omission sensitivity, and production isolation.       | Both 1B and 1C complete.                        |
| `P1.S4` first proof and review | Team-lifecycle list query plus isolated test adapters, then R2 semantic review.        | R1 accepted before 1D; 1D complete before R2.   |
| `P1.S5` serialized integration | Shared ratchet/evidence wiring, full gate, rollback proof, evidence freeze.            | R2 accepted; one integration owner.             |

The detailed DAG and proposed ownership are in [execution-dag.md](./execution-dag.md).

## Controller invariants

1. Never start `P1.S0` from a moving branch or from this planning worktree.
2. Every implementation child starts from one `phaseStartSha` containing the reviewed bundle and
   serial bootstrap evidence.
3. A path has one live writer. Production registration files are read-only throughout Phase 1; any
   other existing shared ratchet/evidence file has only the integration owner.
4. A proposed ID has one evidence owner; reviewers may falsify it but not publish a competing row.
5. No lane is refilled merely to preserve concurrency. Replacement preserves worktree and handoff or
   records an explicit salvage/supersession decision.
6. Test-only IPC and HTTP adapter/composition modules must be impossible to import or mount from any
   production composition, preload, renderer API, IPC registry, or HTTP registry.
7. Negative fixtures are acceptance evidence; weakening them requires packet revision and review.
8. No real user project, provider credential, host path, or raw auth/runtime payload enters fixtures or
   handoffs.

## Monitoring and stop conditions

Check useful progress at least every ten minutes while jobs exist. Stop the affected lane on stale
base/revision, write overlap, unknown evidence ID, source/packet mismatch, dependency change,
production IPC/HTTP exposure, direct renderer transport bypass, fake browser implementation, raw path
or secret evidence, filesystem-backed Phase 1 adapter, god contract, or unclassified baseline failure.
Return the blocker record defined by
`PACKET_STANDARD.md`; unrelated lanes may continue only when their inputs and paths remain valid.

## Integration gate

The integration owner follows [conformance-and-tests.md](./conformance-and-tests.md) and must prove:

1. Contracts, domain, and application ports import no Electron, Fastify, React, Zustand, Node
   infrastructure, or `@main`.
2. Direct, IPC-shaped, and HTTP-shaped test adapters normalize the same complete use-case outcome
   oracle, including explicit applicability/deferral classifications.
3. Route and capability sources cross-reference stable IDs but remain separate data structures.
4. Both transport-shaped adapters and their route/channel identifiers are absent from production
   composition; a deliberate production import/mount of either fails before runtime.
5. Unknown-field/version, revision, cursor, auth, error redaction, and cancellation semantics pass.
6. ADR-19 checks detect legacy signature drift and missing route/action/client/schema/test references.
7. ADR-20 checks detect direct transport imports and hosted reachability of desktop-only modules.
8. Deliberately invalid dependencies, route duplicates, unsupported UI actions, ElectronAPI facet
   implementations, and any path-taking/filesystem-backed Phase 1 reader or adapter fail for the
   expected diagnostic.
9. Formatting, focused tests, typecheck, full relevant architecture tests, diff check, scope check, and
   secret/path scan pass or have an unchanged inherited-failure fingerprint.

## Definition of Done

- [ ] Every Ready item passed before work began.
- [ ] All frozen evidence IDs are adopted, rejected, or explicitly deferred with rationale.
- [ ] One minimal contract kernel and the first feature-owned contracts exist; no speculative parity
      DTOs or empty ceremonial layers exist.
- [ ] The three-adapter conformance matrix passes against the same fixture vectors and use-case spy.
- [ ] RouteCatalog, capability descriptors, auth policies, parity records, and test metadata reconcile
      without merging into one runtime manifest.
- [ ] Every current TeamsAPI member and renderer bypass remains classified; only the first proposed
      read mapping advances proof level.
- [ ] Production hosted routing remains unchanged; renderer and legacy API behavior remain unchanged.
- [ ] Ratchet, migration, rollback, observability, performance, dependency, and cache evidence pass.
- [ ] Reciprocal reviewers approve scope/architecture and semantic/security evidence.
- [ ] Clean integration attempt and required checks are recorded with exit codes and exact SHA.
- [ ] Decision register, evidence index, estimate reconciliation, risk disposition, and Phase 2 input
      packet are frozen from actual integrated evidence.

None of these Phase 1 completion conditions is claimed by the S0-only authorization.
