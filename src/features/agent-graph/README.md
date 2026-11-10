# Agent Graph Feature

This feature is a thin renderer slice over the reusable graph engine in `packages/agent-graph`.

Read first:
- [Feature Architecture Standard](../../docs/FEATURE_ARCHITECTURE_STANDARD.md)
- [Feature root guidance](../CLAUDE.md)
- [Stable Slot Layout Plan](./STABLE_SLOT_LAYOUT_PLAN.md)

Public entrypoint:
- `@features/agent-graph/renderer`

Responsibilities:
- `packages/agent-graph` owns reusable graph rendering and low-level graph mechanics
- `src/features/agent-graph/core/domain` owns project-specific graph semantics and pure projection helpers
- `src/features/agent-graph/renderer` owns the renderer integration layer, hooks, adapters, and UI

Use this feature as the thin-slice example when a feature:
- has no dedicated `main` or `preload` transport boundary
- integrates an existing reusable package into the app shell
- still needs its own feature boundary and public entrypoint
