# Team task detail

This feature owns task-detail identity, accepted full-task reads, shared sessions,
and detail presentation. Renderer adapters use the existing application store;
the feature does not introduce a separate state or transport owner.

## Public renderer entrypoints

| Import | Intended use |
| --- | --- |
| `@features/team-task-detail/renderer` | Complete detail components, hooks and shared API, including `TaskDetailTab` and `TaskDetailContent`. |
| `@features/team-task-detail/renderer/shell` | Eager application-shell coordination and link context, without importing the complete detail UI. |

The shell entrypoint explicitly exports five existing values:

- `TaskDetailReadCoordinator`
- `TaskDetailEditorRouteFeedback`
- `TaskDetailReviewRouteFeedback`
- `useTaskDetailTabLabel`
- `useTaskDetailFileLink`

The full renderer entrypoint keeps its existing exports. Both entrypoints use
the same original modules; in particular, `useTaskDetailFileLink` reads the
context created by the existing `TaskDetailFileLinkProvider`.

## Loading boundary

`TabbedLayout`, `SortableTab`, `FileLink`, and `useResolvedViewerTeamContext`
consume the shell entrypoint. The complete task tab still loads through
`PaneContent`'s existing lazy import. `GlobalTaskDetailDialogSlot` keeps its
existing lazy dialog and preload-on-user-intent behavior.

Both ESLint configurations permit the exact shell public entrypoint and retain
the prohibition on its internal paths. Use the public import above instead of
importing the feature's adapters, hooks, or context directly from application code.
The [feature architecture standard](../../../docs/FEATURE_ARCHITECTURE_STANDARD.md)
continues to define the general layer rules.

## Verification

`taskDetailLoadBoundary.test.ts` checks source import/re-export reachability from
the real renderer entrypoint: the coordinator and context stay eager, while the
complete detail UI and editor remain reachable through the existing on-demand
routes. This is a source-boundary regression, not a browser resource measurement.
Existing detail-session, dialog, lazy-slot, Markdown context, and file-link tests
cover the corresponding UI behavior.
