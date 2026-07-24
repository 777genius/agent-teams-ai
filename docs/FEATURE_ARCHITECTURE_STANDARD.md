# Feature Architecture Standard

**Status**: team standard  
**Reference implementation**: `src/features/recent-projects`

This document defines the default architecture for medium and large features in this repository.

## Goals

- keep business rules isolated from Electron-specific runtime details
- make features easier to scale, test, and review
- keep renderer code closer to browser and Tauri portability
- enforce architecture with tooling, not only with code review comments

## Architecture Model

This standard uses a **feature-first, process-aware Hexagonal Architecture with
DDD domain modeling**. It is not a one-to-one directory translation of the
classic DDD layers.

The structure combines three explicit concerns:

- `core/domain` and `core/application` express business and use-case ownership
- `main`, `preload`, and `renderer` express Electron process boundaries
- ports and adapters express the dependency direction between the application
  core and external transports, providers, storage, and runtime services

These concerns are complementary, but their names must not be used
interchangeably. In particular, a renderer projection that only reshapes data
for UI rendering is a view model, not a Hexagonal Architecture adapter.

Dependency direction is inward:

`adapters -> application -> domain`

Outer process layers may depend on `contracts` and `core`; `core` must not
depend on Electron process layers or concrete adapters.

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

Pure domain models, business rules, and invariants. This is the DDD modeling
layer inside the feature.

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

Use cases and the ports they own. A port describes an application conversation
or required capability; concrete runtime implementations stay outside `core/`.

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
- depend inward on the application surface, never the reverse

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
- implement application-owned ports when the implementation represents an
  external conversation such as a provider source, presenter, or repository

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
- provide low-level technical mechanisms used by adapters and composition
- avoid owning domain policy or transport registration

Use `main/adapters/output` when a component is named by an application
conversation and translates between an application port and an external
system. Use `main/infrastructure` when a component is named by its technical
mechanism and exposes a lower-level runtime primitive. A small technical port
implementation may be wired directly from infrastructure when no translation
layer would add meaning.

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
  hooks/
  ui/
  utils/
  view-models/
  adapters/ # optional, only for actual external boundaries
```

Responsibilities:

- `ui/` renders
- `hooks/` orchestrate interaction and transport usage
- `view-models/` transform DTOs or application data into presentation models
- `adapters/` integrate genuine browser, storage, API, framework, external
  package, or legacy UI boundaries; do not use this name for ordinary
  DTO-to-view-model mapping
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

Push transport and store access into feature hooks or genuine boundary
adapters. Keep presentation-only projection in `renderer/view-models/`.

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

## Legacy Migration And Composition

When migrating a legacy service, keep its stable public facade while moving one
observable vertical slice at a time into the canonical feature layers.

- prefer explicit composition over inheritance
- use inheritance only for genuine substitutable subtypes, never to aggregate
  dependencies or share mutable service state
- do not pass the legacy service as a generic host to new use cases
- define small ports owned by the consuming application use case
- give mutable state one explicit repository, registry, coordinator, or gate
- delegate from the legacy facade until callers can use the new public entrypoint
- remove migrated compatibility wiring in the same slice when safe
- do not create empty feature scaffolding before a real use case needs it

For the production-critical Team Provisioning migration, follow the concrete
target and strangler protocol in
[`team-provisioning-target-architecture.md`](team-management/team-provisioning-target-architecture.md).

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
- feature has a concise standard or plan doc if it introduces a new pattern

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
