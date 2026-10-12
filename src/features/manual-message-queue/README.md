# Manual message queue

Renderer-owned manual queues for ordinary direct, team, and group chats. Callers
enter through `renderer/index.ts`; there is no agent queue API, main registration,
preload bridge, or automatic send loop.

- `core/domain/queue.ts` defines saved scope, route, revisions, frozen attempts,
  insertion order, and strict persisted schema validation.
- `renderer/adapters/queueRepository.ts` owns the IndexedDB transaction boundary.
  Enqueue consumes exactly one durable working draft revision and updates its
  summary in the same existing keyval store transaction. Unsupported data and
  failed transactions remain untouched.
- `renderer/adapters/queueBinding.ts` resolves the effective local team root and
  checks the active context and authoritative SSH host.
- `renderer/adapters/queueDispatch.ts` claims one selected item before invoking
  the existing transport, shares the context submission latch with ordinary
  sends, and durably settles its frozen attempt after UI unmount.
- `renderer/hooks/` adapts direct and canonical group composers. The group
  recipient saved in the item remains independent of the current selector.
- `renderer/ui/QueueList.tsx` renders compact rows and an independent inline
  editor. Unknown delivery exposes Copy, exact-id history check, and removal
  with an explicit duplicate-delivery warning.

The draft repository's `acceptExternalWorkingCommit` publishes an already
committed queue transaction to existing working-draft subscribers. It never
writes or notifies before IndexedDB commits; existing local edit guards preserve
text typed while the queue transaction was running.

Tests live under `test/features/manual-message-queue/`: keyboard/editor behavior,
real IndexedDB atomicity and recovery, and direct/group transport contracts.
The accepted plan and visual reference are in
[`docs/chat-manual-queue/`](../../../docs/chat-manual-queue/README.md).
