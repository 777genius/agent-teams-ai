# Feature Architecture Standard

**Status**: team standard  
**Reference implementation**: `src/features/recent-projects`

This document defines the default architecture for medium and large features in this repository.

## Goals

- keep business rules isolated from Electron-specific runtime details
- make features easier to scale, test, and review
- keep renderer code closer to browser and Tauri portability
- enforce architecture with tooling, not only with code review comments

## Canonical Template

```text
src/features/<feature-name>/
  index.ts
  contracts/
    index.ts
  core/
    domain/
    application/
  main/
    index.ts
    composition/
    application/
    adapters/
      input/
      output/
    infrastructure/
  preload/
    index.ts
  renderer/
    index.ts
```

Use this template by default when a feature:

- spans more than one process boundary
- introduces its own use case or business policy
- needs its own transport bridge or integration surface
- is expected to grow with new providers, sources, or presentation flows

`index.ts` and `main/application/` are optional. Add them only when they have a
clear public or runtime-orchestration role.

## Layer Responsibilities

### `index.ts`

Optional root public barrel for the feature.

Use it for:

- stable type re-exports from `contracts/`
- small pure facades that are intentionally shared across layers
- feature factories when the root barrel is intentionally main-owned and
  imported only from main-process code

Not allowed:

- accidental wildcard exports from implementation folders
- mixing browser-safe exports with main-only exports without making process
  ownership obvious
- replacing the layer entrypoints when callers need a process-specific surface

### `contracts/`

Cross-process public API for the feature.

Allowed content:

- DTOs
- API fragment types
- IPC or route constants

Not allowed:

- store access
- Electron APIs
- business orchestration

### `core/domain/`

Pure business rules and invariants.

Examples:

- merge policies
- provider-agnostic models
- selection rules
- dedupe logic

Not allowed:

- infrastructure access
- framework access
- side effects

### `core/application/`

Use cases and ports.

Examples:

- orchestration flow
- output ports
- cache ports
- source ports
- response models

Not allowed:

- Electron, Fastify, React, Zustand, child processes

### `main/composition/`

Feature composition root in the main process.

Responsibilities:

- instantiate infrastructure
- wire adapters
- wire use cases
- expose a small facade to app shell entrypoints

### `main/adapters/input/`

Driving adapters for the main process.

Examples:

- IPC handlers
- HTTP route registration

Responsibilities:

- translate transport input into use case calls
- keep transport concerns out of use cases

### `main/application/`

Optional main-process application services.

Use this only when code is too runtime-aware for `core/application`, but is not a
transport adapter or low-level infrastructure helper.

Examples:

- main-only readers that orchestrate runtime services
- process-aware tracking or coordination helpers

Not allowed:

- IPC or HTTP handler registration
- renderer or preload dependencies
- pure domain policy that belongs in `core/domain`

### `main/adapters/output/`

Driven adapters that implement application ports.

Examples:

- presenters
- source adapters

Responsibilities:

- translate between external data and core models
- stay thin around infrastructure helpers

### `main/infrastructure/`

Concrete technical implementation details.

Examples:

- file system adapters
- JSON-RPC transport clients
- binary discovery
- cache implementation
- git identity helpers

Responsibilities:

- know about runtime, process, OS, or protocol details

### `preload/`

Thin transport bridge between renderer and main.

Responsibilities:

- expose a feature API fragment
- depend on `contracts/`

Not allowed:

- main composition code
- renderer logic

### `renderer/`

Feature presentation and interaction.

Recommended structure:

```text
renderer/
  index.ts
  adapters/
  hooks/
  ui/
  utils/
```

Responsibilities:

- `ui/` renders
- `hooks/` orchestrate interaction and transport usage
- `adapters/` transform DTOs into view models
- `utils/` contain small pure renderer helpers

### UI primitives

Build interactive UI controls from reusable shared components backed by Radix UI
headless primitives. Prefer existing components under `src/renderer/components/ui`
for controls such as selects, dialogs, popovers, tabs, menus, tooltips, switches,
and checkboxes. Avoid hand-rolled or native controls when a shared Radix-based
primitive exists; add or extend the shared primitive instead of styling a one-off
control inside a feature.

For user-facing hover or focus help, use the shared Radix Tooltip primitives from
`src/renderer/components/ui/tooltip.tsx`. Do not use the native HTML `title`
attribute as a tooltip: it cannot follow the app theme or reliably avoid dialog,
popover, and viewport boundaries. Keep accessible names and descriptions in
`aria-label`, `aria-description`, or an explicit `aria-describedby` relationship.

## Import Rules

### Public entrypoints only

Outside the feature, import only:

- `@features/<feature>` when the feature owns a deliberate root public barrel
- `@features/<feature>/contracts`
- `@features/<feature>/main`
- `@features/<feature>/preload`
- `@features/<feature>/renderer`

Do not deep-import feature internals from app shell or from other features.
Layer entrypoints should be explicit `index.ts` files that export only supported
surface area. Focused tests may import internals when they are testing that unit
directly, but production integration code should not.

### Core isolation

`core/domain` must not import:

- `@main/*`
- `@renderer/*`
- `@preload/*`
- adapters
- infrastructure
- Electron APIs
- Fastify
- child process modules

`core/application` must not import:

- `@features/<feature>/main/**`
- `@features/<feature>/renderer/**`
- `@main/*`
- `@renderer/*`
- `@preload/*`
- Electron APIs
- Fastify
- child process modules

### UI isolation

`renderer/ui` must not import:

- `@renderer/api`
- `@renderer/store`
- `@main/*`
- Electron APIs

Push transport and store access into feature hooks or adapters.

## Architecture Ratchet

Run `pnpm guard:feature-architecture` for the repository-wide dependency gate.
It scans production source and enforces:

- cross-feature dependencies use only the feature root or the explicit
  `contracts`, `main`, `preload`, or `renderer` entrypoint
- `core/domain` stays independent from application, Node, Electron, frameworks,
  transport, adapters, and infrastructure
- `core/application` depends only on domain, contracts, and its own application
  models, use cases, and ports
- public feature entrypoints do not directly or transitively re-export adapters
  or infrastructure

Legacy violations are pinned as individual dependency edges in
`scripts/ci/feature-architecture-baseline.json`. The identity is the rule,
source path, module specifier, and public entrypoint when applicable; line
numbers are deliberately excluded so unrelated edits do not create noise.

The baseline is a ratchet, not a general allowlist:

- an existing edge may remain unchanged while its migration is pending
- a new violating edge fails even when it is added to a legacy file
- removed violations require their exact baseline entries to be removed
- CI compares the manifest with the PR base and rejects new exceptions
- new files and new features therefore start with no architecture exceptions

Use `pnpm guard:feature-architecture -- --report` only when the full legacy
inventory is needed. The default successful output stays concise.

## Browser and Tauri Friendly Guidance

The default transport direction should be:

`renderer -> feature contracts -> app api abstraction -> preload/http adapter`

This keeps renderer code closer to:

- browser mode through HTTP adapters
- a future Tauri bridge
- alternative shells with minimal feature rewrites

To keep that path clean:

- never call `window.electronAPI` directly inside feature UI or hooks
- go through shared renderer API adapters
- keep Electron-specific concerns in `main/` and `preload/`
- keep business rules in `core/`

### HTTP/server mode as a first-class target

For any medium or large feature that is not inherently desktop-only, design the
feature so the same user-visible workflow can function through the HTTP/server
adapter path.

This is critical because the HTTP path is the most portable integration surface:

- browser mode can use it directly
- Electron can keep using IPC without changing feature semantics
- future shells can add their own transport without rewriting the feature
- tests can exercise the same use cases without Electron-specific wiring

The rule is:

- the feature contract belongs in `contracts/`
- the use case belongs in `core/application` or a main-owned application service
- IPC handlers and HTTP routes are only transport adapters
- both adapters call the same feature facade or use case
- renderer code goes through the app API abstraction and must not know whether
  the active transport is IPC or HTTP

Do not implement business behavior only inside an IPC handler. If desktop needs
native capabilities, put those capabilities behind ports or main-process
services, then expose the workflow through the same feature facade. Only skip
HTTP/server support when the feature is explicitly desktop-only, for example a
native window management operation with no meaningful browser equivalent.

When adding or changing feature APIs, keep transport parity explicit:

- add or update IPC coverage for the Electron desktop path
- add or update HTTP route/client coverage for browser/server mode
- document any unsupported browser-mode behavior as a deliberate exception
- add tests or typed contract checks when drift between transports would be
  risky

## When To Use The Full Slice

Use the full template when a feature has:

- its own business rules
- its own merge or filtering policy
- transport wiring
- more than one adapter
- a roadmap beyond a one-off screen tweak

## When A Thin Slice Is Enough

A smaller feature may skip `core/` and `preload/` when it is:

- purely presentational
- only reshaping already-owned data
- not adding a new use case
- not adding a new transport boundary

If the feature still owns meaningful pure semantics or projection rules, keep
`core/` and skip only the process layers you do not need.

Example:

- `src/features/agent-graph` keeps `core/domain` and `renderer`, but does not add fake `main/` or `preload/` folders because the transport boundary lives elsewhere.

## Current Feature Shape Examples

Use these local examples before inventing a new variant:

- `src/features/recent-projects` - full cross-process reference with
  `contracts`, `core`, `main`, `preload`, and `renderer`.
- `src/features/member-work-sync` - full cross-process feature with a root
  public barrel and broader main-process infrastructure.
- `src/features/member-log-stream` - full cross-process feature that uses
  `main/application/` for main-only runtime orchestration.
- `src/features/agent-graph` - thin renderer integration with `core/domain` and
  `renderer`, no fake process layers.
- `src/features/codex-model-catalog` and `src/features/team-runtime-lanes` -
  process-limited features that omit renderer or preload layers when they do not
  own that boundary.

## Definition Of Done For A Reference Feature

A feature is reference-quality when:

- structure matches the full or thin template chosen for the feature
- core is side-effect free
- app shell imports only public entrypoints
- renderer UI is dumb and presentational
- browser/server mode is first-class for non-desktop-only workflows
- at least the main domain and application rules are tested when those layers
  exist
- architecture is enforced by lint rules
- every new production source file is at most 800 physical lines
- feature has a concise standard or plan doc if it introduces a new pattern

The `pnpm guard:source-file-size` gate covers production code in the app and
workspace packages. Existing files above 800 lines are pinned to their exact
current line count in `scripts/ci/source-file-size-legacy.json`: they may only
shrink, and the exception must be removed once a file reaches 800 lines.
Never add a new legacy exception or raise an existing cap. Split new
responsibilities by domain/application/adapter/UI ownership instead.

## Recommended Test Coverage

For medium and large features, cover at least:

- domain policy tests
- application use case tests
- critical renderer interaction utilities
- one adapter-level mapping test

## Recent Projects As The Reference

`src/features/recent-projects` is the first slice that follows this standard end-to-end.

Use it as the example for:

- contracts ownership
- core/application separation
- composition-root wiring
- renderer dumb UI + hook orchestration
- browser-friendly transport direction
- feature-level lint guard rails

## Agent Graph As The Thin-Slice Reference

`src/features/agent-graph` is the thin-slice example for a renderer integration
feature built on top of a reusable package.

Use it as the example for:

- keeping pure graph semantics in `core/domain`
- exposing a renderer-only public entrypoint
- integrating `packages/agent-graph` without inventing fake process layers
- migrating legacy `src/renderer/features/*` code into the canonical feature root
