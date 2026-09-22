# Organizations Feature

Full feature slice for organization-level team visibility.

## Scope

- Builds a compact organization graph from teams, agents, active task summaries, and cross-team outbox messages.
- Supports a configurable organization tree with arbitrary `container` nesting and `team` references.
- Renders the org map as a separate tab by adapting organization DTOs into
  `@claude-teams/agent-graph`'s `GraphDataPort`.
- Renders runtime cross-team communication as an overlay graph. Hierarchy does not restrict which teams can communicate.
- Keeps drill-down in the existing team and team graph screens.

## Architecture

- `contracts` owns DTOs, route/channel constants, and transport normalization.
- `core/domain` owns pure policies: configured/default org graph building, agent/task projection, cross-team relation aggregation, and cycle detection helpers.
- `core/application` owns the `GetOrganizationMapUseCase` and source ports.
- `main` adapts JSON organization structure, `TeamDataService`, and `CrossTeamService` into compact domain candidates.
- `preload` exposes the Electron bridge.
- `renderer` owns view models, hooks, and presentational UI.

## Editing Model

- Organization editing is metadata-only. It never creates, launches, deletes, or provisions teams.
- The editor writes `organizations/map.json` through command use cases such as `assignTeamToUnit`,
  `moveOrganizationUnit`, and `upsertOrganizationRelation`.
- `CreateTeamDialog` can optionally place a team after successful creation, but placement is a
  separate post-create organization command and is not part of `TeamCreateRequest`.
  Placement failure is reported as a warning and does not roll back team creation.
- Organization Map keeps an active organization selection so multi-organization structures can be
  viewed and edited one organization at a time.
- Drag/drop in the renderer moves containers and team references through the existing
  `moveOrganizationUnit` command.

## Organization Structure Storage

The main-process repository reads an optional JSON file at:

```text
<appData>/data/organizations/map.json
```

Minimal shape:

```json
{
  "schemaVersion": 1,
  "organizations": [{ "id": "default", "name": "My Organization", "rootUnitId": "root" }],
  "units": [
    { "id": "root", "kind": "organization", "label": "My Organization" },
    { "id": "engineering", "parentId": "root", "kind": "container", "label": "Engineering" },
    {
      "id": "platform-slot",
      "parentId": "engineering",
      "kind": "team",
      "label": "Platform",
      "teamName": "platform"
    }
  ],
  "relations": [
    { "sourceTeamName": "platform", "targetTeamName": "growth", "kind": "depends_on" }
  ]
}
```

`kind` is structural only: `organization`, `container`, or `team`. Product roles such as lead,
orchestrator, department, pod, or guild belong in `label`, `title`, or `tags`, not as hard-coded
domain enums.

## Performance Boundaries

- The map uses `listTeams`, capped `getAllTasks`, `listAliveProcessTeams`, and cross-team outboxes.
- It does not read member logs, task log streams, transcript bodies, or full `TeamViewSnapshot` for every team.
- Container/team subtrees can be collapsed in the renderer. Cross-team edges are rerouted to the nearest visible ancestor.
- Renderer animation reuses `GraphView`'s single RAF loop, frustum culling, adaptive particle budget, and zoom/pan controls.
