# Launch settings of a per-project team

Closes gap 5 of the [parity matrix](./per-project-parity-matrix.md): the launch settings of a team with separate history per project drifted between the definition (the logical team) and its project copies.

## The defect

- The launch dialog, schedules and the saved-settings token read the **logical** `team.meta.json`.
- A launch persists its settings into the **copy** (`request.teamName` is the copy name by then), never into the logical team.
- A copy took the whole saved request of the logical team once, at its first creation; later launches refreshed only roster, display metadata and lead instructions.
- A schedule of a per-project team built its launch request from the saved settings of the **copy**, so it ran the older settings of its own project.

So what a user chose in project A was invisible in project B, and the dialog kept showing the settings of the day the team was created.

## Field matrix

The owner of every saved field is one exhaustive table, `TEAM_META_FIELD_OWNER` in `src/features/team-project-context/main/definitionLaunchSettings.ts`. It is checked by the compiler against the fields of `team.meta.json`: a new field does not compile until it is assigned. The list of shared launch settings is derived from it.

| Field | Owner | Why |
| --- | --- | --- |
| `providerId`, `providerBackendId` | team definition | which runtime the lead starts with |
| `model`, `effort`, `fastMode` | team definition | lead model configuration |
| `syncModelsWithLead`, `limitContext` | team definition | team-wide launch behaviour |
| `displayName`, `description`, `color`, `prompt` | team definition | projected by `projectDefinitionToAlias` with the roster (#1244, #1247) |
| `cwd` | project copy | names the project |
| `worktree` | project copy | names a git worktree inside one project |
| `skipPermissions` | project copy | trust is granted per project; it never travels through the definition |
| `extraCliArgs` | project copy | free-form runtime arguments (tools, directories, plugins) are trust decisions of one project; the launch dialog also keeps them per browser profile, not per team |
| `launchIdentity` | project copy | derived by the runtime for one run |
| `projectContextMode`, `runtimeSelectionVersion`, `deletedAt`, `createdAt` | lifecycle | identity and state of the definition itself |

When a copy is created for a new project the materializer starts it from the whole saved request of the definition, so `skipPermissions`, `worktree` and `extraCliArgs` typed at creation are copied once as the **initial** value of that copy (`cwd` is the chosen project). They are never refreshed from the definition afterwards.

## Design

One owner, two directions, one store:

1. **Definition to copy** (existing projection, extended): `projectDefinitionToAlias` also compares the launch settings and refreshes only the keys that differ. It runs at every launch (`TeamProjectContextDraftMaterializer`) and after every definition edit (`TeamProjectDefinitionEditor.projectToAliases`). A running runtime re-reads the saved launch settings when its lead or an OpenCode member restarts, so a copy that is not confirmed stopped is **skipped silently**; the next launch refreshes it.
2. **Launch to definition** (`recordLaunchSettings`, handed out by `prepareTeamContextLaunch` as `recordLaunch`): when a launch from the app is accepted, the settings it stated are saved into the logical team and into the launched copy. A key counts only when the request has it as its own property, so an omitted key keeps the saved value and an explicit `undefined` goes back to the default (the contract the native draft launch already follows). A provider change drops what belonged to the old provider (backend, model, effort, fast mode, context limit) unless the request states it again, as the native launch does. The provider is never cleared. A launch that found the team already starting or running applies nothing and records nothing (`isFreshLaunch`, shared with the scheduler).
3. **Schedules**: `ProjectScheduleTargets.launch` overlays the team-level settings of the definition on the request the scheduler built from the copy, after the launch preparation. A scheduled run does not record settings: it runs what the definition says.
4. **One store**: `createLaunchSettingsStore()` (`TeamMetaStore.getMeta` / `updateMeta`, so writes run under the per-file mutation lock) is created once in `createProjectContextRuntimeParts` and shared by the materializer, the editor and the launch.

## Behaviour to know

- A copy created before this change keeps its old values until its next launch; those values were never shown in the UI.
- Settings are saved when a launch is **accepted**, not when the agents become ready. A launch that is accepted and later fails still leaves its settings in the definition (an ordinary team behaves the same).
- A failure to save the definition, or the copy, never fails an accepted launch. It is logged as an error and the next launch records again. The copy failing leaves it one launch behind until then.
- Settings changed outside a launch (per-member settings dialog, runtime restart of the lead) still go to the copy only: that dialog is hidden for per-project teams (gap 9).
- Because `extraCliArgs` and `skipPermissions` stay with the copy, the launch dialog of a per-project team still seeds them from its own storage, not from the team.
- The native launch prefers the `launchIdentity` of the copy over its saved model when a request omits the model. The launch dialog and the scheduler always state it, so this matters only for a hand-made partial request.

## Verification

- Unit: `definitionLaunchSettings.test.ts` (ownership, pick, provider change, record result), `projectDefinitionToAlias.test.ts`, `TeamProjectContextDraftMaterializer.test.ts`, `projectScheduleTargets.test.ts`, `teamLaunchResponse.test.ts`.
- Disk integration: `teamProjectContextCreate.integration.test.ts` (saves, nothing for a rejected or already-running launch, a save failure does not fail the launch, the launched copy follows, a schedule in A after a launch in B runs the team's settings).
- Real Electron: `scripts/e2e/project-scoped-team-history-desktop.ts`, section `verifyLaunchSettings`, with dialog-shaped requests (launch in A, change in B, explicit unset, provider change, per-project runtime arguments, a schedule in A after the change).
