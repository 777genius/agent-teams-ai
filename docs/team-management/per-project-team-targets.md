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

`contextGroupOf` turns a target into the group a route works on: the team's name plus its contexts (a logical team, or a native team with retained contexts). For every group the team's **own name is read and, when it has a live process, stopped too**, like the in-app Stop does: a shared team always runs under its name, and a logical team should not have a process but is reported and stopped if it somehow has one. An idle own name is left alone.

It fails closed where being wrong is silent:

- contexts whose ownership cannot be proven reject with `TeamTargetUnresolvedError` (HTTP 409, code `TEAM_TARGET_UNRESOLVED`);
- unreadable team metadata rejects the same way **when the team owns a contexts index** (it may be a per-project team);
- unreadable metadata of a team **without** a contexts index keeps the old exact-name behaviour and is flagged with `projectContextUnresolved: true` in the answer, so a damaged ordinary team can still be stopped.

This closes gaps 2 and 3 of the [parity matrix](./per-project-parity-matrix.md) (the two that returned a wrong result without an error).

## What each consumer does

| Consumer | Team with contexts (logical, or shared with retained contexts) | Project copy / native team |
| --- | --- | --- |
| `POST /api/teams/:team/stop` | stops every owned context and the own process when it is live, with the same escalated flow as the in-app Stop, then verifies each is down; 409 naming the project if one still runs | exact stop (unchanged) |
| `POST /api/teams/:team/force-stop` | the same with the force-stop flow; answers `{ teamName, complete, contexts[] }`, the own process is listed with `projectPath: null` | exact (unchanged) |
| `GET /api/teams/:team/runtime` | aggregated state (own process and contexts) plus `contexts[]` | exact (unchanged) |
| `GET /api/teams/runtime/alive` | one added entry per logical team with a live context; a live shared team absorbs its contexts into its own entry | physical entry stays |
| `GET /api/teams` and MCP `team_list` | one row with its contexts, copies folded away (same as the in-app list) | copies of a folded team are not listed |
| Organization map | one candidate; tasks of all contexts, each marked with the copy that owns it | not a candidate |

## Contract for MCP and HTTP clients

Everything is additive except the list. **The list change is not additive**: the project copies of a per-project team are no longer returned as extra teams (listing them next to the logical team with the same display name was the defect). A client that addressed a copy through the list must take the copy names from `projectHistoryContexts` of the logical row.

- `runtime` of a team that owns contexts keeps `{ teamName, isAlive, runId, progress }` and adds `contexts[]`: `{ executionTeamName, projectPath, state, isAlive, runId, progress }`. `isAlive` is true when the own process or any context is; `runId` and `progress` are those of the live one, else of one that is **still provisioning**, else of one that keeps a settled progress. `team_stop`'s wait loop (which polls `runtime`) therefore waits for the real state.
- `runtime/alive` keeps every physical entry. A project copy that cannot be tied to its logical team stays in the list with `projectContextUnresolved: true`. All copies are proven with one scan of the teams directory.
- `stop` of a team with contexts answers 409 when something did not come down. The body is `{ error, code: 'LOGICAL_STOP_INCOMPLETE', outcome }`; `outcome.contexts[]` has one entry per context (and the own process) with `executionTeamName`, `projectPath` (`null` for the own process), `error?`, `stillAlive`, `appearedDuringStop?`. The stop of the others still runs: one failure does not abandon the rest. The refusal is also logged.
- `force-stop` of a team with contexts answers 200 with what the cleanup did. `complete` is true only when every context verified as down **and** no confirmed stop left its cleanup incomplete (`cleanupOutcome`) **and** no recorded runtime host survived; `verificationError` appears when the contexts could not be re-read. A client must read `complete`, it is not an error status. After a regular stop that failed, the flow always reports its cleanup as incomplete, so there the verification of the runtime decides.
- A second `stop` or `force-stop` of the same team that arrives while the first is still running **joins it** (same answer, no second stop of the copies). That is what makes a client retry after a timeout safe.
- A copy stays addressable by its exact name for stop, force-stop and runtime. Edits of a copy are refused elsewhere (see the editing page).

### MCP

- `team_stop` accepts a per-project team: its MCP guard (`assertConfiguredOrDraftTeam`) accepts a configured team, a draft, or a `team.meta.json` of the per-project mode, because a logical team has no `config.json`. Anything else is still refused as an unknown team before any call. (`team_launch` uses the same guard; for a logical team it now reaches the API and gets its honest 409 that launching needs the desktop project-context API.)
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

A context that does not read as down is re-read a bounded number of times (8 reads, 500 ms apart) before the stop is reported incomplete, because a run id can be cleared a moment after the stop call returns. Recorded runtime hosts that are still alive also keep a context from reading as down.

After all contexts were asked to stop, the contexts are listed again. A copy that appeared meanwhile is reported as `appearedDuringStop`. A `reserved` one always makes the stop incomplete: its run is not registered yet, so it reads as down while a launch is under way. A ready one must verify as down.

- A pending (`reserved`) context may already host a process. It is only stopped after its owner marker is verified, like the in-app stop; if that fails nothing is stopped and the request answers 409.
- The stop takes no logical-team lock (the in-app stop does not either): holding it for the whole escalation budget would block launches. The verification is therefore a check of the state at that moment, not a guarantee: a launch that starts after it is outside the contract.

## Known limits

- The organization map shows a team **online** from its ready contexts that are alive; a reserved copy that is still provisioning is not counted as online there (the runtime routes do report its progress).
- Task actions in the organization inspector run against the project copy that owns the task, which the node's tasks carry as `executionTeamName`; cards are bound to that owner, so repeated task ids in two copies do not cross. A stored organization node that points at a `ptc-…` name (instead of the logical team) now reads as "team not found", because copies are folded away.
- The kanban state of a copy is not loaded for the node, so the inspector shows the task card without its review state.

## What stays out of this change

- The cross-team `from` attribute (`team.member`) and every `teamName: "..."` in an agent prompt are routing identities and keep the physical name; only labels that are purely cosmetic could show the display name, and the member prompts already print both (`team "<display>" (<physical>)`).
- Schedules, the lead prompt, MCP/HTTP update and trash, launch-settings drift, cross-team delivery, live edit and hosted web are separate gaps (see the [parity matrix](./per-project-parity-matrix.md)).
