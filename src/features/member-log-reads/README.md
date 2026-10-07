# Member log reads

The initial main-process cache integration uses `DetailCacheFillFence` through
`main/index.ts`. It separates permission to cache a result from source validity,
retains latest-writer ownership until every outstanding fill settles, and fences
invalidation and disposal. It stores neither completed payloads nor key tombstones.

`DetailReadCoordinator` owns one physical IPC read and one pending successor per
source address. Equivalent subscribers share work; fresh callers wait for the
successor. Retiring one IPC adapter leaves other subscribers intact. Context
retirement settles old subscriptions while retaining the physical slot until its
read finishes. Completed DTOs are retained only by DataCache and callers.

The main entrypoint exposes the coordinator, adapter lifetime and session/subagent
read use cases. `ServiceContext` owns separate session and subagent coordinators;
the registry retires their activation before switching or replacing contexts.
Registered IPC integration tests use the real scanner, parser, builder and cache
with a synthetic filesystem boundary.

`renderer/index.ts` exposes mounted subscriptions, context/root scope identity,
completion-based polling and refreshing leases. The renderer shares pending
reads without retaining completed DTO history. Each view projects raw detail
chunks separately. Ordinary reads can share active work; explicit fresh demand
uses the coordinator's successor contract. Automatic polls wait 5000ms after
settlement. Background feedback retains its existing 250ms minimum lifetime.

The optional presentation key allows an already completed summary to remain
visible during a status-only policy update for the same task owner. It never
permits a retired request to publish. New context/root/task/interval ownership,
selection, hide, disable and unmount retire the relevant subscription.

Tests exercise real registered IPC builders, pure coordination/cache ports,
and mounted renderer components with synthetic API boundaries. They do not
launch providers or inspect real user projects.
