# User Attention Inbox

Reusable, read-only human attention projection; the UI is independent of Electron.
See [feature standard](../../../docs/FEATURE_ARCHITECTURE_STANDARD.md) and
[implementation plan](../../../docs/plans/2026-11-23-user-attention-inbox-mvp.md).

- `core/domain`: pure task and message policy. Existing tasks, normalized feed and read-state remain authoritative.
- `main`: bounded source-backed aggregation; same facade in IPC and HTTP.
- `preload`: IPC transport only.
- `renderer`: shared subscription, view model, compact and full presentations.

Read storage is shared with Messenger and scoped by context and effective local root.
The default local workspace retains its legacy keys; historical unscoped keys
are not copied into custom roots or remote contexts. Read observation waits for
root resolution, so an early visible row is not incorrectly marked as handled.

No notification delivery, second database, or new filesystem watcher.
