# Features Directory — Architecture Guide

All new renderer features live here. Each feature is a self-contained module following **Clean Architecture**, **SOLID**, and **class-based** patterns.

---

## Quick Start

```bash
mkdir -p src/renderer/features/<feature-name>/{ports,adapters,domain,ui,hooks,__tests__}
```

---

## Directory Structure

### Full Feature

```
src/renderer/features/<feature-name>/
  ├── ports/                    # Interfaces (contracts) — NO implementations
  │   ├── <Feature>DataPort.ts  # What data the feature needs (input)
  │   ├── <Feature>EventPort.ts # Callbacks the feature fires (output)
  │   ├── <Feature>ConfigPort.ts# Configuration / theme overrides
  │   └── types.ts              # Domain value types for this feature
  │
  ├── adapters/                 # Bridge between project infrastructure and feature
  │   └── <Feature>Adapter.ts   # Zustand store → DataPort (ONLY place that imports store)
  │
  ├── domain/                   # Business logic — pure TS, no React, no UI
  │   ├── models/               # Domain entities and value objects (classes)
  │   └── services/             # Domain services and use cases (classes)
  │
  ├── ui/                       # React components — presentation only
  │   ├── <Feature>View.tsx     # Main component (orchestrator, entry point)
  │   ├── <Feature>Overlay.tsx  # Full-screen overlay variant (if applicable)
  │   └── <Feature>Tab.tsx      # Tab wrapper variant (if applicable)
  │
  ├── hooks/                    # React hooks — thin bridges to domain classes
  │   └── use<Feature>.ts       # Instantiates domain services, subscribes to store
  │
  ├── __tests__/                # Tests colocated with feature
  │   ├── adapters.test.ts      # Adapter mapping correctness
  │   ├── domain.test.ts        # Domain logic unit tests
  │   └── ports.test.ts         # Port type validation
  │
  └── index.ts                  # Public API barrel — exports ONLY from ui/ and ports/
```

### Minimal Feature (no domain layer)

Small features that don't need business logic:

```
src/renderer/features/<feature-name>/
  ├── <Feature>Adapter.ts       # Zustand → feature data
  ├── <Feature>View.tsx         # Main component
  └── index.ts                  # Public API
```

### When to Extract a Workspace Package

Some features benefit from a separate `packages/<name>/` workspace package:

| Keep in `features/` | Extract to `packages/` |
|---------------------|----------------------|
| Tightly coupled to our UI | Reusable in other projects |
| Uses our Zustand store | Framework-agnostic (only React peer dep) |
| Small (<500 LOC) | Large (>1000 LOC of core logic) |
| No external deps | Has its own dependencies (d3-force, etc.) |

Example: `agent-graph` has BOTH:
- `packages/agent-graph/` — Canvas rendering, d3-force simulation (reusable, no project coupling)
- `features/agent-graph/` — Adapter + overlay + tab (thin integration, imports from store)

---

## Real-World Example: agent-graph

```
features/agent-graph/                    ← Integration layer (3 files)
  ├── useTeamGraphAdapter.ts             ← Adapter: TeamData → GraphDataPort
  ├── TeamGraphOverlay.tsx               ← UI: full-screen overlay
  └── TeamGraphTab.tsx                   ← UI: tab wrapper

packages/agent-graph/                    ← Isolated package (34 files)
  ├── src/ports/                         ← GraphDataPort, GraphEventPort, types
  ├── src/canvas/                        ← Canvas 2D renderers
  ├── src/strategies/                    ← Strategy pattern per node kind
  ├── src/hooks/                         ← Simulation, camera, interaction
  └── src/components/                    ← GraphView, GraphCanvas, Controls
```

The adapter (`useTeamGraphAdapter.ts`) is the **only file** that imports from `@renderer/store`. Everything else depends only on port interfaces.

---

## SOLID Principles

### S — Single Responsibility

Each layer has exactly one reason to change:

| Layer | Changes when... | Does NOT change when... |
|-------|----------------|------------------------|
| `ports/` | Feature contract changes | Store structure changes |
| `adapters/` | Store data model changes | Canvas rendering changes |
| `domain/` | Business rules change | React version updates |
| `ui/` | UX/layout changes | Data mapping changes |

### O — Open-Closed

Extend via new classes, never modify existing ones:

```typescript
// ✅  New node kind = new class, zero changes to existing code
class ReviewNodeRenderer implements NodeRenderer { ... }

// Register it — the registry and canvas loop don't change
NodeRendererRegistry.register(new ReviewNodeRenderer());
```

### L — Liskov Substitution

Any implementation of a port can replace another without breaking the feature:

```typescript
// Both adapters satisfy GraphDataPort — feature works with either
class LiveTeamAdapter implements GraphDataPort { ... }   // Real-time Zustand data
class MockTeamAdapter implements GraphDataPort { ... }   // Static test data
class ReplayTeamAdapter implements GraphDataPort { ... } // Recorded session playback

// Feature doesn't know or care which one it gets
const view = <GraphView data={adapter} />;
```

### I — Interface Segregation

Split ports by consumer. Each consumer depends only on what it needs:

```typescript
// ✅  Three small ports
interface GraphDataPort { nodes: GraphNode[]; edges: GraphEdge[]; }
interface GraphEventPort { onNodeClick?(ref: DomainRef): void; }
interface GraphConfigPort { bloomIntensity?: number; showTasks?: boolean; }

// ❌  One massive interface — forces every consumer to know about everything
interface GraphPort {
  nodes: GraphNode[]; edges: GraphEdge[];
  onNodeClick?(ref: DomainRef): void;
  bloomIntensity?: number; showTasks?: boolean;
}
```

### D — Dependency Inversion

High-level modules (feature UI) depend on abstractions (ports), not on low-level modules (Zustand store).

```
UI → depends on → Port interface ← implemented by ← Adapter → depends on → Store

Feature code never touches the store. The adapter translates in both directions.
```

---

## Class-Based Patterns

Prefer **classes** over functions for domain logic, services, adapters, and stateful code. Use the **latest ECMAScript class features** (ES2024+).

### Modern Class Syntax

```typescript
class TeamGraphAdapter implements GraphDataPort {
  // ─── ES private fields (NOT TypeScript `private`) ─────────────
  readonly #store: StoreApi;
  #cachedNodes: GraphNode[] = [];
  #lastTeamName = '';

  // ─── Static factory (prefer for complex initialization) ───────
  static create(store: StoreApi): TeamGraphAdapter {
    return new TeamGraphAdapter(store);
  }

  // ─── Constructor with DI ──────────────────────────────────────
  constructor(store: StoreApi) {
    this.#store = store;
  }

  // ─── Accessors (get/set) ──────────────────────────────────────
  get nodes(): readonly GraphNode[] {
    return this.#cachedNodes;
  }

  // ─── Public method (port contract) ────────────────────────────
  adapt(teamData: TeamData): GraphDataPort {
    if (teamData.teamName === this.#lastTeamName) return this;
    this.#lastTeamName = teamData.teamName;
    this.#cachedNodes = this.#buildNodes(teamData);
    return this;
  }

  // ─── ES private method ────────────────────────────────────────
  #buildNodes(data: TeamData): GraphNode[] {
    return data.members.map(m => ({ id: m.name, kind: 'member', ... }));
  }

  // ─── Disposable (cleanup) ─────────────────────────────────────
  [Symbol.dispose](): void {
    this.#cachedNodes = [];
  }
}
```

### Key Rules

| Rule | Do | Don't |
|------|-----|-------|
| Private fields | `#field` (ES private) | `private field` (TS keyword) |
| Private methods | `#method()` | `private method()` |
| Readonly fields | `readonly #field` | Mutable when immutability intended |
| Static factory | `static create()` | Complex constructor logic |
| Disposal | `[Symbol.dispose]()` or `dispose()` | Forgetting cleanup |
| Type narrowing | `instanceof` checks | `as` casts |

### When to Use Classes vs Functions

| Use Case | Pattern | Why |
|----------|---------|-----|
| Domain models with state | **Class** | Encapsulation, lifecycle |
| Adapters (data mapping) | **Class** with caching | State for memoization |
| Services (business logic) | **Class** with DI | Testable, injectable |
| Canvas renderers | **Class** implementing strategy | Polymorphism |
| React components | **Function component** | React requires it |
| React hooks | **Function** | React requires it |
| Pure stateless utilities | **Function** | Simpler, no overhead |
| Constants | `as const` object | Immutable |

### Dependency Injection

Always inject dependencies through the constructor:

```typescript
class FeatureService {
  readonly #data: FeatureDataPort;
  readonly #events: FeatureEventPort;

  constructor(data: FeatureDataPort, events: FeatureEventPort) {
    this.#data = data;
    this.#events = events;
  }

  execute(): void {
    const result = this.#data.getNodes();
    this.#events.onResult?.(result);
  }
}

// Wiring in a hook:
function useFeature(): FeatureService {
  const adapter = useMemo(() => FeatureAdapter.create(store), [store]);
  return useMemo(() => new FeatureService(adapter, eventHandler), [adapter]);
}
```

### Strategy Pattern

```typescript
interface NodeRenderer {
  readonly kind: string;
  draw(ctx: CanvasRenderingContext2D, node: Node): void;
  hitTest(node: Node, x: number, y: number): boolean;
}

class MemberNodeRenderer implements NodeRenderer {
  readonly kind = 'member';
  draw(ctx: CanvasRenderingContext2D, node: Node): void { /* ... */ }
  hitTest(node: Node, x: number, y: number): boolean { /* ... */ }
}

class NodeRendererRegistry {
  readonly #renderers = new Map<string, NodeRenderer>();

  register(renderer: NodeRenderer): this {
    this.#renderers.set(renderer.kind, renderer);
    return this;
  }

  get(kind: string): NodeRenderer | undefined {
    return this.#renderers.get(kind);
  }
}

// Usage:
const registry = new NodeRendererRegistry()
  .register(new MemberNodeRenderer())
  .register(new TaskNodeRenderer());
```

---

## Error Handling

```typescript
// Domain errors — typed, not string messages
class FeatureError extends Error {
  constructor(
    readonly code: 'INVALID_DATA' | 'RENDER_FAILED' | 'ADAPTER_ERROR',
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'FeatureError';
  }
}

// In adapters — catch and wrap external errors
class FeatureAdapter {
  adapt(data: unknown): FeatureDataPort {
    try {
      return this.#transform(data);
    } catch (err) {
      throw new FeatureError('ADAPTER_ERROR', 'Failed to adapt data', err);
    }
  }
}

// In UI — catch at boundary, show fallback
function FeatureView({ data }: Props) {
  // React error boundary or try/catch in event handlers
  // Never let feature errors crash the host app
}
```

---

## Inter-Feature Communication

Features MUST NOT import from each other directly. If two features need to share data:

```
Feature A  →  emits event  →  Host app (TeamDetailView)  →  passes data  →  Feature B
```

Pattern: use `CustomEvent` on `window` (same as keyboard shortcuts):

```typescript
// Feature A fires:
window.dispatchEvent(new CustomEvent('feature-a:data-ready', { detail: { ... } }));

// Host app listens and passes to Feature B via props/ports
```

---

## Testing

Tests live in `__tests__/` inside the feature directory.

```typescript
// __tests__/adapters.test.ts — test data mapping
describe('FeatureAdapter', () => {
  it('maps TeamData members to GraphNodes', () => {
    const adapter = new FeatureAdapter();
    const result = adapter.adapt(mockTeamData);
    expect(result.nodes).toHaveLength(3);
    expect(result.nodes[0].kind).toBe('lead');
  });
});

// __tests__/domain.test.ts — test business logic
describe('SimulationService', () => {
  it('applies orbit force to task nodes', () => {
    const service = new SimulationService(mockConfig);
    service.tick(0.016);
    expect(service.nodes[0].x).toBeDefined();
  });
});
```

Run: `pnpm test -- --testPathPattern=features/<name>`

---

## Integration with Main App

Features connect through minimal **registration points** in shared files:

### Tab Registration (3 files)

```typescript
// 1. src/renderer/types/tabs.ts — add to union
type: '...' | '<feature>';

// 2. src/renderer/components/layout/PaneContent.tsx — add route
{tab.type === '<feature>' && (
  <TabUIProvider tabId={tab.id}>
    <FeatureView ... />
  </TabUIProvider>
)}

// 3. src/renderer/components/layout/SortableTab.tsx — add icon
<feature>: SomeIcon,
```

### Overlay Registration (1 file)

```typescript
// In host component (e.g., TeamDetailView.tsx):
const FeatureOverlay = lazy(() =>
  import('@renderer/features/<feature>/ui/FeatureOverlay')
    .then(m => ({ default: m.FeatureOverlay }))
);
```

### Keyboard Shortcut (1 file)

```typescript
// In useKeyboardShortcuts.ts:
if (key === '<x>' && event.shiftKey && !event.altKey) {
  window.dispatchEvent(new CustomEvent('toggle-<feature>', { detail }));
}
```

---

## Naming Conventions

| Entity | Convention | Example |
|--------|-----------|---------|
| Feature directory | `kebab-case` | `agent-graph/` |
| Port interfaces | `PascalCase` + `Port` suffix | `GraphDataPort` |
| Domain classes | `PascalCase` | `SimulationService` |
| Adapter classes | `PascalCase` + `Adapter` suffix | `TeamGraphAdapter` |
| UI components | `PascalCase` | `GraphView`, `GraphOverlay` |
| Hooks | `camelCase` + `use` prefix | `useTeamGraphAdapter` |
| Test files | `<module>.test.ts` | `adapters.test.ts` |
| Type files | `camelCase` or `types.ts` | `types.ts` |
| Barrel | `index.ts` | `index.ts` |

---

## Existing Features

| Feature | Path | Companion Package | Description |
|---------|------|-------------------|-------------|
| `agent-graph` | `features/agent-graph/` | `packages/agent-graph/` | Force-directed graph visualization |

---

## Anti-Patterns

```typescript
// ❌  Feature imports from another feature
import { X } from '@renderer/features/other-feature/X';

// ❌  UI component imports store directly (only adapters may)
import { useStore } from '@renderer/store';

// ❌  Feature imports from @renderer/components/*
import { KanbanBoard } from '@renderer/components/team/kanban/KanbanBoard';

// ❌  TypeScript `private` instead of ES #private
class Bad { private field = 1; }  // Use: #field = 1;

// ❌  Mutable global state
let globalCache = {};

// ❌  `any` or `as any`
const data = response as any;

// ❌  God-class with mixed responsibilities
class FeatureManager {
  fetchData() { ... }
  renderUI() { ... }
  handleClick() { ... }
  saveToStorage() { ... }
}
```

---

## Checklist for New Feature PR

- [ ] Feature lives in `src/renderer/features/<name>/`
- [ ] Port interfaces defined (`DataPort`, `EventPort` at minimum)
- [ ] Adapter is the ONLY file importing from `@renderer/store`
- [ ] No cross-feature imports
- [ ] Classes use ES `#private` fields, not TypeScript `private`
- [ ] `index.ts` exports only public API (ui components + port types)
- [ ] Integration points documented (which shared files were modified)
- [ ] Tests in `__tests__/` for adapter and domain logic
- [ ] Typecheck passes: `pnpm typecheck`
- [ ] Build passes: `pnpm build`
