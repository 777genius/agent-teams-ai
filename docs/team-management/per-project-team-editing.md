# Editing a per-project team

A team created with separate history for each project is **one team** with one editable definition. This page records who owns what, how an edit flows, and what is not supported yet.

## Authority

| What | Owner | Where it lives |
| --- | --- | --- |
| Display name, description, color, lead runtime | the logical team | `team.meta.json` |
| Authored roster (name, role, workflow, runtime, MCP policy, isolation) | the logical team | `members.meta.json` |
| Tasks, inboxes, sessions, run identities | one project context | the native alias (`ptc-*`) |

The logical team has no `config.json`. A native alias is a **projection** of the logical definition for one project: it receives the authored roster and the display metadata, never the other way round, and never tasks, inboxes or sessions.

## How an edit flows

1. The user opens the ordinary Edit Team dialog (pencil on the team screen, or "Edit team" on the screen of a project without history). The dialog is fed by `getSavedRequest(logicalTeam)`, not by the snapshot of one project's run, so what is edited is exactly what is saved.
2. The ordinary handlers (`updateConfig`, `addMember`, `replaceMembers`, `removeMember`) receive the logical team name. `withProjectDefinitionEdit` (`src/main/ipc/teams/teamProjectDefinitionEdit.ts`) routes by what the name means:
   - **per-project (logical) team**: refused unless every project context is confirmed stopped (`TeamProjectContextLaunchGate.assertAllContextsStopped`), then the handler writes to the logical definition, then the stopped project copies are refreshed (`TeamProjectDefinitionEditor.projectToAliases`);
   - **project copy**: refused ("edit the team itself"), so there is no second roster;
   - **any other team**: the handler runs exactly as before, including live editing of a running team.
3. The same projection (`projectDefinitionToAlias`) runs at launch in `TeamProjectContextDraftMaterializer`, so a copy that could not be refreshed at edit time is refreshed before it starts.

A failed refresh of a copy does not fail the edit (the definition is already saved); it is logged and repeated at the next launch.

## Not supported yet

- Editing while the team runs, launches or stops in any project. One rule keeps the roster of a running copy from diverging from the definition it started from.
- Schedules for per-project teams (the scheduler refuses them; the screen says so).
- The per-member settings dialog on the team screen (it is a relaunch flow); members are edited in the Edit Team dialog.
- Gateway member bindings are keyed by team name and are not projected onto project copies.
- A settings-originated relaunch (`memberSettingsRelaunch`) for the logical team.

## Why the split is awkward, and a better target

Everything native (runtime, tasks, inboxes, MCP tools, schedules, bindings, notifications) is keyed by a physical team name, so each team-level feature needs its own logical routing and each gap shows up as "this team cannot do X". The definition is also copied into every alias, which can drift.

A better target is a single team entity with work contexts as a dimension inside it (`teams/<team>/contexts/<id>/{tasks,inboxes,sessions}`), one `config.json` authority and native tools taking `(team, context)`. That is a re-architecture of the runtime and controllers, not part of this change. Until then, route at the application boundary and keep one projection function.
