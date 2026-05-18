# Recent Projects Feature

`recent-projects` is the full cross-process reference for
[`docs/FEATURE_ARCHITECTURE_STANDARD.md`](../../../docs/FEATURE_ARCHITECTURE_STANDARD.md).
Use it as the local example when a feature owns contracts, pure business rules,
runtime composition, transport adapters, preload bridging, and renderer UI.

Read this with:

- [Feature root guide](../README.md)
- [Feature-local agent guidance](../CLAUDE.md)

## Feature Shape

```text
src/features/recent-projects/
  contracts/
  core/
    domain/
    application/
  main/
    composition/
    adapters/
      input/
      output/
    infrastructure/
  preload/
  renderer/
```

This feature intentionally does not have a root `index.ts`. Production callers
enter through the layer-specific public entrypoints:

- `contracts/index.ts` for DTOs, channels, API fragments, and payload
  normalization
- `main/index.ts` for main-process registration and composition
- `preload/index.ts` for bridge creation
- `renderer/index.ts` for renderer-owned UI and public renderer utilities

## Layer Examples

- `core/domain/policies/mergeRecentProjectCandidates.ts` owns provider-agnostic
  merge policy and stays pure
- `core/application/use-cases/ListDashboardRecentProjectsUseCase.ts`
  orchestrates ports and response models without importing runtime details
- `main/composition/createRecentProjectsFeature.ts` wires infrastructure,
  adapters, ports, and use cases for the main process
- `main/adapters/input/ipc/registerRecentProjectsIpc.ts` and
  `main/adapters/input/http/registerRecentProjectsHttp.ts` translate transport
  requests into feature calls
- `main/adapters/output/sources/*` adapts provider/runtime data into the core
  model
- `main/infrastructure/cache/InMemoryRecentProjectsCache.ts` and
  `main/infrastructure/identity/*` keep runtime-specific helpers out of `core/`
- `preload/createRecentProjectsBridge.ts` exposes the feature API fragment to
  the renderer
- `renderer/hooks/useRecentProjectsSection.ts` coordinates renderer interaction
  and data access
- `renderer/ui/RecentProjectsSection.tsx` keeps the visual component focused on
  rendering and callbacks

## How To Extend It

When adding another source or provider:

- add or reuse a port in `core/application/ports/`
- keep provider-specific parsing in `main/adapters/output/` or
  `main/infrastructure/`
- keep merge, ordering, dedupe, and selection rules in `core/domain/`
- wire the new dependency in `main/composition/createRecentProjectsFeature.ts`
- add focused tests beside the layer that owns the behavior

When adding another transport:

- put shared request/response shape in `contracts/`
- implement the input adapter under `main/adapters/input/`
- keep handler registration out of `core/`
- expose only the stable surface from `main/index.ts`

When changing renderer behavior:

- keep data fetching and app API calls in hooks or renderer adapters
- keep UI components presentational
- transform DTOs into view models before they reach reusable UI where practical
- update renderer utility tests when sorting, navigation, active-team state, or
  client cache behavior changes

When updating this reference:

- keep examples tied to real files in this feature
- update this README when public entrypoints or intended extension paths change
- leave cross-feature architecture wording in the shared standard

## Test Map

Reference tests live under `test/features/recent-projects/`:

- `contracts/` covers payload normalization
- `core/domain/` covers merge policy
- `core/application/` covers use-case orchestration through ports
- `main/adapters/output/` and `main/infrastructure/` cover provider and runtime
  integration boundaries with fakes
- `renderer/adapters/` and `renderer/utils/` cover view-model mapping and
  interaction helpers

For new medium or large features, this test shape is a good starting point:
domain rules first, application use cases second, then focused adapter and
renderer utility coverage for behavior that can break user workflows.
