# Team Provisioning Feature

Owns desktop team creation, draft launch, relaunch, provisioning preflight, run status, cancellation, and launch diagnostics.

## Boundaries

- `contracts/` owns the stable provisioning IPC channel names.
- `core/application/` coordinates launch policy through narrow ports and plans provisioning progress state transitions without depending on Electron, Zustand, or concrete filesystem services.
- `main/adapters/input/` validates untrusted IPC input and owns renderer progress delivery.
- `main/adapters/output/` binds filesystem, metadata, cache, diagnostics, and launch-observability effects.
- `main/composition/` is the only place where concrete main-process services are wired to the application layer.
- `renderer/` owns provisioning controls, progress side effects, and team/run-scoped runtime freshness memory, binding IPC, view refresh, analytics, and runtime cleanup through narrow ports.

Create and launch always record launch intent before provisioning starts, engage the team watch scope before startup artifacts are written, report progress to the launch I/O governor before notifying the invoking renderer, and invalidate roster snapshots only after successful completion.

Renderer store composition belongs in the app store composition root. Provisioning policies and control actions must be added through the feature's public entrypoints instead of growing `teamSlice.ts` with new IPC calls or duplicated state rules.

This feature is being migrated incrementally from the legacy
`TeamProvisioningService` hierarchy. New slices use explicit composition; the
legacy service remains a stable compatibility facade while callers migrate.

## Reference Slice

`getProvisioningStatus` is the first complete walking slice:

```text
IPC / HTTP
  -> TeamProvisioningService compatibility facade
  -> TeamProvisioningStatusApi
  -> GetProvisioningStatusUseCase
  -> ProvisioningStatusReaderPort
  -> LegacyProvisioningStatusReaderAdapter
  -> existing progress state owner
```

The use case owns the `Unknown runId` application rule. The adapter only maps the
narrow reader port to the current state owner and receives explicit dependencies;
it never receives the whole provisioning service.

## Extending The Feature

For the next slice:

1. Define or reuse a stable contract under `contracts/`.
2. Add one use case and only the ports it consumes under `core/application/`.
3. Implement runtime or legacy integration under `main/adapters/`.
4. Construct the slice under `main/composition/`.
5. Delegate from the compatibility facade without adding inheritance or hidden
   service-host dependencies.
6. Add focused use-case, adapter, composition, and public-parity tests.

Do not add empty folders or speculative abstractions. See
`docs/team-management/team-provisioning-target-architecture.md` for the complete
migration standard.
