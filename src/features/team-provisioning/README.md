# Team Provisioning

Owns desktop team creation, draft launch, relaunch, provisioning preflight, run status, cancellation, and launch diagnostics.

## Boundaries

- `contracts/` owns the stable provisioning IPC channel names.
- `core/application/` coordinates launch policy through narrow ports and does not depend on Electron or concrete filesystem services.
- `main/adapters/input/` validates untrusted IPC input and owns renderer progress delivery.
- `main/adapters/output/` binds filesystem, metadata, cache, diagnostics, and launch-observability effects.
- `main/composition/` is the only place where concrete main-process services are wired to the application layer.
- `renderer/` owns the renderer-facing provisioning control slice and binds it to IPC through narrow transport, state, and effect ports.

Create and launch always record launch intent before provisioning starts, engage the team watch scope before startup artifacts are written, report progress to the launch I/O governor before notifying the invoking renderer, and invalidate roster snapshots only after successful completion.

Renderer store composition belongs in the app store composition root. Provisioning policies and control actions must be added through the feature's public entrypoints instead of growing `teamSlice.ts` with new IPC calls or duplicated state rules.
