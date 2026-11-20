# Per-project teams: parity with legacy teams

Goal: a team created with separate history per project (the default mode since #1217) must not be inferior in functionality to a legacy `shared` team. This page lists where it still is, how bad each gap is, and a proposed order to close them.

Method: code reading of main at `75d4f8b152` (file and line references below), plus one probe on a Linux host with synthetic data (see the appendix). Nothing here was verified in a running app with a real provider unless a cell says so. Cells that were only read are marked **read**; cells that were not looked at closely are marked **untested**.

Related pages: [Editing a per-project team](./per-project-team-editing.md), the project-context feature README (`src/features/team-project-context/README.md`).

## Update after #1247

The cells below were written before #1247 and are kept as they were; where they disagree with this block, this block is newer.

- Lead instructions (the `prompt` row of section 2): editable in the Edit Team dialog of a per-project team and over MCP `team_update` (`leadInstructions`) / HTTP update. The text lives in the logical `team.meta.json`, is projected onto stopped project copies and repaired at launch. A prompt typed in the launch dialog applies to that start only; the next projection resets the copy.
- MCP team tools (the `team_update` part of the table in section 2): update works for a per-project team when every project is stopped, through the same stopped gate, logical-team lock and projection as the app. A running, launching or unreconciled project answers `TEAM_ACTIVE`, `TEAM_PROVISIONING` or `TEAM_PROJECT_CONTEXT_UNRECONCILED`; a project copy answers `PROJECT_COPY_NOT_EDITABLE`. `team_trash` of a per-project team (and of a copy) still refuses; `team_launch` works since the HTTP / MCP create and launch change (see the last update).
- Gap 4 (ranked list): closed, except trashing a per-project team over HTTP/MCP, which stays in the app (`PROJECT_TEAM_DESKTOP_ONLY`).
- Gap 5: `prompt` is no longer among the drifting fields (it is part of the definition now); provider, model, effort, fast mode, auto-approve, context limit and worktree still drift.
- Step 2 of the recommended order ("External edit and lead instructions"): done, with the same exception for trash.
- Schedules (section D, gap 1, step 3 of the recommended order): closed in #1246; the rows of those sections already describe the new state. A schedule stays keyed by the team and names its project (fixed once created, enforced by the server); a run goes to the ready copy of that project and is recorded as skipped, never as a failure, when none can be used. A schedule never creates a copy, so the first launch in a new project stays manual.

## 1. How a team name is resolved today

A per-project team is three kinds of names:

| Name kind | What it is | Where it lives |
| --- | --- | --- |
| shared (legacy) | one native team | the team directory has `config.json`, tasks, inboxes |
| logical | the user-visible team, authoritative definition | `team.meta.json`, `members.meta.json`, `project-contexts.json`; no `config.json`, never has a process |
| project copy (alias, `ptc-<24 hex>`) | a native team for one project | its own `config.json`, tasks, inboxes, sessions; created from the logical team |

The rule the code follows (see the comment in `TeamProjectContextRuntimeResolver.ts`): the logical name is resolved at the application boundary; everything native keeps working on a physical team name.

Consequences:

- Inside the project screen the renderer mounts the copy as an ordinary team (`ProjectScopedTeamDetailView.tsx` passes the alias to `TeamDetailView` together with `logicalTeamName`). Tasks, messages, kanban, logs, member runtime panels therefore work natively. They are the safe part of the matrix.
- Any entry point that receives the logical name must resolve it itself. Today only some do: the desktop IPC for launch (`teams.ts:2167`, `withPreparedContextLaunch`), stop (`teams.ts:745`, `stopLogicalTeam`), alive list (`teams.ts:3835`, `projectAliveTeamNames`), delete/restore/permanent delete (`teamContextLifecycle.ts`), definition edits (the router from #1244), the team list (`projectTeamSummaries`) and the cross-team directory. Every other entry point takes the name literally.
- External entry points (HTTP, MCP controller, organization map) were written for one physical name per team and mostly resolve nothing.

## 2. Parity matrix

Columns: **Legacy** = shared team. **Logical** = the per-project team as the user sees it. **Copy** = its `ptc-*` team (what runs, what agents see).

Status words: **works**, **hidden** (the control is not shown), **refuses** (an explicit error), **silently wrong** (no error, wrong result), **untested**. "read" = from code only.

### A. Definition and settings

| Feature | Legacy | Logical | Copy | Evidence |
| --- | --- | --- | --- | --- |
| Create in the app | works | works (mode picked in the form) | n/a | #1237, E2E |
| Create through HTTP / MCP `team_create` | works | works: `projectContextMode` in the request, default `per_project` like the create form of the app | n/a | `http/teams.ts` create route, `teamMcpControl.integration.test.ts`, E2E `verifyHttpCreateAndLaunch` |
| Import a team folder | works | creates a draft with the default mode (per project), no mode choice (untested) | n/a | `createDraftTeamConfig.ts` default mode, import dialog has no mode field (read) |
| Copy a team | works | works, but the copy form uses the default mode, not the source mode | n/a | `TeamListView.tsx:855` (read) |
| Edit name, description, color | works | works | refuses (by design) | #1244, E2E |
| Edit roster (add, remove, restore, role) | works, also while running | works only when every project context is stopped | refuses (by design) | `teamProjectDefinitionEdit.ts`, E2E |
| Per-member settings dialog and settings-originated relaunch | works | hidden | n/a | `TeamDetailView.tsx:2221, 3177, 3396, 3463` (read) |
| Lead instructions (prompt) | MCP / HTTP `team_update` (not in the desktop edit dialog) | refuses: no editor at all | refuses | `TeamPromptManagement.ts:269-283` (read) |
| Launch settings (provider, model, effort, fast mode, auto-approve, context limit, worktree) | stored in the team, changed at launch | **silently wrong**: copied once into the copy at first materialization, never re-projected, later changes live in the copy | owns its own copy | `TeamProjectContextDraftMaterializer.ts:76` (`...source`) vs `:59` and `projectDefinitionToAlias.ts:8,58-71` (only roster and name/description/color) (read) |
| Gateway member bindings | works | hidden: keyed by team name, not projected, selector not mounted in this build | per copy | `gateway-provider/contracts` team-keyed, #1244 docs (read) |
| Review flow settings (default and per-team override) | one setting per team | per project context: the setting lives with the task board of the copy (untested) | per copy | `TeamDataService.ts:3999` (read) |

### B. Lifecycle

| Feature | Legacy | Logical | Copy | Evidence |
| --- | --- | --- | --- | --- |
| Launch from the app | works | works, resolves or creates the copy for the selected project | refuses direct launch ("open its logical team") | `teamProjectContextLaunch.ts:26-48`, `teams.ts:2167` (read, E2E for materialization) |
| Launch through HTTP / MCP `team_launch` | works | works: `cwd` is the project; the copy is resolved or created by the same use case as the app (`launchInProjectContext`), refusals answer 409 with a code | refuses (409 `PROJECT_COPY_NOT_LAUNCHABLE`) | `http/teams/teamLaunchRoute.ts`, `teamMcpControl.integration.test.ts`, E2E `verifyHttpCreateAndLaunch` |
| Stop from the app | works | works: stops every owned context, then the logical name | works | `teamContextLifecycle.ts` `stopLogicalTeam`, `teams.ts:745` (read) |
| Stop through HTTP / MCP `team_stop` | works | **silently wrong**: stops the exact name; a team with no process is a documented no-op, so the call succeeds while the project copy keeps running | works | `teamLifecycleRoutes.ts:64-` calls `stopTeam(name)`; `TeamProvisioningStopCleanupCompatibilityFacade.ts:199` "No-op if team is not running" (read) |
| Runtime state / alive list through HTTP / MCP | works | **silently wrong**: physical names only, the logical team is never alive | works | `teamLifecycleRoutes.ts:207, 230` (read) |
| Alive list in the app | works | works (projected to logical) | works | `teams.ts:3835` (read) |
| Force stop | works | exact name, no renderer caller today | works | `teams.ts:747` (read) |
| Provisioning progress, cancel | works | works, progress is mapped to the logical name | works | `teamProjectContextLaunch.ts` mapper (read) |
| Live edit of a running team | works | refuses until all contexts are stopped | refuses | #1244 gate (read) |
| Move to trash, restore, permanent delete | works | works, stops contexts, refuses with active schedules or an unreconciled context | n/a | `teamContextLifecycle.ts` (unit tests, untested end to end) |
| Trash through MCP `team_trash` | works | refuses (`PROJECT_TEAM_DESKTOP_ONLY`) | refuses | `TeamPromptManagement.ts:269` (read) |
| Backup and restore of the definition | works | covered by the definition backup (definition files plus context index) | native backup | `TeamProjectDefinitionBackup.ts` (read, untested) |
| Auto-resume, stall monitor, prompt watchdog, startup recovery, member work sync | works | n/a | works by directory scan, names are physical | `main/index.ts` scans, `startMemberWorkSyncFeature.ts` (read) |

### C. Work data (tasks, chats, review)

| Feature | Legacy | Logical | Copy | Evidence |
| --- | --- | --- | --- | --- |
| Tasks, kanban, comments, attachments, clarification, review | works | resolved to the selected project's copy | works natively | E2E covers task and chat isolation A to B to A; the rest is read |
| Messages, inboxes, direct chats, group chats | works | same | works natively | read |
| Global task sidebar, deep links, notifications | works | folded under the logical team, alias deep links redirect | works | `projectHistoryContexts` users, `projectAliasTaskNavigation.ts`, E2E alias redirect |
| Cross-team messaging, receiving | works | **hidden/refuses**: not offered as a recipient, direct delivery refused | direct delivery to the alias name works by accident | `CrossTeamService.ts:127, 379` (read) |
| Cross-team messaging, sending | works | n/a | works, but the recipient sees `ptc-<hash>.lead` as the sender | `CrossTeamService.ts:152` (read) |
| What agents are told about their team | the team name | n/a | the internal alias name ("Team: ptc-...", `cross_team_send({ teamName: "ptc-..." })`) | `TeamProvisioningPromptBuilders.ts:922, 1059` (read) |
| MCP agent tools inside a team | works | n/a | work natively | read |

### D. Schedules

| Feature | Legacy | Logical | Copy | Evidence |
| --- | --- | --- | --- | --- |
| Create, edit, run, pause schedules | works | works: one list under the team; each schedule names its project (its working directory, an existing absolute folder, fixed once created and enforced by the server). A run goes to the ready copy of that project. It is recorded as skipped, with a reason and never as a failure, when there is no launched copy there, the copy is stuck or unreadable, the team is trashed, or the team runs in another project | refuses (a copy is never scheduled) | `projectScheduleTargets.ts`, `SmartScheduleDispatcher.ts`, E2E `verifySchedules` |

### E. Listing and aggregate views

| Feature | Legacy | Logical | Copy | Evidence |
| --- | --- | --- | --- | --- |
| Team list in the app | works | one row per team, contexts folded in | hidden (folded) | `projectTeamSummaries.ts` (read) |
| HTTP `/api/teams` and MCP `team_list` | works | **silently wrong**: the logical team is listed as a draft (`pendingCreate: true`) with no mode, and every project copy is listed as its own team with the same display name | listed | probe (appendix) |
| Organization map and org placement | works | **silently wrong**: three candidates for one team (the logical draft, always offline and with no tasks, plus one per copy) | listed as a separate team with the shared display name | probe (appendix), `TeamDirectoryOrganizationAdapter.ts:38-68` |
| Token usage, stats, task folders | works | rows per copy, shown by physical team (untested) | per copy | `TeamLaunchRunSourceDiscovery.ts` scans directories (read) |

### F. Hosted and external access

| Feature | Legacy | Logical | Copy |
| --- | --- | --- | --- |
| Hosted web / HTTP create and launch | works | works (create with a mode, launch in a project) | refused |
| MCP team tools `team_get`, `team_update`, `team_trash`, `team_launch`, `team_stop`, `team_list` | work | read, update, launch, stop and list work; trash refuses (see B) | stop works |

## 3. Ranked gaps

Impact is for a user who relies on the legacy feature. Effort: S under a day, M a few days, L more than a week. Type: **silent** (wrong result without error) or **honest** (hidden or refused).

| # | Gap | Type | Impact | Effort | Why |
| --- | --- | --- | --- | --- | --- |
| 1 | ~~Schedules unavailable~~ done | honest | high | M-L | Schedules stay keyed by the team and resolve the ready copy of the schedule's project at fire time (read-only, through the same gate as a launch). Remaining limit: a schedule never creates a copy, so the first launch of a team in a new project stays a manual action (the run is skipped until then). |
| 2 | HTTP / MCP stop, runtime and alive ignore the logical team | **silent** | high | S-M | `team_stop` reports success while the project keeps running. Resolve the logical name to its owned contexts (the IPC already has `stopLogicalTeam`). |
| 3 | HTTP / MCP list and the organization map show internal copies and a draft | **silent** | medium | S-M | Reuse `projectTeamSummaries` (and the projected alive list) for the HTTP list and the org adapter. |
| 4 | Lead instructions cannot be edited anywhere; MCP / HTTP update and trash refuse | honest | high | M | Add the field to the edit dialog and route the external update through the same editor (gate plus projection under the logical-team lock). |
| 5 | Launch settings drift between the definition and the copies | **silent** | medium-high | M | Decide which fields are definition (provider, model, effort, fast mode, auto-approve, context limit, worktree, prompt), project them like the roster, and make relaunch write to the definition. |
| 6 | Live edit of a running team is refused | honest | medium | L | Legacy adds members to a running team. Needs defined semantics for the one running context and the stopped ones. |
| 7 | Cross-team messaging cannot reach a per-project team | honest | medium | M | A recipient needs a context: the running one, else an explicit project. |
| 8 | Agents and recipients see the internal alias name | cosmetic | low-medium | S | Pass the display name into prompts and the cross-team sender label. |
| 9 | Per-member settings dialog and settings relaunch are hidden | honest | low-medium | M | Mostly UI wiring once the definition editor owns member settings. |
| 10 | Gateway bindings are not projected | honest | low-medium | M | Bindings are keyed by team name; project them like the roster or key them by definition. |
| 11 | Review flow and other per-team settings are per context | semantic | low | S-M | Product decision: team-wide or per project. |
| 12 | ~~Hosted web / HTTP create and launch~~ done | honest | depends on hosted plans | L | HTTP and MCP create with a history mode and launch a per-project team in a project through the launch use case of the app. |

The **silent** list, the ones that can mislead: 2, 3, 5 (and the cosmetic alias leak in 8).

## 4. One resolution layer

Most gaps are the same defect: an entry point takes a name literally. A single function at the application boundary would remove the defect class instead of fixing entry points one by one:

```
resolveTeamTarget(name, { projectPath? })
  -> { kind: 'physical', team, retained }
   | { kind: 'logical', logical, contexts, selected?: { alias, projectPath } }
   | { kind: 'alias', alias, logical, projectPath }
```

This is the target shape. What is implemented today is the `logical` / `physical` part (`resolveTeamTarget`, `contextGroupOf`); an owned project copy is `physical` there, and the callers that must refuse or redirect a copy ask `classifyTeamKind` (`logical` / `alias` / `native`) instead. The feature README explains why the two vocabularies differ. The resolution is built from what exists: `readTeamProjectContextMode` and `listOwnedContexts` (mode and all owned contexts), `classifyTeamKind` (project copy or not), and `TeamProjectContextRuntimeResolver.forRead` (one project). Each consumer states what a logical target means for it:

| Operation | Meaning for a logical target |
| --- | --- |
| stop, runtime, alive | all owned contexts (aggregate) |
| launch | needs a project; resolves or materializes the copy through `prepareTeamContextLaunch` under the logical-team lock |
| schedule run | needs a project; resolves the existing ready copy read-only, never creates one, then launches it through the same gate under the logical-team lock |
| edit definition | the edit router (already exists) |
| list, organization map | fold copies into the logical team (`projectTeamSummaries`) |
| cross-team delivery | the running context, else an explicit project |
| task and chat reads | the selected project's copy (already so in the app) |

This keeps the current storage model and is incremental: each consumer moves to the layer in its own small change. It does not fix drift by itself (gap 5) or live edit (gap 6); those need decisions about what the definition owns.

### Compared with "one team with contexts inside"

The long-term target in the editing page (`teams/<team>/contexts/<id>/{tasks,inboxes,sessions}`, one `config.json`, native tools taking `(team, context)`) removes the copy, the projection and the resolution layer at once, and fixes the drift by construction. It is a re-architecture of provisioning, inbox and task stores, the MCP controller, watchers and notifications, because all of them key on one physical team name today. It cannot be done as a series of small safe changes, and it needs a data migration for the teams created since #1217.

Recommendation: do the resolution layer now. Its callers already pass `(team, context)`, which is exactly the shape of the target model, so none of this work is thrown away. Write the single-entity migration as a separate RFC after the layer is in and the silent gaps are closed.

## 5. Recommended order

1. **Make the silent gaps honest** (gaps 2 and 3): resolve stop, runtime, alive and the list/organization views through the layer. Small, removes the misleading results, and the first consumers of the layer.
2. **External edit and lead instructions** (gap 4): the layer plus the existing editor; closes the biggest regression in the MCP surface.
3. **Schedules** (gap 1): done. Schedules stay keyed by the team and fire against the ready copy of the schedule's project; a scheduler never creates a copy.
4. **Launch settings as definition** (gap 5): decide the owned fields, project them, make relaunch write to the definition. Needs an E2E that changes a setting and launches in two projects.
5. **Cross-team and alias naming** (gaps 7, 8), then **live edit** (gap 6), then the hidden UI pieces (gaps 9, 10), then hosted (gap 12).

Each step ships with an E2E on the real Electron flow, like #1244.

## 6. Not verified

- Everything marked **read** was not executed. No real provider was started, so launch, relaunch and stop results are from code and from the existing E2E only.
- Schedules: the real Electron E2E runs a scheduled launch against a runtime that denies agents, so a real agent run after a scheduled launch was not exercised.
- The `team_stop` no-op for a logical name rests on the documented behavior of `stopTeam` for a team with no process; the HTTP route was not called.
- Token usage, task folders, auto-resume, stall monitor and the review-flow per-context behavior were only skimmed.
- Hosted web and the real MCP controller were not exercised.
- Windows and macOS behavior of any of the above.

## Update after #1248

The tables above describe the state before #1248 and are kept as the audit record. #1248 changes these rows (see [per-project-team-targets.md](./per-project-team-targets.md)):

| Row | Before | After |
| --- | --- | --- |
| Stop through HTTP / MCP `team_stop` | silently wrong | stops every owned context (and the own process of a shared team that retained contexts, or of a logical team that somehow has one) with the escalated in-app flow, verifies each is down (a dead run counts as down, a live one does not; a bounded re-read absorbs a stop that is still settling; a copy that is still `reserved`, i.e. a launch in progress, is never confirmed stopped) and answers 409 `LOGICAL_STOP_INCOMPLETE` with the per-context outcome otherwise. Over MCP the guard now lets a per-project team (no `config.json`) through to the API |
| Runtime state / alive list through HTTP / MCP | silently wrong | the logical team is alive when any context is, with `contexts[]`; the alive list keeps physical entries and adds the logical one (a shared team that is itself alive absorbs its contexts) |
| Force stop through HTTP | exact name only | every context; answers `complete`, which a client must read (it also covers an incomplete cleanup and surviving runtime hosts). MCP has no force-stop tool |
| HTTP `/api/teams` and MCP `team_list` | silently wrong | one row per team, copies folded away. **Not additive**: the copies are no longer listed as separate teams |
| Organization map | silently wrong | one candidate; tasks of all contexts, each carrying the copy that owns it, so the inspector lists them and its task actions run against the copy |
| MCP team tools `team_stop`, `team_list` | silently wrong | as above; the controller allows a stop request 5 minutes instead of 10 s, does not ask another address after a timeout, and keeps `code`/`outcome` on its error |

Decisions worth knowing:

- **A shared team that kept a contexts index stays native**: it is classified by its history mode, not by owning an index, because its own name is still a process. The retained contexts are covered in addition.
- **Unreadable metadata** refuses (409) only for a team that owns a contexts index; otherwise the exact name is used and the answer carries `projectContextUnresolved: true`.
- **Gap 8 (alias names visible) stays deferred**: the names are routing identities in agent prompts, and `TeamProvisioningPromptBuilders.ts` is a frozen size-capped file.

Still open after #1247 and #1248: gaps 5 (all fields but the prompt), 6, 7, 9, 10, 11, 12, and gap 1 (schedules, which #1246 addresses). Gap 4 was closed by #1247 (except trash over HTTP/MCP), gaps 2 and 3 by this change, gap 8 stays deferred. The organization map does not count a reserved copy that is still provisioning as online, and the inspector does not load a copy's kanban state.

## Update after HTTP / MCP create and launch

The rows "Create through HTTP / MCP `team_create`", "Launch through HTTP / MCP `team_launch`" and section F were updated in place; gap 12 is closed. Details and the client contract: [per-project-team-targets.md](./per-project-team-targets.md#create-and-launch-over-http-and-mcp).

- **Not additive:** `POST /api/teams` and MCP `team_create` without `projectContextMode` now create a team with separate history per project (the default of the app). A client that relied on the old forced `shared` must send `projectContextMode: "shared"`. Such a team cannot be trashed over HTTP/MCP yet (`PROJECT_TEAM_DESKTOP_ONLY`).
- One launch use case for every transport: the desktop IPC, HTTP and MCP call `launchInProjectContext`; the HTTP launch guard that refused per-project teams is removed.
- Real agent execution after an HTTP/MCP launch was not exercised: the Electron E2E runs against a runtime that denies agents.

## Appendix: probe of the raw team list

Run on a Linux host at `75d4f8b152` with a temporary directory and synthetic data: one logical team `builders` (mode `per_project`, no `config.json`) and two project copies with their own config and one task each. `TeamDataService.listTeams()` is what the HTTP list, MCP `team_list` and the organization adapter read.

```
RAW_LIST
  builders                      displayName "Builders"  pendingCreate true   mode absent
  ptc-aaaaaaaaaaaaaaaaaaaaaaaa  displayName "Builders"  pendingCreate false  mode absent
  ptc-bbbbbbbbbbbbbbbbbbbbbbbb  displayName "Builders"  pendingCreate false  mode absent

ORG_CANDIDATES (TeamDirectoryOrganizationAdapter)
  builders                      pendingCreate true   isOnline false  tasks 0  members 1
  ptc-aaaaaaaaaaaaaaaaaaaaaaaa  pendingCreate false  isOnline false  tasks 1  members 2
  ptc-bbbbbbbbbbbbbbbbbbbbbbbb  pendingCreate false  isOnline false  tasks 1  members 2
```

The app's own team list folds the copies into the logical team (`projectTeamSummaries`); the HTTP list and the organization adapter do not call it.
