# Team Lifecycle

Owns browser-safe lifecycle reads, roster adoption, and renderer orchestration for
team lifecycle mutations.

## Renderer mutation boundary

The public `renderer/` entrypoint exposes the soft-delete, restore, and permanent
delete action slice. The slice owns mutation ordering through narrow transport,
cleanup, state, analytics, refresh, and clock ports.

Concrete desktop transport remains in the app store composition root. Code under
this feature must not import the renderer API or Electron facets directly because
the hosted lifecycle read surface shares the same feature boundary.

Cleanup starts only after the mutation transport succeeds. Soft delete alone
records delete analytics and clears task-board analytics. Refresh remains
sequential: teams first, then global tasks.
