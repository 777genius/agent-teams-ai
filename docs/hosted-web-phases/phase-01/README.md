# Phase 1 execution entrypoint

Status: **current for `P1.S0` serial bootstrap only**. Product implementation and every successor
subphase remain blocked.

Phase 0 is accepted and frozen at `f4fa24aac9615a4ce10632965a2244a2e11a273e`. That candidate
includes the accepted fail-closed target-image narrowing, final gate, orchestration authority, bounded
navigation contract, and estimate reconciliation. Exact-image construction and admission remain fail
closed and belong to Phase 5; provider canaries, production composition, and terminal-negative
admission remain explicit implementation risks. They do not reopen Phase 0.

> The router authorizes exactly one producer target: `P1.S0`. Until that serial bootstrap is
> integrated, every later `P1.*` ID, contract name, route/channel/action ID, path, owner, estimate,
> threshold, review pair, and command remains **proposed**. S0 may narrow or rename them. It may not
> silently broaden Phase 1 or implement product source.

## Validated worker route

The current route contains exactly these packets, in this order:

1. `docs/hosted-web-phases/phase-01/controller-packet.md`
2. `docs/hosted-web-phases/phase-01/lanes/p1-s0-serial-bootstrap.md`

After both packets, read only the exact files in the subscription-runtime `worker-start-v1`
contract. The proposal
documents below remain reference-on-demand; their presence in this directory is not an unconditional
reading queue:

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

No production implementation is authorized by this transition.

`P1.S0` must freeze exact IDs, paths, owners, fixtures, commands, baselines, and the Phase 1 start SHA.
`P1.S1` and every later subphase remain blocked until S0 is integrated and the compact execution
router is explicitly advanced.
