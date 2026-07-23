# Team Task Board

This feature owns task-board contracts, application orchestration, main-process
transport adapters, and renderer task interactions.

Follow the repository-wide rules in
[`docs/FEATURE_ARCHITECTURE_STANDARD.md`](../../../docs/FEATURE_ARCHITECTURE_STANDARD.md).

## Layer map

- `contracts/` owns cross-process channels and browser-safe contracts.
- `core/application/` owns task mutation ordering and narrow dependency ports.
- `main/` wires IPC handlers and main-process infrastructure.
- `renderer/adapters/` maps renderer API and store capabilities to application ports.
- `renderer/index.ts` is the only renderer entrypoint for production callers.

## Renderer interaction rules

- Keep command ordering in `createTeamTaskBoardActions`.
- Keep product analytics state in `TaskLifecycleAnalyticsTracker`.
- Keep `api`, Zustand, and renderer error mapping out of `core/application`.
- Treat task-change presence refresh as best-effort after the canonical team refresh.
- Preserve the current sequential refresh order for clarification and deleted-task flows.
- Import renderer behavior through `@features/team-task-board/renderer`.

When adding another task-board action, extend the narrow application port first,
add an orchestration test, then wire the renderer transport adapter. Do not add
new task-board orchestration directly to `teamSlice`.
