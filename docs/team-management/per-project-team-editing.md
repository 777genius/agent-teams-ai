# Editing a per-project team

A team created with separate history for each project is **one team** with one editable definition. This page records who owns what, how an edit flows, and what is not supported yet.

## Authority

| What | Owner | Where it lives |
| --- | --- | --- |
| Display name, description, color, lead instructions (`prompt`), lead runtime | the logical team | `team.meta.json` |
| Authored roster (name, role, workflow, runtime, MCP policy, isolation) | the logical team | `members.meta.json` |
| Tasks, inboxes, sessions, run identities | one project context | the native alias (`ptc-*`) |

The logical team has no `config.json`. A native alias is a **projection** of the logical definition for one project: it receives the authored roster and the display metadata, never the other way round, and never tasks, inboxes or sessions.

## How an edit flows

1. The user opens the ordinary Edit Team dialog (pencil on the team screen, or "Edit team" on the screen of a project without history). The dialog is fed by `getSavedRequest(logicalTeam)`, not by the snapshot of one project's run, so what is edited is exactly what is saved.
2. The ordinary handlers (`updateConfig`, `addMember`, `replaceMembers`, `removeMember`, `restoreMember`, `updateMemberRole`) receive the logical team name. `withProjectDefinitionEdit` (`src/main/ipc/teams/teamProjectDefinitionEdit.ts`) routes by what the name means:
   - **per-project (logical) team**: inside the logical-team operation lock that launch admission takes, a stopped team writes its definition and refreshes stopped copies. If exactly one owned project has a ready live runtime, the router holds that runtime's roster/stop gate, writes the definition, applies the same native handler to the live copy, and refreshes the other stopped copies. Launching, stopping, reserved, ambiguous or multiple live contexts are refused;
   - **project copy**: refused ("edit the team itself"), so there is no second roster;
   - **any other team**: the handler runs exactly as before, including live editing of a running team;
   - **unreadable team metadata**: refused (fail closed).
3. The same projection (`projectDefinitionToAlias`) runs at launch in `TeamProjectContextDraftMaterializer`, so a copy that could not be refreshed at edit time is refreshed before it starts.

A failed refresh of a stopped copy does not fail the edit (the definition is already saved); it is logged and repeated at the next launch. A live edit records a durable pending marker before either write. If the edit fails or the app stops between writes, the result reports that the edit may be partial and subsequent edits and launches refuse while a runtime is still present. After every runtime is confirmed stopped, the marker is cleared; each copy is projected from the saved definition before its next launch. This preserves project tasks, inboxes and runtime identities. An unreadable marker is not automatically removed.

Member settings (the per-member dialog of the team screen) follow the same rules:

- The dialog of a project screen edits the member **in the definition**: it reads the saved member of the logical team (`getMemberSettingsTarget`, whose identity fields match what the save compares) and saves through `updateMemberSettings` with the logical name. `routeMemberSettingsWrites` (`src/main/composeTeamMemberSettings.ts`) uses the same settings use case and command ledger. A stopped team writes `members.meta.json` under the logical lock and refreshes its stopped copies; a ready running project uses the guarded live operation described below. A project copy is refused like any other definition edit.
- The lead of a per-project team has no member row in the definition: its provider, model and effort are team launch settings (`TEAM_META_FIELD_OWNER`). Its card opens the same dialog, which shows the definition's launch settings and saves the lead's model and effort with `DefinitionLaunchSettingsStore.save` (the store a launch records into) inside the same definition write, so stopped copies follow through the ordinary projection. For a running copy, the native lead lifecycle is applied as part of the guarded live operation; for a stopped team, a launch picks the saved values up. The provider is changed with Change runtime (a launch), as before.
- A member setting can also be changed while one owned project runs. The same idempotent command machinery applies the native member lifecycle to that copy and saves the definition under both runtime gates; an interrupted or partially applied change keeps the recovery marker. When the native workflow requires a full team relaunch, confirmation stops the logical team, checks the original launch settings and every roster fingerprint under its lock, saves the intended change and then launches. Changed baselines refuse without a write. Launching, stopping or unreconciled contexts still refuse with a stable code.

The review flow of a per-project team is a setting of a project board, not of the definition: each copy has its own override in its `kanban-state.json` (the controller reads it there), set from that project's board or from the settings page, where the team is listed once per project as `<team> · <project>`. An override for the logical team (no board) is refused with the reason.

Two more rules keep the router the only writer of the definition:

- External HTTP/MCP edits (`TeamPromptManagement`) follow the same rules through one port (`createTeamProjectDefinitionPort`, which builds the router's editor): a per-project team is classified, its stopped-gate runs inside the same logical-team operation lock, the ordinary write happens (metadata, lead instructions, members) and the stopped project copies are refreshed afterwards. A project that runs, launches or stops blocks the edit with `TEAM_ACTIVE` / `TEAM_PROVISIONING` (or `TEAM_PROJECT_CONTEXT_UNRECONCILED` for an interrupted start); a project copy is refused with `PROJECT_COPY_NOT_EDITABLE`; a team whose kind cannot be determined is rejected before any write (`TEAM_METADATA_UNREADABLE`). Trashing a per-project team stays in the app (`PROJECT_TEAM_DESKTOP_ONLY`): it needs the permanent-deletion lifecycle fence. A project copy is classified before any runtime check, so it is refused with `PROJECT_COPY_NOT_EDITABLE` straight away, for edits and for trash alike (before this change trashing a copy answered `PROJECT_TEAM_DESKTOP_ONLY`).
- The saved lead instructions (`team.meta.json` `prompt`) belong to the definition too. They are edited in the same dialog (a field shown only for a per-project team), written through the same `updateConfig` router, projected onto stopped copies and repaired at launch. A prompt typed in the launch dialog applies to that start only and is no longer the saved one: the next projection (the next edit or the next launch) resets the copy to the definition's prompt, or clears it if the definition has none. The edit dialog says so in its hint. Only a per-project team accepts the prompt in `updateConfig`; for an ordinary team the router refuses it, because the running lead already started from its launch prompt.
- No launch or relaunch flow writes the roster of the definition: the dialogs are `rosterReadOnly` for a per-project team, `executeTeamRelaunch` requires the flag and skips the roster save when it is set, "Change runtime" opens relaunch mode without a member settings draft, and main refuses `replaceMembers` with `memberSettingsRelaunch` for a per-project team.

## Not supported yet

- Editing while a project is launching, stopping or unreconciled, or when more than one project is running. The runtime mutation capabilities of the native team (including its provider-specific restrictions) also apply to the active copy.
- A schedule whose project has no launched copy yet: the run is skipped with a reason. Launch the team in that project once.
- Gateway member bindings are keyed by team name and are not projected onto project copies. Nothing in this build can create one (the selector and the gateway settings are not mounted, there is no HTTP or MCP route), so a per-project team has none; when the selector returns, bindings must belong to the logical team and be resolved for the copy at launch.
- A project context stuck in `reserved` after a crash blocks editing until the team is launched in that project again.
- The legacy roster-replacement form of a settings-originated relaunch (`memberSettingsRelaunch`) remains refused for a per-project team. The dialog instead commits a guarded member-settings command to the stopped logical definition before launching its project copy.

## Why the split is awkward, and a better target

Everything native (runtime, tasks, inboxes, MCP tools, schedules, bindings, notifications) is keyed by a physical team name, so each team-level feature needs its own logical routing and each gap shows up as "this team cannot do X". The definition is also copied into every alias, which can drift.

A better target is a single team entity with work contexts as a dimension inside it (`teams/<team>/contexts/<id>/{tasks,inboxes,sessions}`), one `config.json` authority and native tools taking `(team, context)`. That is a re-architecture of the runtime and controllers, not part of this change. Until then, route at the application boundary and keep one projection function.
