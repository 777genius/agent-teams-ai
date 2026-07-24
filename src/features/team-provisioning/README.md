# Team Provisioning Feature

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
