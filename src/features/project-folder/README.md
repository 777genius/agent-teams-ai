# Project folder

Desktop-only helper for Create/Launch custom paths: read whether a folder exists
and create it on an explicit user action.

- `contracts`: path request/result DTOs and IPC channel names
- `main`: validated mkdir/stat facade; never treats permission or I/O failures as
  a missing folder
- `preload`: `projectFolder.getState` / `projectFolder.create`
- `renderer`: debounced existence check used by the team dialogs

Browser mode stubs both methods as `unknown`. Creating a local folder has no
meaningful HTTP equivalent, so there is no server route.

The feature does not launch teams, change launch authority, or auto-create
folders while the user is typing. Create Team still mkdirs on submit; OpenCode
preflight needs the folder earlier, which is why the dialog offers **Create
folder**.
