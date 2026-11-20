# Per-project teams at HTTP and MCP boundaries

A team of the per-project history mode is three kinds of names (see [per-project-team-editing.md](./per-project-team-editing.md)): the **logical** team the user sees (no process of its own), its **project copies** (`ptc-<hex>`, native teams) and ordinary **native** teams. Entry points that take a team name literally (HTTP, the MCP controller, directory views) must first say which kind they got. That is `resolveTeamTarget` in `src/features/team-project-context/main/resolveTeamTarget.ts`.

```
resolveTeamTarget(ports, name)
  -> { kind: 'native', team }
   | { kind: 'logical', logical, contexts }          // every owned project context
   | { kind: 'alias', alias, logical, context }      // one project copy
```

It fails closed. Unreadable team metadata, an ambiguous alias or contexts whose ownership cannot be proven reject with `TeamTargetUnresolvedError` (HTTP 409, code `TEAM_TARGET_UNRESOLVED`). An unknown team is never treated as an ordinary one.

## What a logical team means for each consumer

| Consumer | Logical team | Project copy | Native team |
| --- | --- | --- | --- |
| `POST /api/teams/:team/stop` | stops every owned context with the same escalated flow as the in-app Stop, then checks that none is alive; 409 naming the project if one still runs | exact stop of that copy (unchanged) | unchanged |
| `POST /api/teams/:team/force-stop` | force-stops every context; answers `{ teamName, complete, contexts[] }` | exact (unchanged) | unchanged |
| `GET /api/teams/:team/runtime` | aggregated state plus `contexts[]` | exact (unchanged) | unchanged |
| `GET /api/teams/runtime/alive` | one added entry per logical team with a live context | physical entry stays | unchanged |
| `GET /api/teams` and MCP `team_list` | one row with its contexts, copies folded away (same as the in-app list) | not listed | unchanged |
| Organization map | one candidate; tasks of all contexts; online if any context is | not a candidate | unchanged |

## Contract for MCP and HTTP clients

All changes are additive except the list, which no longer returns the folded copies (listing them as extra teams with the same display name was the defect).

- `runtime` of a logical team keeps `{ teamName, isAlive, runId, progress }` and adds `contexts[]`: `{ executionTeamName, projectPath, state, isAlive, runId, progress }`. `isAlive` is true when any context is; `runId` and `progress` are those of the live context, else of one that is provisioning. `team_stop`'s wait loop (which polls `runtime`) therefore waits for the real state.
- `runtime/alive` keeps every physical entry and adds a logical entry (with the live `contexts[]`) per logical team. A project copy that cannot be tied to its logical team stays in the list with `projectContextUnresolved: true`.
- `stop` of a logical team answers 409 with the project path and copy name of every context that did not stop. The stop of the others still runs: one failure does not abandon the rest.
- `force-stop` of a logical team always answers with what the cleanup did; `complete` says whether every context is down.
- A copy stays addressable by its exact name for stop, force-stop and runtime. Edits of a copy are refused elsewhere (see the editing page).

## What stays out of this change

- The cross-team `from` attribute (`team.member`) and every `teamName: "..."` in an agent prompt are routing identities and keep the physical name; only labels that are purely cosmetic could show the display name, and the member prompts already print both (`team "<display>" (<physical>)`).
- Schedules, the lead prompt, MCP/HTTP update and trash, launch-settings drift, cross-team delivery, live edit and hosted web are separate gaps (see the parity matrix).

## Stop semantics and concurrency

- A pending (`reserved`) context may already host a process. It is only stopped after its owner marker is verified, like the in-app stop; if that fails nothing is stopped and the request answers 409.
- The stop takes no logical-team lock (the in-app stop does not either): holding it for the whole escalation budget would block launches. Instead the result is verified afterwards, so a launch that raced in is reported as a context that is still running, never as a success.
