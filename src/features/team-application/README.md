# Team Application

Process-limited application facade for team workflows that need to be callable
from Electron IPC today and hosted web/server adapters later.

Shape:

- `core/domain` owns Electron-neutral validation rules for team application input.
- `core/application` owns Electron-neutral use cases and ports.
- `main/composition` wires backend adapters into a small `TeamApplicationFacade`.
- `main/infrastructure` contains filesystem and main-process service adapters.
- `main/index.ts` is the public main-process entrypoint.

Current slice:

- `deleteDraftTeam(teamName)` preserves the existing `TEAM_DELETE_DRAFT` behavior
  while moving input validation, the draft-team guard, and permanent delete
  orchestration behind a use-case boundary.
