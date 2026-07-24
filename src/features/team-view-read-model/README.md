# Team View Read Model

Main-process feature slice for the desktop team read model.

It owns three stable IPC contracts:

- `team:getData`
- `team:getMessagesPage`
- `team:getMemberActivityMeta`

Public entrypoints:

- `contracts/index.ts` - browser-safe channel constants
- `main/index.ts` - feature composition and IPC registration
- `renderer/index.ts` - message-feed and team-view-data state, orchestration, and ports

The renderer composition keeps `selectTeam`, `refreshTeamData`, team-directory refreshes, and
global-task refreshes independent from Zustand and IPC. Narrow ports provide snapshot projection,
request-scope checks, navigation effects, notifications, branch normalization, and task
invalidation. Transport adapters own `team:getData`, `team:list`, `team:getAllTasks`, branch reads,
and review-cache IPC. `TeamViewDataCoordinator` owns thin/full request dedupe and post-paint
scheduling; `TeamDirectoryRefreshCoordinator` owns list request ordering and coalesced global-task
refresh state.

The use cases under `core/application` own worker preference, safe main-thread
fallback, live-message projection for notification scanning, missing-team
classification, and runtime enrichment. Electron, filesystem, worker-client, and
notification implementations stay in `main/` adapters and composition.

The existing HTTP team-data route is intentionally not routed through this
feature yet. It has compatibility-specific behavior for draft responses, runtime
state lookup, and notification side effects. Unifying the transports requires a
separate behavior migration with explicit IPC/HTTP conformance tests; this slice
preserves both current contracts.

Focused coverage lives under `test/features/team-view-read-model`, with preload
arity coverage in `test/preload/electronApiTeamViewReadModel.test.ts` and legacy
behavior characterization in `test/main/ipc/teams.test.ts`.
