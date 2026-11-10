# Team Provisioning Target Architecture

**Status**: normative migration standard

**Scope**: `TeamProvisioningService` and `src/main/services/team/provisioning/`
**General standard**: [`../FEATURE_ARCHITECTURE_STANDARD.md`](../FEATURE_ARCHITECTURE_STANDARD.md)

This document defines how new Team Provisioning code must be designed and how
the existing compatibility hierarchy should be reduced without a risky rewrite.

The current implementation is production-critical legacy. Existing compatibility
facades may remain until their behavior is migrated, but they are not a pattern to
copy.

## Precedence

This document is the source of truth for the target shape of Team Provisioning.
The general feature rules in `docs/FEATURE_ARCHITECTURE_STANDARD.md` still apply.

Files under `docs/iterations/`, `docs/research/`, and point-in-time `*-plan.md`
documents are historical context. If an older plan says to add orchestration,
timers, helpers, dependencies, or provider logic directly to
`TeamProvisioningService`, reinterpret that integration as thin-facade delegation
to a composed use case. This target architecture wins when the guidance conflicts.

## Why This Standard Exists

The first major refactor successfully reduced `TeamProvisioningService.ts` from a
god file to a small public facade and extracted many policies, ports, factories,
and tests.

The remaining architectural debt is primarily in how those pieces are connected:

- behavior is inherited through a deep facade hierarchy
- sibling capabilities share mutable state through `this`
- factories recover dependencies from the whole service through `ServiceHost`
  shapes
- structural casts such as `this as unknown as SomeServiceHost` hide coupling
- `protected abstract` slots make dependencies implicit

This is better than the original god file, but it is still a distributed god
object. The next phase must replace inheritance-based assembly with explicit
composition.

At the adoption of this standard, the production baseline includes:

- 22 provisioning facade-inheritance edges beneath the concrete service
- 31 `as unknown as ...ServiceHost` casts
- 62 `protected abstract readonly` dependency slots

These are migration ratchets, not acceptable targets. Their counts may only move
downward. CI enforces this with
`pnpm guard:team-provisioning-architecture`; do not raise its baseline to make a
change pass.

## Non-Goals

- Do not rewrite all provisioning behavior at once.
- Do not change public IPC, HTTP, or app-shell behavior merely to improve shape.
- Do not create empty feature folders, speculative interfaces, or unused base
  classes before the first real migrated use case needs them.
- Do not move code only to reduce file length. A move must improve ownership or
  dependency direction.
- Do not weaken launch, cancellation, idempotency, recovery, or persistence
  semantics.

## Target Shape

Keep a stable app-shell facade while callers migrate gradually:

```text
TeamProvisioningService              stable compatibility facade
  -> TeamCommandService              thin capability facade
  -> MemberLifecycleService          thin capability facade
  -> RuntimeDeliveryService          thin capability facade
  -> RuntimeRecoveryService          thin capability facade
  -> RuntimeQueryService             thin capability facade

Application services depend on:
  -> focused use cases
  -> small application-owned ports
  -> explicit state repositories and operation gates

Composition root wires:
  -> use cases
  -> infrastructure adapters
  -> provider strategies
  -> app-shell facade
```

Capability facades group a coherent public API only. Focused use cases own the
actual orchestration; capability facades must not become replacement god services.

The final feature should follow the canonical layout when enough vertical slices
have migrated to justify the move:

```text
src/features/team-provisioning/
  contracts/
  core/
    domain/
    application/
      commands/
      queries/
      ports/
  main/
    composition/
    application/
    adapters/
      input/
      output/
    infrastructure/
```

During migration, focused modules may remain under the current provisioning
directory. Correct ownership and dependency direction are more important than a
large path-only move.

## Required Design Rules

### 1. Prefer composition over inheritance

Do not add another class that extends a `TeamProvisioning*Facade` to acquire
behavior or dependencies.

Inheritance is allowed only for a genuine substitutable subtype with a stable
behavioral contract. It must not be used as dependency injection, state sharing,
or a mixin mechanism.

### 2. Keep the public facade thin

`TeamProvisioningService` may preserve stable methods required by existing
callers. New logic belongs in an application service or use case and the facade
delegates to it.

The facade may:

- enforce application admission preconditions after transport validation
- coordinate admission or operation gates
- delegate to one focused application capability
- translate the result to the stable public response

The facade must not acquire new provider-specific algorithms, persistence logic,
or multi-step recovery flows.

### 3. Make dependencies explicit

Use constructor or factory injection from the composition root.

Do not add:

- `this as unknown as SomeServiceHost`
- a new `*ServiceHost` representing the whole provisioning service
- new `protected abstract readonly` dependencies
- factories that receive the entire service and discover capabilities from it
- new `create*FromService(...)` factories
- post-construction setter injection or partially initialized services
- service-locator objects with unrelated optional dependencies

Each use case owns the smallest port required by its behavior.

### 4. Give mutable state one owner

State must be owned by a focused repository, registry, coordinator, or operation
gate rather than scattered across facade fields.

Examples:

- `ProvisioningRunRepository`
- `ProvisioningProgressStore`
- `RuntimeLaneRegistry`
- `TeamOperationGate`

The names are illustrative, not mandatory. Create a boundary only when a real
slice needs it, and keep its responsibility narrow.

Notifications and domain outcomes flow through focused output ports such as a
`ProvisioningEventSink`; an event sink is not a mutable state owner.

### 5. Separate commands from queries

Commands may change run, launch, persistence, or process state. Queries must not
silently repair or mutate that state.

If a query needs reconciliation, make the reconciliation step explicit and test
it independently.

### 6. Keep provider variability behind focused strategies

Provider-specific launch, delivery, recovery, and stop behavior belongs behind
capability-specific ports. Do not create one giant provider interface containing
every possible runtime operation.

Introduce an abstraction only for variability that already exists or is part of
the slice being migrated. Avoid speculative provider frameworks.

### 7. Preserve dependency direction

- domain policy depends on no runtime or infrastructure code
- application use cases depend on domain types and ports
- infrastructure adapters implement those ports
- the composition root depends on concrete adapters and use cases
- IPC, HTTP, and app-shell entrypoints depend only on public feature surfaces

### 8. Keep files within the source-size ratchet

New production source files must remain at or below 800 physical lines. Existing
legacy files are frozen by `scripts/ci/source-file-size-baseline.json` and must not
grow.

A smaller file is not automatically a good module. It still needs one clear
reason to change and explicit dependencies.

## Example Application Slice

```ts
export interface RestartMemberRunRepository {
  getActiveRun(teamName: string): ProvisioningRun | null;
}

export interface RestartMemberRuntimePort {
  restartMember(input: RestartMemberRuntimeInput): Promise<void>;
}

export class RestartMemberUseCase {
  constructor(
    private readonly runs: RestartMemberRunRepository,
    private readonly runtime: RestartMemberRuntimePort,
    private readonly events: ProvisioningEventSink
  ) {}

  async execute(command: RestartMemberCommand): Promise<void> {
    const run = this.runs.getActiveRun(command.teamName);
    // Validate domain invariants, invoke the focused port, then publish outcome.
  }
}
```

The use case does not receive `TeamProvisioningService`, a generic service host,
or unrelated stores. Infrastructure details are supplied by adapters in the
composition root.

## Incremental Migration Protocol

Use a strangler migration. Each PR should complete one observable vertical slice.

1. **Characterize behavior**
   - identify the stable public method and all side effects
   - preserve current concurrency, persistence, notification, and error semantics
   - add focused characterization tests before moving risky behavior

2. **Define the application boundary**
   - create a command or query model
   - define only the ports used by this slice
   - keep contracts owned by the application layer

3. **Extract the use case**
   - move orchestration without redesigning behavior in the same step
   - keep pure decisions separate from filesystem, process, or transport code

4. **Adapt infrastructure**
   - implement the ports with existing stores, runtime adapters, and process APIs
   - keep translation code at the adapter boundary

5. **Wire through composition**
   - instantiate the use case in one composition root
   - inject explicit dependencies
   - delegate from the existing facade method

6. **Prove parity**
   - run focused unit and adapter tests
   - retain or add a public-facade integration test
   - use only sandbox/test projects for live provisioning verification

7. **Remove migrated legacy wiring**
   - delete unused host casts, protected slots, factories, and facade methods
   - remove an inheritance layer when it no longer owns behavior
   - lower source-size baselines when a legacy file shrinks

Do not combine unrelated cleanup, provider redesign, and behavioral changes in a
single migration PR.

## Recommended Migration Order

Move lower-risk and read-heavy slices before lifecycle-critical commands:

1. status and runtime snapshot queries
2. tool approval request and response flow
3. message and prompt delivery
4. runtime reconciliation and recovery
5. member add, restart, and remove lifecycle
6. create, launch, cancellation, and stop orchestration

This order is guidance, not a reason to block a well-isolated opportunity in a
different slice.

## Reference Walking Slice

The first implemented target slice is the read-only provisioning status query in
`src/features/team-provisioning/`, built around `GetProvisioningStatusUseCase`.
Its local README explains the concrete call path and how to extend the example.

It should introduce only what that query needs:

- one stable status input and response contract
- one application use case
- one or more narrow reader ports
- a temporary adapter over the current run and retained-progress owners
- explicit construction in the composition root
- delegation from the existing stable API
- fake-port use-case tests, an adapter test, and a composition test

It must not receive `TeamProvisioningService` or start a provider process. This
slice proves the target dependency direction without requiring a live runtime
smoke test.

Add only the abstractions used by a real walking slice. Do not copy folders that
the next capability does not need.

## Migration Matrix

Track migrated capabilities in the implementation plan or pull request series:

| Capability          | Legacy owner         | Target use case                | State owner                         | Adapters                                | Tests                                 | Status               | Removal condition                             |
| ------------------- | -------------------- | ------------------------------ | ----------------------------------- | --------------------------------------- | ------------------------------------- | -------------------- | --------------------------------------------- |
| Provisioning status | compatibility facade | `GetProvisioningStatusUseCase` | existing progress state (temporary) | `LegacyProvisioningStatusReaderAdapter` | unit + adapter + composition + parity | walking slice active | progress reads move to an explicit repository |

Do not mark a row complete while the new use case still depends on the whole
legacy service or duplicate state remains active.

## Testing Standard

Each migrated slice should have:

- pure domain tests for branching policy and invariants
- use-case tests with small fake ports
- adapter contract tests for persistence or runtime translation
- a facade parity test proving the stable caller behavior
- focused race, idempotency, cancellation, and stale-run coverage when applicable

Avoid tests that construct the entire provisioning service merely to reach one
small policy. A focused use case should be testable without booting unrelated
runtime, store, or delivery components.

## Pull Request Checklist

- [ ] No new provisioning facade inheritance was added.
- [ ] No new whole-service host cast or `protected abstract` dependency was added.
- [ ] The public facade delegates rather than embedding new behavior.
- [ ] Ports are small and owned by the consuming use case.
- [ ] Mutable state has one explicit owner.
- [ ] Provider-specific behavior stays behind a focused port.
- [ ] New production files stay within 800 lines.
- [ ] Focused tests cover success, failure, and relevant concurrency semantics.
- [ ] Live verification, if required, uses only a sandbox/test project.
- [ ] Removed or reduced legacy wiring also ratchets its baseline downward.

## Exit Criteria

The migration is complete when:

- `TeamProvisioningService` is a small composed facade, not a subclass of a
  provisioning compatibility facade
- provisioning behavior is not assembled through a facade inheritance chain
- no application slice casts the service to a `ServiceHost`
- no use case depends on the entire provisioning service
- shared mutable state is owned by explicit repositories, registries, or gates
- provider capabilities can be extended through focused ports without modifying
  unrelated lifecycle code
- domain and application layers pass architecture boundary checks
- facade parity and focused use-case tests cover critical behavior

These criteria are more important than a particular class count or folder count.
