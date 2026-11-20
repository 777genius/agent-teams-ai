# Launch settings of a per-project team

Closes gap 5 of the [parity matrix](./per-project-parity-matrix.md): the launch settings of a team with separate history per project drifted between the definition (the logical team) and its project copies.

## The defect

- The launch dialog, schedules and the saved-settings token read the **logical** `team.meta.json`.
- A launch persists its settings into the **copy** (`request.teamName` is the copy name by then), never into the logical team.
- A copy took the whole saved request of the logical team once, at its first creation; later launches refreshed only roster, display metadata and lead instructions.

So what a user chose in project A was invisible in project B, and the dialog kept showing the settings of the day the team was created.

## Field matrix

| Field | Owner | Why |
| --- | --- | --- |
| `providerId`, `providerBackendId` | team definition | which runtime the lead starts with |
| `model`, `effort`, `fastMode` | team definition | lead model configuration |
| `syncModelsWithLead`, `limitContext` | team definition | team-wide launch behaviour |
| `extraCliArgs` | team definition | user-typed runtime options of the team |
| roster, name, description, color, `prompt` | team definition | already projected by `projectDefinitionToAlias` (#1244, #1247) |
| `cwd` | project copy | names the project |
| `worktree` | project copy | names a git worktree inside one project |
| `skipPermissions` | project copy | trust is granted per project; it must never travel through the definition (the launch dialog already treats it that way) |
| `launchIdentity`, `createdAt` | project copy | derived by the runtime for one run |

The list is one constant, `DEFINITION_LAUNCH_SETTING_KEYS` in `src/features/team-project-context/main/definitionLaunchSettings.ts`.

## Design

One owner, two directions, one writer:

1. **Definition to copy** (existing projection, extended): `projectDefinitionToAlias` also compares the launch settings and refreshes only the keys that differ. It runs at every launch (`TeamProjectContextDraftMaterializer`) and after every definition edit (`TeamProjectDefinitionEditor.projectToAliases`). Unlike roster and metadata it does not demand a stopped runtime: no runtime reads these fields while it runs.
2. **Launch to definition** (`recordLaunchSettings`): when a launch from the app is accepted, the settings it stated are saved into the logical team and into the launched copy. A key counts only when the request has it as its own property, so an omitted key keeps the saved value and an explicit `undefined` goes back to the default (the contract the native draft launch already follows). The provider is never cleared. A launch that found the team already starting or running applies nothing and records nothing.
3. **One persistence adapter**: `createLaunchSettingsStore()` (`TeamMetaStore.updateMeta`, so it runs under the per-file mutation lock) is used for the definition, for copies and for the projection.

Schedules need no change: they already read the logical settings, so they now start from the latest launch. A scheduled run does not record settings: it runs what the definition says.

## Behaviour to know

- A copy created before this change keeps its old values until its next launch; the old values were never shown in the UI.
- Settings are saved when the launch is **accepted**, not when the agents become ready. A launch that is accepted and later fails still leaves its settings in the definition (an ordinary team behaves the same).
- A failure to save never fails an accepted launch; it is logged and the next launch records again.
- Settings changed outside a launch (per-member settings dialog, runtime restart of the lead) still go to the copy only: that dialog is hidden for per-project teams (gap 9).
- `extraCliArgs` now follows the team from project to project. It is validated by the same guard as before; a user who puts a project-specific path there will see it in the launch dialog of the other project.

## Verification

- Unit: `definitionLaunchSettings.test.ts`, `projectDefinitionToAlias.test.ts`, `TeamProjectContextDraftMaterializer.test.ts`.
- Disk integration: `teamProjectContextCreate.integration.test.ts` (saves, saves nothing for a rejected or already-running launch, a save failure does not fail the launch, the launched copy follows).
- Real Electron: `scripts/e2e/project-scoped-team-history-desktop.ts`, section `verifyLaunchSettings` (launch in A, in B with nothing chosen, in B with a change, in A again).
