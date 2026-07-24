# Change Review

This feature is extracted incrementally from the legacy renderer dialog and
main-process review IPC shell.

- `renderer/view-models` owns pure presentation projections.
- `renderer/utils` owns pure scope and operation-generation policies.
- `renderer/hooks` owns scope/lifecycle, draft history, conflict recovery, action-history,
  decision-persistence, keyboard orchestration, bulk Accept/Reject, manual file draft
  save/reload/discard flows, file-level Accept/Reject/Restore, and durable
  Undo/Redo/checkpoint Restore through narrow command, state, editor, status, and
  write-evidence ports.
- `renderer/ui` owns store-free presentation components.
- `core/domain` owns pure review scope, rename expectation, snippet-shape, watcher-input, and
  decision-persistence policy.
- `main/application` owns authoritative scope/path authorization, review watcher lifecycle, and
  decision-persistence coordination behind narrow ports.
- `main/infrastructure` owns Node path, filesystem, sensitive-path, hardlink, and watcher-root
  validation details.
- The legacy dialog remains the temporary composition shell for Zustand, editor mutations,
  hunk-level decision mutations, and outer close coordination while later slices move those
  responsibilities behind focused hooks and use cases.

Production callers import through `@features/change-review/renderer` or
`@features/change-review/main`.
