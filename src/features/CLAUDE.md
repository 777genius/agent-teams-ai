# Feature-Local Guidance

This file is a navigation layer for feature slices under `src/features/`.

Before changing a feature slice, read:

- [Project instructions](../../CLAUDE.md)
- [Feature Architecture Standard](../../docs/FEATURE_ARCHITECTURE_STANDARD.md)
- [Feature root guide](./README.md)

Use local references:

- `src/features/recent-projects` - full cross-process reference
- `src/features/member-work-sync` - full feature with a root public barrel
- `src/features/member-log-stream` - full feature with `main/application/`
- `src/features/agent-graph` - thin `core/domain` plus `renderer` reference

Default location for new feature work:

- `src/features/<feature-name>/`

Before adding a medium or large feature:

- decide whether the feature is full, thin, or process-limited
- start with the layer set the feature actually owns; do not add placeholder
  folders just to match the full template
- create explicit public entrypoints for every layer production callers need
- put shared DTOs, channel names, and API fragments in `contracts/`
- keep business policy in `core/domain` and use-case orchestration in
  `core/application`
- keep Electron, IPC, HTTP, file system, process, and provider specifics outside
  `core/`
- wire runtime dependencies from `main/composition/` when the feature owns main
  process behavior
- expose preload bridges through `preload/index.ts` and renderer surfaces
  through `renderer/index.ts`
- add focused tests for the layers that carry behavior

When modifying an existing feature:

- preserve the feature's current shape unless the change introduces a real new
  boundary
- route app shell and cross-feature imports through public entrypoints
- move duplicated rules toward `core/domain` before adding another adapter copy
- keep transport validation and normalization close to the boundary that receives
  the data
- update the feature README or local notes when the public surface or intended
  shape changes
- keep local README examples concrete and file-based; link back to the standard
  for architecture rules instead of restating them

Public entrypoint expectations:

- `contracts/index.ts` exports only browser-safe contracts, constants, and
  normalizers intended for cross-process use
- `main/index.ts` exports composition and registration surfaces for main-process
  callers
- `preload/index.ts` exports bridge creation only
- `renderer/index.ts` exports reusable renderer components, hooks, or utilities
  that are intentionally consumed outside the feature
- root `index.ts` is optional; use it only when the feature deliberately owns a
  stable public barrel

Testing expectations:

- test pure domain rules directly and keep those tests independent of runtime
  services
- test application use cases with ports or fakes, not Electron or real provider
  processes
- test adapter mapping, boundary normalization, and renderer utilities where they
  can regress user-visible behavior
- prefer `test/features/<feature>/...` for cross-layer coverage; feature-local
  `__tests__` are fine when the surrounding feature already uses that pattern
- for docs-only changes, verify links and examples instead of running broad test
  suites

Do not duplicate architecture rules here. Keep architecture rules centralized in
[../../docs/FEATURE_ARCHITECTURE_STANDARD.md](../../docs/FEATURE_ARCHITECTURE_STANDARD.md).
