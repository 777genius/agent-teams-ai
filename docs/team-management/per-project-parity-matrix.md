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
| Create through HTTP / MCP `team_create` | works | works: `projectContextMode` is required (no silent default while the board tools below do not support a per-project team) | n/a | `http/teams.ts` create route, `teamMcpControl.integration.test.ts`, E2E `verifyHttpCreateAndLaunch` |
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
| MCP board tools (`task_*`, `message_send`, `review_*`, `kanban_*`) | work | **not supported**: they require the `config.json` of a configured team, and the logical team has none (`team_get` answers `pendingCreate: true`). Next step: resolve team + `cwd` to the project copy, as the launch does | work on the copy by its name |

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
| 9 | ~~Per-member settings dialog and settings relaunch are hidden~~ done | honest | low-medium | M | The dialog edits the definition through the router while every project is stopped, the lead too (its model and effort are definition launch settings); a settings relaunch is refused (see the updates below). |
| 10 | Gateway bindings are not projected | honest | none in this build | M | Unreachable: no binding can be created in this build. When the selector returns, key bindings by the logical team and resolve them for the copy at launch (see the last update). |
| 11 | ~~Review flow and other per-team settings are per context~~ decided: per project board | semantic | low | S-M | One setting per board (project copy), consistent in the board popover, the settings page and the controller; the logical team is refused with a reason. Team-wide would need a live projection. |
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

- **Not additive:** `POST /api/teams` and MCP `team_create` now require `projectContextMode` (400 `PROJECT_CONTEXT_MODE_REQUIRED` without it). A client that relied on the old forced `shared` sends `projectContextMode: "shared"`. There is no silent default while the MCP board tools and trash do not support a per-project team (see section F).
- One launch use case for every transport: the desktop IPC, HTTP and MCP call `launchInProjectContext` (`src/features/team-project-context/main/projectContextLaunch.ts`); the HTTP launch guard that refused per-project teams is removed.
- Launches over HTTP and MCP record launch settings into the definition and the copy like a launch from the app (`recordLaunch` is called by `launchInProjectContext`); a launch that found the copy already running records nothing.
- Real agent execution after an HTTP/MCP launch was not exercised: the Electron E2E runs against a runtime that denies agents.

## Update: cross-team messaging

The rows of section C about cross-team messaging and gaps 7 and 8 changed as follows. The tables above keep the audit record.

| Row | Before | After |
| --- | --- | --- |
| Cross-team messaging, receiving | hidden/refuses; a copy received by its exact name, in whatever project the sender picked | works: the per-project team is offered under its own name (the app's team picker and the MCP `cross_team_list_targets`), and a message to it goes to its ready copy **for the project the sender works in** (the sender's `config.json` `projectPath`). No copy for that project, a launch still pending there, a sender without a project, or the team being moved to trash refuse with a message that says what to do; no copy is ever created to receive a message. A copy named exactly still receives (that is how a reply reaches the copy that wrote), unless its launch never finished |
| Cross-team messaging, sending | works, recipients see `ptc-<hash>.lead` | works; the `from` of the message stays the copy name (it is how the reply finds that copy), but the app shows the copy as `<team> · <project folder>` in the activity badge and in "awaiting reply" |
| A copy addressing its own team | n/a | refused (same team), whether by the team's name or by the exact name of the team's copy in another project; the composer and `cross_team_list_targets` no longer offer it |
| A per-project team as the sender | refused | refused with a clear reason (it has no inbox or process); every real sender is a copy |
| Task refs in a cross-team message | carry the copy name | unchanged: a task ref names the copy that owns the task, and opening a copy redirects to the team and project in the app |

How it is built:

- One rule, `resolveCrossTeamRecipient` in `src/features/team-project-context/main/crossTeamRecipient.ts`:
  - `CrossTeamService.send` applies it for the app composer and the lead's `SendMessage` to `team.member`;
  - OpenCode runtime delivery applies it when it canonicalizes a message, before the message is journaled (`TeamProvisioningRuntimeDeliveryIdentity.ts`), so the journal, the destination and its delivery proof all name the copy;
  - the MCP tools reach it over HTTP. The controller's `sendCrossTeamMessage` (behind `cross_team_send`; the controller writes the target inbox itself) asks `GET /api/teams/:team/cross-team/recipient?toTeam=…` for every target and gets the physical team or a 409 with the reason; no consumer of the controller can skip that step. `cross_team_list_targets` asks `GET /api/teams/:team/cross-team/targets`, the list of the app's picker reduced to name, display name, description and online state. Only when the app cannot be reached (no published address, network error, timeout) does the controller keep its previous behaviour: exact names, and a local scan that still lists copies. Any answer of the app is used or passed on: a refusal, a server error, a 404 (an app without these routes), or a 200 without a valid team name. The desktop app refuses to start its HTTP server without these routes.
- One display mapper, `findProjectCopyOwner` / `formatProjectCopyLabel` in the feature `core/`, over the folded team list: the main list uses it to hide a copy's own per-project team; the feature's `renderer` entrypoint (`useTeamDisplayLabel`, `useProjectCopyOwnerName`) uses it for labels and for the composer. Two projects of a team with the same folder name are told apart by their parent folder (`client-one/app`, `client-two/app`).

Changes to existing behaviour (ordinary teams included), on purpose:

- A failure to read a team's mode is a refusal with code `UNRESOLVED` (it was a plain error); the result is the same, the message says which team.
- A copy named exactly is refused when it is a copy of the sender's own team, its launch never finished, or its team is being deleted or moved to trash. It used to receive.
- The lead's live sent row names the team that received (the copy for a per-project team); the member part is unchanged.
- Kept as before after review: a shared team that retained copies from an earlier period is still offered to those copies and still receives from them, and is online only when it runs under its own name.

Where a copy name still reaches a person or an agent (follow-ups):

- agent prompts and the stored `from` (routing identities; gap 8 for agents, `TeamProvisioningPromptBuilders.ts` is size-capped);
- the default summary `Cross-team message from/to <team>` when a sender gives none, written by `CrossTeamService`, OpenCode delivery and the controller, and shown as the preview in the conversation list;
- OS notifications for cross-team messages (`src/main/index.ts`, the `from` of the message is the sender label);
- the node of the other team in the agent graph (`TeamGraphAdapter.ts`, label from the `from` of the message);
- the in-app badge and "awaiting reply" are mapped; the native tooltip of "awaiting reply" that showed the copy name is removed.

Known limits:

- A copy of another team is reachable by its exact name from any project, not only from its own project or from an open conversation with it. That is what lets a reply reach the copy that wrote. Follow-up: allow an exact copy name only when the projects match or a conversation with that copy is open, which needs conversation evidence every sender (the controller included) can read.
- Telling whether a `ptc-…` name is a copy scans the teams directory and fails closed on purpose: a damaged contexts index of any per-project team refuses messages to copies until it is repaired, because an unproven owner could be the sender's own team. Other names are never scanned.
- The in-app picker lists a per-project team even when it never ran in the current project (sending then explains it), because the picker list is shared by all open teams; `isOnline` of a per-project team in the list means any of its projects runs.

Gap 7 is closed with these limits.

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

## Update after launch settings

Gap 5 is closed for provider, model, effort, fast mode, context limit and model sync: they belong to the team definition and follow it into every project (see [per-project-launch-settings.md](./per-project-launch-settings.md)). `skipPermissions`, `worktree` and `extraCliArgs` stay per project on purpose. The "Launch settings" row of section A and gap 5 above describe the state before this change.

## Update: member settings, gateway bindings and review flow

Gaps 9, 10 and 11. The rows of section A keep the audit record; this block is newer.

| Row | Before | After |
| --- | --- | --- |
| Per-member settings dialog | hidden | works for teammates (and, since the follow-up below, the lead) while every project is stopped: the dialog of the project screen edits the member **in the definition** (`members.meta.json` of the logical team) through the same router as the roster (classification, stopped gate and projection under the logical-team lock), then the stopped copies are refreshed. While the open project runs or is launching the action is hidden on its screen; any project that runs, launches or is unreconciled makes the main process refuse the save with the reason (the dialog now shows it). A project copy is refused (`PROJECT_COPY_EDIT_MESSAGE`) |
| The lead in that dialog | hidden | works while every project is stopped: the dialog shows the definition's launch settings and saves the lead's model and effort into them (`DefinitionLaunchSettingsStore.save` inside the same definition write), the stopped copies follow through the projection; nothing is restarted, as for a stopped ordinary team (update after the follow-up below) |
| Settings-originated relaunch | hidden | refused, in main (`replaceMembers` with `memberSettingsRelaunch` of a per-project team); never offered by the app |
| Gateway member bindings | hidden | unchanged, on purpose: nothing in this build can create one (see below) |
| Review flow settings | per context (untested) | one setting per **board**, i.e. per project copy (the write and the read of the setting per board are verified in the Electron E2E; that the controller applies it when a task moves to review is covered by the controller tests, not by the E2E, whose runtime starts no agent); the logical team has no board and is refused with a reason; the settings page lists a per-project team once per project as `<team> · <project>` |

Decisions and evidence:

- **One write path.** `routeMemberSettingsWrites` (`src/main/composeTeamMemberSettings.ts`) uses the router's own primitives (`classifyDefinitionWrite`, `runLogicalDefinitionWrite` in `src/main/ipc/teams/teamProjectDefinitionEdit.ts`, which `withProjectDefinitionEdit` now uses too). The write is the ordinary member settings use case on the logical name: with no `config.json` it writes only `members.meta.json`. Its non-blocking roster lock (`tryRunLiveRosterMutation`) is now reentrant like `runLiveRosterMutation`, so it runs inside the logical-team lock instead of answering busy.
- **Storage fallback.** When internal storage falls back to JSON for a session (the SQLite driver cannot load), member settings use process-local idempotency like the task board commands, instead of failing every save with "Application command could not be started". This affected every team; the Electron E2E in CI runs in that mode.
- **What the dialog edits.** The fingerprint the use case compares includes the member's `agentId` and `joinedAt`, which the saved request does not carry and which differ between the definition and each copy. The dialog therefore reads the definition member through `getMemberSettingsTarget` (a read of the same repository) and shows exactly what is compared; the project copy's runtime member is never the baseline.
- **Settings-originated relaunch: refused, not "write to the running copy".** A value written only into a running copy is overwritten by the next projection (`projectDefinitionToAlias` at every launch and every definition edit), which is the silent class this page tracks, and copies are never the target of a definition edit anywhere else. For a stopped team no change needs a relaunch (the definition is not running): a teammate is saved in the definition, the lead's model and effort in its launch settings (see the follow-up below); only the lead's provider is changed with Change runtime.
- **Gateway bindings stay hidden.** The only writers of a binding or a gateway profile are `MemberGatewaySelector` and `GatewayProvidersSettingsSection`; neither is mounted anywhere in production code (`MemberDraftRow.tsx`: "Teammate gateway settings are temporarily hidden"), there is no HTTP or MCP route, and the add-member dialog of a per-project team does not even look bindings up. A per-project team (created since #1217) therefore cannot have one. When the selector comes back, bindings must belong to the logical team (the roster is the definition's) and be resolved for the copy at launch: the runtime looks them up by the launched (copy) name today, so a binding saved under the logical name would silently not apply.
- **Review flow per board.** The override is stored in the board's `kanban-state.json` and read by the controller when a task on that board moves to review; each copy has its own board, the board popover of a project writes that copy, and a new project starts on the default. A team-wide override would need a live projection into running boards; that is a product decision, not taken here.

Verification: unit tests for the route (real editor and gate), the router refusal, the reentrant lock, the target mapper (fingerprint round trip), the review-flow gateway and settings list; real Electron `verifyMemberSettingsAndReviewFlow` (dialog save and revert from the project screen, projection into both copies, refusals for a copy, a settings relaunch and a reserved project (the lead was refused here at first; the follow-up below saves it), review flow on board A only, the settings page label).

Still open: gap 6 (live edit).

## Update: lead settings and the review flow decision

- **Lead settings of a stopped per-project team** (the P2 of the review of #1256): saved without a launch, like a stopped ordinary team (`LegacyMemberSettingsLifecycleAdapter`, `persisted_only`). The lead's model and effort are definition launch settings. `routeMemberSettingsWrites` sends a lead change of a per-project team, inside `runLogicalDefinitionWrite` (same lock, same stopped gate), to the same member settings use case and command ledger as every other change, composed with `DefinitionLeadMemberSettingsRepositoryAdapter` (the lead read from the definition's launch settings, never from a member row; a save writes model and effort back with the launch settings store) and a lifecycle without a runtime (`src/features/team-provisioning/main/adapters/output/DefinitionLeadMemberSettingsAdapters.ts`). So a repeated command replays, conflicts name a missing team or member, and nothing duplicates the use case. `projectDefinitionToAlias` carries the values into the stopped copies, and for those (confirmed stopped) the lead identity of their last run follows too, as a stopped ordinary team saves its lead (`applyLeadRuntimeSettingsToLaunchIdentity`): the lead card of a project that ran before shows the model it will start with. Unit tests: saved while stopped, copies projected, replay with the same command id, team not found, refused while a project runs, stale fingerprint, no change, the identity of a stopped copy; a renderer test drives the real dialog of the lead (load, save, the fingerprint main compares, the team launch defaults); the Electron E2E saves and resets the lead and checks both copies.
- **Refusals are codes.** A refused member settings change answers `refused` with a `MemberSettingsRefusalReason`; the dialog shows it in the app language (`MEMBER_SETTINGS_REFUSAL_KEYS`), an unexpected error shows the generic localized failure. The copy refusal text no longer claims that a copy is refreshed from its team (not true for the copies an ordinary team retained).
- **Review flow, one setting per team: not done, evidence.** Moving the setting into the definition (one value per team, projected into every copy's board, also running ones, and into new copies) needs: a new field in `team.meta.json` with its read and write normalization in `TeamMetaStore` and an owner class in `TEAM_META_FIELD_OWNER`; a three-state value for a safe migration (absent: boards keep their own values; `null`: the team follows the default; a value) and a "per-project values differ" state on the settings page; a live projection into the boards of running copies (the board write takes `withTeamBoardLock` of the copy, the same lock every kanban write takes, so it is safe, but it adds a logical-team-lock to board-lock edge) and into a copy at creation; routing of the review-flow gateway whose composition sits in the frozen `src/main/ipc/teams.ts`; the board popover of a copy writing the team. Estimated at roughly 350 lines of code and 300 of tests, above the agreed limit, so it was stopped. Option B, smaller: keep the setting on the board and add "apply to every project" for a per-project team (the settings page and the popover write the same override into the board of every ready copy, an explicit user action; a new copy starts on the default), about 120 lines plus tests.


## Update: editing a running project team

The desktop definition editor can edit the roster and member settings when exactly one owned project runtime is confirmed ready. The existing native runtime rules still apply; launching, unreconciled, multiple or changed runtimes are refused. The logical definition and the active copy are updated under their respective locks, and stopped copies are refreshed. A durable pending marker prevents further edits or launches after an interrupted or partial update until all runtimes are confirmed stopped and the definition can be projected again. Settings that require a relaunch use a guarded stop, save and launch flow with a stable command ID; changed roster or settings invalidate the baseline. The earlier gap 6 and settings-relaunch descriptions are historical.

The runtime gates and settings use cases are covered by integration tests with synthetic state. A real Electron E2E covers guarded settings, stale baselines and projection into two copies in a sandbox with provider execution disabled; an actual provider-backed live edit has not been exercised by that E2E. See [Editing a per-project team](./per-project-team-editing.md) for recovery and restrictions.
