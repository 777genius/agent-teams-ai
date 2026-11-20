# Per-project teams at HTTP and MCP boundaries

A team of the per-project history mode is three kinds of names (see [per-project-team-editing.md](./per-project-team-editing.md)): the **logical** team the user sees (no process of its own), its **project copies** (`ptc-<hex>`, native teams) and ordinary **native** teams. Entry points that take a team name literally (HTTP, the MCP controller, directory views) must first say which kind they got. That is `resolveTeamTarget` in `src/features/team-project-context/main/resolveTeamTarget.ts`.

```
resolveTeamTarget(ports, name)
  -> { kind: 'logical', logical, contexts }                    // per_project mode: every owned project context
   | { kind: 'native', team, retained, projectContextUnresolved? }
```

The kind follows the team's **history mode**, never whether it happens to own a contexts index:

- `per_project` → `logical`. The name has no process; its runtime is its contexts.
- anything else → `native`. The name is the process. A shared team that kept a project-contexts index from an earlier per-project period lists those contexts in `retained`, because they may still run. For such a team a stop, a runtime read and the alive list cover **both** its own process and the retained contexts (`contextGroupOf` returns `ownRuntime: true`).
- A project copy (`ptc-…`) is an ordinary native team. Every route keeps addressing it by its exact name, so the resolver does not scan the teams directory to classify it.

It fails closed where being wrong is silent:

- contexts whose ownership cannot be proven reject with `TeamTargetUnresolvedError` (HTTP 409, code `TEAM_TARGET_UNRESOLVED`);
- unreadable team metadata rejects the same way **when the team owns a contexts index** (it may be a per-project team);
- unreadable metadata of a team **without** a contexts index keeps the old exact-name behaviour and is flagged with `projectContextUnresolved: true` in the answer, so a damaged ordinary team can still be stopped.

This closes gaps 2 and 3 of the [parity matrix](./per-project-parity-matrix.md) (the two that returned a wrong result without an error).

## What each consumer does

| Consumer | Logical team | Shared team with retained contexts | Project copy / native team |
| --- | --- | --- | --- |
| `POST /api/teams/:team/stop` | stops every owned context with the same escalated flow as the in-app Stop, then verifies each is confirmed stopped; 409 naming the project if one still runs | stops the retained contexts, then its own process, and verifies all of them | exact stop (unchanged) |
| `POST /api/teams/:team/force-stop` | force-stops every context; answers `{ teamName, complete, contexts[] }` | same, with the own process listed as a context with `projectPath: null` | exact (unchanged) |
| `GET /api/teams/:team/runtime` | aggregated state plus `contexts[]` | own state folded with its contexts | exact (unchanged) |
| `GET /api/teams/runtime/alive` | one added entry per logical team with a live context | its entry absorbs the live contexts (listed once) | physical entry stays |
| `GET /api/teams` and MCP `team_list` | one row with its contexts, copies folded away (same as the in-app list) | unchanged | copies of a folded team are not listed |
| Organization map | one candidate; tasks of all contexts, each marked with the copy that owns it | unchanged | not a candidate |

## Contract for MCP and HTTP clients

Everything is additive except the list. **The list change is not additive**: the project copies of a per-project team are no longer returned as extra teams (listing them next to the logical team with the same display name was the defect). A client that addressed a copy through the list must take the copy names from `projectHistoryContexts` of the logical row.

- `runtime` of a team that owns contexts keeps `{ teamName, isAlive, runId, progress }` and adds `contexts[]`: `{ executionTeamName, projectPath, state, isAlive, runId, progress }`. `isAlive` is true when the own process or any context is; `runId` and `progress` are those of the live one, else of one that is **still provisioning**, else of one that keeps a settled progress. `team_stop`'s wait loop (which polls `runtime`) therefore waits for the real state.
- `runtime/alive` keeps every physical entry. A project copy that cannot be tied to its logical team stays in the list with `projectContextUnresolved: true`. All copies are proven with one scan of the teams directory.
- `stop` of a team with contexts answers 409 when something did not come down. The body is `{ error, code: 'LOGICAL_STOP_INCOMPLETE', outcome }`; `outcome.contexts[]` has one entry per context (and the own process) with `executionTeamName`, `projectPath` (`null` for the own process), `error?`, `stillAlive`, `appearedDuringStop?`. The stop of the others still runs: one failure does not abandon the rest.
- `force-stop` of a team with contexts always answers 200 with what the cleanup did; `complete: false` (and `verificationError` when the contexts could not be re-read) says something is not down. A client must read `complete`, it is not an error status.
- A copy stays addressable by its exact name for stop, force-stop and runtime. Edits of a copy are refused elsewhere (see the editing page).

### MCP timeouts

`team_stop` posts the stop and then polls `runtime`. The server may spend up to 120 s per team escalating a stop that does not confirm, and stops the copies of a logical team one after another, so the controller now allows the stop request 5 minutes (it used to inherit the 10 s default and aborted a stop that was still working).

## Verification after a stop

A stop only counts when each context is **confirmed stopped**: not alive, no run id, and no progress other than `failed`/`cancelled` (the same `isConfirmedStoppedTeamRuntime` the launch gate uses; a stale `ready` or `disconnected` is not proof). After all contexts were asked to stop, the contexts are listed again, so a copy that appeared while stopping is verified too and reported as `appearedDuringStop` rather than missed.

- A pending (`reserved`) context may already host a process. It is only stopped after its owner marker is verified, like the in-app stop; if that fails nothing is stopped and the request answers 409.
- The stop takes no logical-team lock (the in-app stop does not either): holding it for the whole escalation budget would block launches. Instead the result is verified afterwards, so a launch that raced in is reported as a context that is still running, never as a success.

## Known limits

- The organization map shows a team **online** from its ready contexts that are alive; a reserved copy that is still provisioning is not counted as online there (the runtime routes do report its progress).
- Task actions in the organization inspector run against the project copy that owns the task, which the node's tasks carry as `executionTeamName`. A stored organization node that points at a `ptc-…` name (instead of the logical team) now reads as "team not found", because copies are folded away.
- The kanban state of a copy is not loaded for the node, so the inspector shows the task card without its review state.

## What stays out of this change

- The cross-team `from` attribute (`team.member`) and every `teamName: "..."` in an agent prompt are routing identities and keep the physical name; only labels that are purely cosmetic could show the display name, and the member prompts already print both (`team "<display>" (<physical>)`).
- Schedules, the lead prompt, MCP/HTTP update and trash, launch-settings drift, cross-team delivery, live edit and hosted web are separate gaps (see the [parity matrix](./per-project-parity-matrix.md)).
