# User Attention Inbox

Reusable, read-only human attention projection; the UI is independent of Electron.
See [feature standard](../../../docs/FEATURE_ARCHITECTURE_STANDARD.md) and
[implementation plan](../../../docs/plans/2026-11-23-user-attention-inbox-mvp.md).

- `core/domain`: pure task and message policy. Existing tasks, normalized feed and read-state remain authoritative.
- `main`: bounded source-backed aggregation; same facade in IPC and HTTP.
- `preload`: IPC transport only.
- `renderer`: shared subscription, view model, compact and full presentations.

No notification delivery, second database, or new filesystem watcher.
