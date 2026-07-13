# Phase 1 execution entrypoint

Status: **current for `P1.S1` foundations only**. `P1.S2` and every later subphase remain blocked.

Phase 0 is accepted and frozen at `f4fa24aac9615a4ce10632965a2244a2e11a273e`. That candidate
includes the accepted fail-closed target-image narrowing, final gate, orchestration authority, bounded
navigation contract, and estimate reconciliation. Exact-image construction and admission remain fail
closed and belong to Phase 5; provider canaries, production composition, and terminal-negative
admission remain explicit implementation risks. They do not reopen Phase 0.

`P1.S0` is accepted at `6f1a87daa9a4bfdf5d754347d92f313f28d0f95d`, an ancestor of the
transition base `f12a85af0fddadd06f69a27ef408d26bc27eb3fc`. Its exact six bootstrap evidence
paths are unchanged. The evidence continues to record the historical S0 worker `phaseStartSha`
`5f30df49e052d1cc1d0e7efd03aa105673b5b614`; the transition does not rewrite it.

> The router authorizes exactly one producer target: `P1.S1`, implemented by frozen owner `P1.1A`.
> The exact paths, identifiers, checks, and estimate are those accepted in the S0 bootstrap. `P1.S2`
> and all route/catalog, conformance/ratchet, feature-slice, review, integration, and production
> transport work remain blocked.

## Validated worker route

The current route contains exactly these packets, in this order:

1. `docs/hosted-web-phases/phase-01/controller-packet.md`
2. `docs/hosted-web-phases/phase-01/lanes/p1-s1-foundations.md`

After both packets, read only the exact files in the subscription-runtime `worker-start-v1`
contract. The documents below remain reference-on-demand; their presence in this directory is not an
unconditional reading queue:

- `docs/hosted-web-phases/phase-01/packet-inputs.md`
- `docs/hosted-web-phases/phase-01/architecture-and-contracts.md`
- `docs/hosted-web-phases/phase-01/execution-dag.md`
- `docs/hosted-web-phases/phase-01/conformance-and-tests.md`
- `docs/hosted-web-phases/phase-01/operations-and-risk.md`
- `docs/hosted-web-phases/phase-01/execution-packet-templates.md`

## Planning result

The proposed first proof is a paginated, read-only `ListTeamLifecycleSummaries` use case. It is chosen
because the legacy `TeamsAPI.list`, IPC `team:list`, HTTP `GET /api/teams`, and browser stub expose the
same visible seam while currently disagreeing on errors and browser support. Phase 1 would prove the
new application seam with in-memory fixtures plus IPC-shaped and HTTP-shaped adapters that live only
inside an isolated conformance test composition. Neither adapter can be imported or registered by a
production composition. Phase 1 would **not** cut the renderer over, add a preload channel, expose an
unauthenticated hosted route, generate
canonical `TeamId` values from names, or replace the legacy list route. Stable identity and production
read rollout remain Phase 2 work. Standalone production composition and exact-image admission remain
Phase 5 work.

The practical boundary is therefore contracts plus conformance, not a disguised lifecycle rewrite:

- a tiny cross-feature contract kernel;
- feature-owned team-lifecycle DTOs, parsers, query, and consumer-owned read port;
- separate route and capability descriptors;
- isolated test/IPC/HTTP conformance adapters that normalize the same application outcomes;
- architecture ratchets that stop a second god API from forming.

Only the exact `P1.1A` shared contract-kernel files and focused tests named by the current lane packet
are authorized by this transition. No production route, registration, adapter, renderer, feature
slice, filesystem access, dependency, or configuration change is authorized.

`P1.S1` must return its two frozen evidence IDs and exact check results to the controller. Passing the
lane does not authorize `P1.S2`; a separate reviewed integration and explicit router advance is
required.
