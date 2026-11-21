# Per-project teams at HTTP and MCP boundaries

A team of the per-project history mode is three kinds of names (see [per-project-team-editing.md](./per-project-team-editing.md)): the **logical** team the user sees (no process of its own), its **project copies** (`ptc-<hex>`, native teams) and ordinary **native** teams. Entry points that take a team name literally (HTTP, the MCP controller, directory views) must first say which kind they got. That is `resolveTeamTarget` in `src/features/team-project-context/main/resolveTeamTarget.ts`.

```
resolveTeamTarget(ports, name)
  -> { kind: 'logical', logical, contexts }                    // per_project mode: every owned project context
   | { kind: 'native', team, retained, projectContextUnresolved? }
```

The kind follows the team's **history mode**, never whether it happens to own a contexts index:

- `per_project` → `logical`. The name has no process of its own; its runtime is its contexts.
- anything else → `native`. The name is the process. A shared team that kept a project-contexts index from an earlier per-project period lists those contexts in `retained`, because they may still run.
- A project copy (`ptc-…`) is an ordinary native team. Every route keeps addressing it by its exact name, so the resolver does not scan the teams directory to classify it.

`contextGroupOf` turns a target into the group a route works on: the team's name plus its contexts (a logical team, or a native team with retained contexts). For every group the team's **own name is read and stopped too when it does not read as down** (a live process, a run in flight, or a run that is still tracked), like the in-app Stop does: a shared team runs under its name, and a logical team should not have a process but is reported and stopped if it somehow has one. A name that reads as down is left alone.

It fails closed where being wrong is silent:

- contexts whose ownership cannot be proven reject with `TeamTargetUnresolvedError` (HTTP 409, code `TEAM_TARGET_UNRESOLVED`);
- unreadable team metadata rejects the same way **when the team owns a contexts index** (it may be a per-project team);
- unreadable metadata of a team **without** a contexts index keeps the old exact-name behaviour and is flagged with `projectContextUnresolved: true` in the answer, so a damaged ordinary team can still be stopped.

This closes gaps 2 and 3 of the [parity matrix](./per-project-parity-matrix.md) (the two that returned a wrong result without an error).

## What each consumer does

| Consumer | Team with contexts (logical, or shared with retained contexts) | Project copy / native team |
| --- | --- | --- |
| `POST /api/teams/:team/stop` | stops every owned context and the own name when it does not read as down, with the same escalated flow as the in-app Stop, then verifies each is down; 409 naming the project if one still runs or one is pending a launch | exact stop (unchanged) |
| `POST /api/teams/:team/force-stop` | the same with the force-stop flow; answers `{ teamName, complete, contexts[] }`, the own process is listed with `projectPath: null` | exact (unchanged) |
| `GET /api/teams/:team/runtime` | aggregated state (own process and contexts) plus `contexts[]` | exact (unchanged) |
| `GET /api/teams/runtime/alive` | one added entry per logical team with a live context; a live shared team absorbs its contexts into its own entry | physical entry stays |
| `GET /api/teams` and MCP `team_list` | one row with its contexts, copies folded away (same as the in-app list) | copies of a folded team are not listed |
| Organization map | one candidate; tasks of all contexts, each marked with the copy that owns it | not a candidate |
| `GET /api/teams/:team/cross-team/targets` (MCP `cross_team_list_targets`) | a per-project team is listed under its own name; the team of a copy that asks is not | copies are not listed |
| `GET /api/teams/:team/cross-team/recipient?toTeam=` (MCP `cross_team_send`) | the ready copy for the sender's project, or 409 with the reason (`NO_PROJECT_HISTORY`, `PROJECT_LAUNCH_PENDING`, `SENDER_PROJECT_UNKNOWN`, `SENDER_IS_PROJECT_TEAM`, `SAME_TEAM`, `UNRESOLVED`, `TEAM_METADATA_UNREADABLE`) | the exact name; a copy of the sender's own team (`SAME_TEAM`), one whose launch never finished (`PROJECT_LAUNCH_PENDING`) or one whose team is being deleted or moved to trash (`UNRESOLVED`) is refused. The controller treats any answer, a 404 included, as the app's; only an unreachable app keeps the old exact-name behaviour |

## Contract for MCP and HTTP clients

Everything is additive except the list. **The list change is not additive**: the project copies of a per-project team are no longer returned as extra teams (listing them next to the logical team with the same display name was the defect). A client that addressed a copy through the list must take the copy names from `projectHistoryContexts` of the logical row.

- `runtime` of a team that owns contexts keeps `{ teamName, isAlive, runId, progress }` and adds `contexts[]`: `{ executionTeamName, projectPath, state, isAlive, runId, progress }`. `isAlive` is true when the own process or any context is; `runId` and `progress` are those of the live one, else of one that is **still provisioning**, else of one that keeps a settled progress. `team_stop`'s wait loop (which polls `runtime`) therefore waits for the real state.
- `runtime/alive` keeps every physical entry. A project copy that cannot be tied to its logical team stays in the list with `projectContextUnresolved: true`. All copies are proven with one scan of the teams directory.
- `stop` of a team with contexts answers 409 when something did not come down. The body is `{ error, code: 'LOGICAL_STOP_INCOMPLETE', outcome }`; `outcome.contexts[]` has one entry per context (and the own process) with `executionTeamName`, `projectPath` (`null` for the own process), `error?`, `stillAlive`, `appearedDuringStop?`. The stop of the others still runs: one failure does not abandon the rest. The refusal is also logged.
- `force-stop` of a team with contexts answers 200 with what the cleanup did. `complete` is true only when every context verified as down **and** no confirmed stop left its cleanup incomplete (`cleanupOutcome`) **and** no recorded runtime host survived (an unreadable launch state is not proof that none did); `verificationError` appears when the contexts could not be re-read. A client must read `complete`, it is not an error status. After a regular stop that failed, the flow always reports its cleanup as incomplete, so there the verification of the runtime decides.
- A second `stop` of a team that arrives while a `stop` of it is still running **joins it** (same answer, no second stop of the copies), and likewise a second `force-stop` joins a running `force-stop`. A `stop` and a `force-stop` of the same team do **not** join each other: they use separate keys and can run in parallel. The join is per app process and is what makes a client retry after a timeout safe.
- A copy stays addressable by its exact name for stop, force-stop and runtime. Edits of a copy are refused elsewhere (see the editing page).

### MCP

- `team_stop` accepts a per-project team: its MCP guard (`assertConfiguredOrDraftTeam`) accepts a configured team, a draft, or a `team.meta.json` of the per-project mode, because a logical team has no `config.json`. Anything else is still refused as an unknown team before any call. The widened guard also applies to `team_launch` (it uses the same function; a logical team is launched in a project, see [below](#create-and-launch-over-http-and-mcp)) and to **draft** teams in `team_stop` (the HTTP stop then writes a stop marker into the draft's directory).
- MCP has no tools for `runtime`, `runtime/alive` or `force-stop`; those are HTTP routes.
- The MCP error text is the HTTP `error` message, which already names every project and copy that did not stop. The structured `code` and `outcome` are kept on the controller error (`error.code`, `error.outcome`) for programmatic callers and are what HTTP clients receive in the body.
- `team_stop` posts the stop and then polls `runtime`. The server may spend up to 120 s per team escalating a stop that does not confirm, and stops the copies of a logical team one after another, so the controller gives the stop request 5 minutes (`stopRequestTimeoutMs` overrides it) instead of the 10 s default. When it still times out it does **not** ask another address to stop the team: the first server may still be working. A retry to the same server joins the stop in progress (above).

## Verification after a stop

A stop only counts when each context is **down**, judged by one shared predicate, `isStoppedTeamRuntime`, which the launch gate builds its stricter `isConfirmedStoppedTeamRuntime` on:

| Reading of the runtime | After a stop | For a launch or an edit |
| --- | --- | --- |
| live process | not down | not down |
| no progress, no run id | down | down |
| no progress, run id not cleared yet | not down (the stop is still settling) | not down |
| progress `failed` / `cancelled` (a dead run, including a dead bootstrap owner that is still reported with its run id) | down | not down until the run id is released |
| progress `failed` with retained secondary lanes | not down | not down |
| progress `ready` / `disconnected`, or any run still in flight (a live bootstrap owner) | not down | not down |

A context that does not read as down is re-read a bounded number of times (8 reads, 500 ms apart) before the stop is reported incomplete, because a run id can be cleared a moment after the stop call returns. Recorded runtime hosts that are still alive, or a launch state that cannot be read, also keep a context from reading as down.

A context in state `reserved` is **never** confirmed stopped, whether it existed before the stop or appeared during it (`pendingLaunch` in the outcome): a launch is in progress there (or was interrupted), no run is registered yet, so it reads as down while the copy is about to start. The app is fail-closed the same way. Such a copy is still asked to stop (after its owner is proven), and the stop answers 409 naming the project and the copy with the reason `a launch is in progress in this project`; the way out is to wait for the launch, or to open the team in that project in the app to finish it. After all contexts were asked to stop, the contexts are listed again: a copy that appeared meanwhile is reported as `appearedDuringStop`, and a ready one must verify as down.

- A pending (`reserved`) context may already host a process. It is only stopped after its owner marker is verified, like the in-app stop; if that fails nothing is stopped and the request answers 409.
- The stop takes no logical-team lock (the in-app stop does not either): holding it for the whole escalation budget would block launches. The verification is therefore a check of the state at that moment, not a guarantee: a launch that starts after it is outside the contract.

## Stop, then edit

A 200 from `team_stop` means every context read as down, which includes a dead run that is still tracked (its run id is released only by the app). Editing is stricter: `team_update` / HTTP update need every context *confirmed* stopped, so right after such a stop it can still answer `TEAM_ACTIVE`. The message then says `A run of this team in a project has stopped but is not released yet. Open the team in that project in the app so it is reconciled, then edit the team`. Stopping again changes nothing; this cannot be released over HTTP/MCP, so a headless agent should report it to the user instead of retrying. (A run that is really going keeps the message `stop it in every project`.)

## Not covered

- A step of the stop flow that hangs without a timeout (`beginStop`, `markStopped`, the lead-tree reap) would leave its in-flight join entry in place, so later stops of that team would join the hung one until the app restarts.
- `runtime_already_down` right after a stop: the run id can be cleared a moment later, so the verification waits about 3.5 s (8 reads). A logical stop can answer 409 where a stop of a native team answers 200; that is the safe direction.
- The bootstrap owner check in `TeamBootstrapStateReader` can mistake a reused pid for a live owner. It is old behaviour that is now visible over HTTP/MCP as a context that does not read as down.
- In the organization inspector, lookups keyed by task id alone (the kanban state) are not owner-scoped; cards and actions are. Legacy numeric ids repeat across copies.
- There is no integration test against a real runtime or a killed CLI; the route tests use a fake runtime over a real temp-dir registry.

## Known limits

- The organization map shows a team **online** from its ready contexts that are alive; a reserved copy that is still provisioning is not counted as online there (the runtime routes do report its progress).
- Task actions in the organization inspector run against the project copy that owns the task, which the node's tasks carry as `executionTeamName`; cards are bound to that owner, so repeated task ids in two copies do not cross. A stored organization node that points at a `ptc-…` name (instead of the logical team) now reads as "team not found", because copies are folded away.
- The kanban state of a copy is not loaded for the node, so the inspector shows the task card without its review state.

## What stays out of this change

- The cross-team `from` attribute (`team.member`) and every `teamName: "..."` in an agent prompt are routing identities and keep the physical name; only labels that are purely cosmetic could show the display name, and the member prompts already print both (`team "<display>" (<physical>)`). The app shows a copy in cross-team badges as `<team> · <project folder>` (`formatProjectCopyLabel`).
- Schedules, the lead prompt, MCP/HTTP update and trash, launch-settings drift and live edit are separate gaps (see the [parity matrix](./per-project-parity-matrix.md)). Cross-team delivery to a per-project team goes to its copy for the sender's project (`resolveCrossTeamRecipient`, see the update block of the parity matrix). Create and launch over HTTP/MCP are described below.

## Create and launch over HTTP and MCP

### Create

`POST /api/teams` and MCP `team_create` require `projectContextMode` (`per_project` or `shared`); without it they answer 400 with code `PROJECT_CONTEXT_MODE_REQUIRED`, and the answer of a create echoes the mode. There is no silent default (the app's form defaults to `per_project`) while the MCP board tools (`task_*`, `message_send`, `review_*`) and trash do not support a per-project team: they need the `config.json` of a configured team, which the logical team does not have. A per-project team is created as a draft of the logical team (`team.meta.json`, `members.meta.json`, no `config.json`, no copy yet), the same files the app writes. `cwd` is optional and stays the folder shown by default; it does not create a project copy.

This is **not additive**: before, HTTP always created `shared` (and refused an explicit `per_project`). A client that relied on that sends `projectContextMode: "shared"`.

### Launch

`POST /api/teams/:team/launch` and MCP `team_launch` of a logical team launch it **in the project `cwd`**, through the use case the app uses for its launch dialog, `launchInProjectContext` (`src/features/team-project-context/main/projectContextLaunch.ts`; the desktop IPC calls it through `withPreparedContextLaunch`, HTTP through the `projectTeamLaunch` port of the HTTP services):

1. under the configuration lock of the team (the same lock as the app, held by the management feature),
2. the explicit effort and fast mode are checked against the provider the team has saved,
3. the copy of that project is reserved or reused, the launch gate refuses while the team runs or launches in another project, and a new copy is materialized from the definition,
4. the copy is launched by the same draft/launch code as an ordinary team: its first launch creates it, later launches reuse it with its tasks and chats,
5. readiness of the copy confirms the project context, and the run is remembered under the team, so `GET /api/teams/provisioning/:runId` (what `team_launch` polls) reports the team's name, not the copy's.

An ordinary team, or a draft of one, launches exactly as before.

What differs from a launch in the app, for every HTTP launch and not only for a per-project team: the app marks the launched team as watched (`markTeamEngaged`, live file updates in its window) and creates a draft inside the backup identity fence (`withTeamIdentityFence`); HTTP does neither. The project-context part (reservation, gate, copy, launch settings, run identity) is the same use case.

Refusals of the project context carry their reason in `code`, next to `error`.

| Answer | When |
| --- | --- |
| 200 with the run of the copy | launched; a copy that already runs in that project answers like a running ordinary team (`launchStatus`) |
| 400 | no `cwd`, `cwd` not an existing absolute folder, an invalid field or effort, `bootstrapOnly` in a project without a copy yet, or a `teamName` in the body (a per-project team cannot be renamed at launch) |
| 422 `RUNTIME_SELECTION_REQUIRED` | the team has no runtime chosen yet and the request names none |
| 409 `TEAM_PROJECT_CONTEXT_RUNNING` | the team runs, launches or has an unreconciled copy in another project |
| 409 | a first launch of the team in that project is still in progress (the native create refuses a second one) |
| 409 `TEAM_PROJECT_CONTEXT_REFUSED` | an invariant of the copy is broken (an unowned or nested copy, missing settings); the text says which |
| 409 `TEAM_PROJECT_CONTEXT_UNAVAILABLE` | the contexts index cannot be used (being trashed or deleted, damaged, too many projects) |
| 409 `TEAM_METADATA_UNREADABLE` | the team metadata cannot be read: the kind of the team is unknown, nothing is launched |
| 409 `PROJECT_COPY_NOT_LAUNCHABLE` | the name is a project copy (`ptc-` followed by 24 hex characters, refused by its shape even when its owner cannot be proven) |
| 409, `error` starting with `TEAM_TRASHED` | the team is in the trash (as for any team) |

Everything that can be checked without the copy is checked **before anything is reserved**: a reservation left behind by a refused request would block the team in every other project until it is launched in this one. The body is parsed by the same parser that launches the copy (as a draft when the project has no copy yet, else as a configured team), so no rule exists twice. A launch that fails after the copy was reserved (a provider or runtime error of the copy) leaves the copy reserved, like a failed launch in the app. A retry in the same project reuses it (the reserved row is read with `inspect`, as the reservation of the app does), so it completes there; until then the team is refused in the other projects.

### Not verified

- Real agent execution after an HTTP/MCP launch: the Electron E2E (`verifyHttpCreateAndLaunch` in `scripts/e2e/project-scoped-team-history-desktop.ts`) launches against a runtime that denies agents, so it proves the files, the index and the refusals, not a running team.
- The hosted web client was not driven; it uses the same routes.
- Known limit (as in the app): the team list folds a copy into its team only once the copy was ready. A copy whose first run in a project never got ready (refused or failed after it was reserved) stays visible as its own row until a launch in that project succeeds.
