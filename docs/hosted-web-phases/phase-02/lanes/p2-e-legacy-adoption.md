# P2.E: legacy adoption

- Packet revision: `phase-02-jit-router-r1`.
- Role: product lane E; one of exactly five parallel product slots.
- Depends on: accepted and activated `P2.IF.INTEGRATION` foundation authority.
- Evidence IDs: `P2.E.READ_USE_CASES`, `P2.E.TRANSPORT_NEUTRAL_API`,
  `P2.E.LEGACY_READ_ADAPTER`.
- Result states: `verified | blocked | failed`; terminal state always `HOLD`.

## Mission

Extend the Phase 1 read slice with canonical snapshot/runtime/alive queries and one transport-neutral
team-lifecycle API facet. Implement a narrow legacy read source and input adapter without editing IPC,
HTTP, renderer clients, shared barrels or composition; serial integration later binds both transports
to the same use cases.

## Required reads

After the common mandatory order, read completely and in order:

1. master plan `Detailed TeamsAPI parity inventory`, lifecycle-read rows only;
2. master plan `Phase 2: identity substrate and externally read-only team lifecycle`, first use cases
   and tasks 5-10;
3. accepted foundation `src/shared/contracts/hosted/identifiers.ts`;
4. `src/features/team-lifecycle/contracts/team-lifecycle-read.ts`;
5. `src/features/team-lifecycle/core/application/ListTeamLifecycle.ts`;
6. `src/shared/types/api.ts`, `TeamsAPI` only;
7. `src/main/ipc/teams.ts`, list/detail/runtime/alive handlers only;
8. `src/main/http/teams.ts`, list/detail/runtime/alive routes only;
9. `src/renderer/api/httpClient.ts`, team read methods only;
10. `src/main/services/team/TeamDataService.ts`, list/detail/runtime read entrypoints only; and
11. `test/architecture/hosted-web/phase-1/conformance/semantic-harness.ts`.

## Exact writable paths

1. `src/features/team-lifecycle/contracts/team-lifecycle-read.ts`
2. `src/features/team-lifecycle/contracts/team-lifecycle-read-api.ts`
3. `src/features/team-lifecycle/core/application/GetTeamLifecycleSnapshot.ts`
4. `src/features/team-lifecycle/core/application/GetRuntimeStateProjection.ts`
5. `src/features/team-lifecycle/core/application/ListAliveTeamProjections.ts`
6. `src/features/team-lifecycle/main/infrastructure/LegacyTeamLifecycleReadSource.ts`
7. `src/features/team-lifecycle/main/adapters/input/TeamLifecycleReadApiAdapter.ts`
8. `test/features/team-lifecycle/TeamLifecycleReadApi.test.ts`
9. `test/architecture/hosted-web/phase-2/team-lifecycle-read-api-boundaries.test.ts`
10. `.codex-handoff/phase-02-p2-e.json`

All barrels, indexes, composition, existing IPC/HTTP handlers, renderer clients, shared mega-API types
and sibling paths are read-only.

## Acceptance

- Requests and responses use canonical TeamId/WorkspaceId, bounded value-only DTOs, explicit schema
  behavior, safe errors, revision/cursor semantics and deterministic ordering. Canonical browser DTOs
  contain no raw team name or project path.
- List, lifecycle snapshot, runtime projection and alive projection use cases depend on narrow read
  ports. Core imports no main, Electron, Fastify, IPC, HTTP, React, filesystem, process or provider
  module.
- `team-lifecycle-read-api.ts` is a transport-neutral facet: no Electron event/callback, channel,
  Request/Reply, status code, header, URL or serialization framework. It is not an all-parity TeamsAPI.
- The input adapter validates then calls the same use cases for any transport. Legacy team-name and
  current-service mapping stay inside the output compatibility adapter and do not escape canonical
  results.
- Read semantics preserve Phase 1 outcomes for current, draft, provisioning, corrupt, partial, stale,
  unavailable and unexpected fixtures. No route-level config existence check, cache invalidation,
  runtime overlay policy or mutation is introduced.
- Actual IPC and test-HTTP wiring, public exports and cross-transport conformance remain unverified and
  reserved to `P2.I.INTEGRATION`. Hosted mutation capabilities remain absent.
- The producer self-reviews the complete diff for semantic parity, dependency direction, API
  segregation, ID/path privacy, exact scope and scans.

## Focused checks

```text
pnpm exec vitest run test/features/team-lifecycle/core/ListTeamLifecycle.test.ts test/features/team-lifecycle/TeamLifecycleReadApi.test.ts test/architecture/hosted-web/phase-2/team-lifecycle-read-api-boundaries.test.ts
pnpm lint:fast:files -- src/features/team-lifecycle/contracts/team-lifecycle-read.ts src/features/team-lifecycle/contracts/team-lifecycle-read-api.ts src/features/team-lifecycle/core/application/GetTeamLifecycleSnapshot.ts src/features/team-lifecycle/core/application/GetRuntimeStateProjection.ts src/features/team-lifecycle/core/application/ListAliveTeamProjections.ts src/features/team-lifecycle/main/infrastructure/LegacyTeamLifecycleReadSource.ts src/features/team-lifecycle/main/adapters/input/TeamLifecycleReadApiAdapter.ts test/features/team-lifecycle/TeamLifecycleReadApi.test.ts test/architecture/hosted-web/phase-2/team-lifecycle-read-api-boundaries.test.ts
pnpm typecheck
pnpm exec prettier --check src/features/team-lifecycle/contracts/team-lifecycle-read.ts src/features/team-lifecycle/contracts/team-lifecycle-read-api.ts src/features/team-lifecycle/core/application/GetTeamLifecycleSnapshot.ts src/features/team-lifecycle/core/application/GetRuntimeStateProjection.ts src/features/team-lifecycle/core/application/ListAliveTeamProjections.ts src/features/team-lifecycle/main/infrastructure/LegacyTeamLifecycleReadSource.ts src/features/team-lifecycle/main/adapters/input/TeamLifecycleReadApiAdapter.ts test/features/team-lifecycle/TeamLifecycleReadApi.test.ts test/architecture/hosted-web/phase-2/team-lifecycle-read-api-boundaries.test.ts .codex-handoff/phase-02-p2-e.json
git diff --check
```

Prove exact ownership and classified secret/private-path scans across all ten writable paths.

## Stop and handoff

Stop on stale foundation authority, an index/composition requirement, sibling coupling, raw path/name
leakage, transport types in core, mutation capability, semantics drift or pressure to edit legacy
handlers. Do not commit, push, integrate or launch successors.

The packet-standard handoff records semantic fixtures, boundary negatives, exact evidence and producer
self-review. On success request only combined `P2.R1.ARCH_SECURITY` after all five producers finish.
End with `terminalState: HOLD`.
