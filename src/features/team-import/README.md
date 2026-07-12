# Team Import

Desktop-only feature for reviewing a local Claude-style agent folder and creating a draft team.

The renderer never submits a filesystem path. The main-process adapter opens the native folder
picker and inspects that selected directory in one operation. Source reads reject symbolic links,
stay inside the selected real path, and enforce file-count and byte budgets.

Layer ownership:

- `contracts/` owns the IPC channels and DTOs.
- `core/domain/` owns parsing, name validation, and workflow rewriting.
- `core/application/` owns review and draft-creation use cases.
- `main/` owns Electron folder selection, bounded filesystem reads, review storage, and IPC.
- `preload/` exposes the typed feature bridge.
- `renderer/` owns the import hook and review UI.

HTTP/server mode intentionally does not expose this feature because a server-side arbitrary-path
API would violate the selected-folder authorization boundary.
