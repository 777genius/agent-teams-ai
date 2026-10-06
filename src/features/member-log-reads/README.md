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

Renderer subscriptions, completion polling, recovery scheduling and full desktop
acceptance remain separate work in the accepted PR6a/6b plan.
