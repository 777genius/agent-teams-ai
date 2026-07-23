# Change Review

This is a thin renderer feature extracted incrementally from the legacy
`ChangeReviewDialog` shell.

- `renderer/view-models` owns pure presentation projections.
- `renderer/utils` owns pure scope and operation-generation policies.
- `renderer/hooks` owns scope projection and lifecycle orchestration through narrow ports.
- `renderer/ui` owns store-free presentation components.
- The legacy dialog temporarily retains Zustand, IPC, editor, mutation, persistence,
  and close-flush orchestration while later slices move those responsibilities behind
  focused hooks and use cases.

Production callers import through `@features/change-review/renderer`.
