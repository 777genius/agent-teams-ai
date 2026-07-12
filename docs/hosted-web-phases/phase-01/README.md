# Phase 1 blocked plan bundle

Status: **blocked planning proposal**. Phase 1 implementation is not authorized.

This bundle expands the Phase 1 intent at exact planning base
`3bc0dfa7c00261785c0c752270cb302a9294e751`. That base closes the Phase 0 target-image gate by
accepted capability narrowing: exact-image construction and admission remain fail closed and belong to
Phase 5, so they are not a Phase 1 prerequisite. Every other open Phase 0 gate remains intact. The
bundle is autonomous enough to turn into executable packets after those remaining gates pass, but it
is not itself an executable packet.

> Until serial bootstrap is integrated, every `P1.*` ID, contract name, route/channel/action ID, path,
> owner, estimate, threshold, review pair, and command in this directory is **proposed**. Serial
> bootstrap may narrow or rename them. It may not silently broaden Phase 1. Producer target: **zero**.

## Reading order

1. [Inputs and prerequisite gates](./packet-inputs.md)
2. [Controller plan](./controller-packet.md)
3. [Boundary, ownership, and candidate contracts](./architecture-and-contracts.md)
4. [Subphases, DAG, paths, and integration](./execution-dag.md)
5. [Semantic conformance and negative gates](./conformance-and-tests.md)
6. [Migration, operations, and risk](./operations-and-risk.md)
7. [Execution packet templates](./execution-packet-templates.md)

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

No production implementation is created by this planning bundle.

Phase 1 implementation remains blocked until every Phase 0 prerequisite gate passes, the reviewed
plan is integrated, and `P1.S0` serial bootstrap has frozen exact IDs, paths, owners, fixtures,
commands, baselines, and the start SHA. This bundle does not satisfy those conditions.
