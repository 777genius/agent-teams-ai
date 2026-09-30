# Change Review History

This feature owns durable review decisions, per-file manual editor history, CAS
recovery branches, and their IPC channels.

- `contracts/` contains browser-safe history DTOs and stable channel names.
- `core/application/` coordinates the shared persistence lock, mutation recovery,
  authoritative reviewed-file authorization, and narrow history repository
  ports.
- `core/domain/` validates generic decision history, recovery candidates, and
  response-loss reconciliation without Electron or filesystem dependencies.
- `main/adapters/input/ipc/` owns Electron registration and receives the legacy
  `IpcResult` error boundary from the composition root.
- `main/infrastructure/` owns the constrained filesystem store.
- `renderer/` owns CodeMirror serialization and write buffering.

The legacy review composition root supplies the same persistence lock used by
decision mutations and resolves reviewed-file authorization on every call. The
feature never imports the legacy review IPC module.
