# Change Review

This is a thin renderer feature extracted incrementally from the legacy
`ChangeReviewDialog` shell.

- `renderer/view-models` owns pure presentation projections.
- `renderer/ui` owns store-free presentation components.
- The legacy dialog temporarily retains Zustand, IPC, editor, and lifecycle
  orchestration while later slices move those responsibilities behind focused
  hooks and use cases.

Production callers import through `@features/change-review/renderer`.
