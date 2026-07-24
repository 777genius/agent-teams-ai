# Phase 2: identity substrate and read-only team lifecycle

- Status: `candidate / product blocked`
- Packet revision: `phase-02-jit-router-r1`
- Router base and accepted Phase 1 integration: `d5afa87e79b1f2badd69e65262e5699c0fb61de7`
- Terminal state: `HOLD`

This minimal JIT packet turns the accepted Phase 1 exit into one bounded Phase 2 execution wave. It
does not implement product code and is not launch authority until independently reviewed and
broker-integrated.

## Outcome

Establish the identity foundation first, then produce five independently testable, non-overlapping
product slices: workspace identity, team identity, workspace binding, roster identity and legacy
adoption. The slices retain their focused runtime-context, durable-record, workspace-admission,
directory-safety and transport-neutral read proofs. A later serial integration node alone owns shared
exports, composition and legacy boundary wiring.

## Packet map

- [controller-packet.md](controller-packet.md): authority, readiness, capacity, review and integration
  policy.
- [execution-dag.md](execution-dag.md): the only legal node ordering.
- [P2.F0 identity foundation](lanes/p2-identity-foundation.md): short serial foundation.
- [P2.A workspace identity](lanes/p2-a-workspace-identity.md).
- [P2.B team identity](lanes/p2-b-team-identity.md).
- [P2.C workspace binding](lanes/p2-c-workspace-binding.md).
- [P2.D roster identity](lanes/p2-d-roster-identity.md).
- [P2.E legacy adoption](lanes/p2-e-legacy-adoption.md).

## Hard boundaries

- `P2.A` through `P2.E` start only after accepted foundation integration and may then run in one
  exactly-five-lane product epoch.
- Parallel lanes share no writable path and own no barrel, index or composition file.
- Product core follows Clean Architecture, DDD and SOLID. Transport and filesystem details depend on
  application ports; core never depends on Electron, HTTP, IPC, Fastify, Node filesystem or main
  services.
- The canonical team-lifecycle API facet is transport-neutral and uses canonical IDs. Legacy
  team-name DTOs and Electron/HTTP concerns remain outer compatibility adapters.
- Hosted mutation, launch, provider/process work, terminal behavior and production registration are
  outside this wave.
- Runtime services provide only execution, materialization, admission, evidence and integration
  primitives. This controller packet owns orchestration decisions.

Every handoff is strict `HOLD`, including successful producer, review and integration handoffs.
