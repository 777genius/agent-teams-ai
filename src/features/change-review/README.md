# Change Review

This feature is extracted incrementally from the legacy renderer dialog and
main-process review IPC shell.

- `renderer/view-models` owns pure presentation projections.
- `renderer/utils` owns pure scope and operation-generation policies.
- `renderer/adapters` owns narrow Zustand/API bridges and the dialog's shared
  CodeMirror, mutation-status, session, and write-evidence view bridges.
- `renderer/hooks` owns scope/lifecycle, draft history, conflict recovery, action-history,
  decision-persistence, keyboard orchestration, bulk Accept/Reject, manual file draft
  save/reload/discard flows, file-level and hunk-level Accept/Reject/Restore, and durable
  Undo/Redo/checkpoint Restore. It also owns dialog open/fetch/hydration, close/app-close
  flushing, saved-state recovery/discard, Apply cleanup, and Escape orchestration through
  narrow command, state, editor, status, history, session, and write-evidence ports.
- `renderer/ui` owns store-free presentation components.
- `core/domain` owns pure review scope, rename expectation, snippet-shape, watcher-input, and
  decision-persistence policy.
- `main/application` owns authoritative scope/path authorization, review watcher lifecycle, and
  decision-persistence coordination behind narrow ports.
- `main/infrastructure` owns Node path, filesystem, sensitive-path, hardlink, and watcher-root
  validation details.
- The legacy dialog remains the temporary composition shell for Zustand subscription,
  editor-ref ownership, and UI interaction wiring while later slices move those
  responsibilities behind focused hooks and use cases.

Production callers import through `@features/change-review/renderer` or
`@features/change-review/main`.
