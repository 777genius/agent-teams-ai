# Task detail review corrections

These corrections complete the existing task detail tab design in
[`plans/task-detail-tabs.md`](plans/task-detail-tabs.md).

- Task attachment upload, paste, drop and deletion consult the live session
  mutation gate. FileReader continuations recheck it before saving. Preview and
  download remain available when a task becomes read only.
- Duration clocks use the existing visible-surface demand. Hidden mounted
  task views stop both intervals, while visible split panes keep updating.
- Activity, thoughts, replies and comments carry the explicit target team and
  distinguish canonical task IDs from legacy display references. Canonical IDs
  cannot resolve through another task's display ID. Team navigation captures and
  checks its originating context and epoch.
- Markdown previews inherit task origin from the existing task detail context.
  Explicit structured targets take precedence; unscoped or retired-context
  tooltips cannot borrow a task from the globally selected team. Reused compact
  previews update their origin when the owning team changes.
- Task link query values are decoded once by `URLSearchParams`; path IDs retain
  their separate URI decoding.
- Task detail tabs are excluded from ordinary team provisioning demand through
  the shared ordinary-team-tab predicate.

Small existing presentation and navigation responsibilities were extracted
to keep the frozen source-size limits. The three affected legacy caps were
lowered after extraction.

## Verification

The corrective candidate passed `pnpm typecheck` and 310 focused tests across
12 existing or directly affected suites. They cover the readonly FileReader
race, hidden clocks, team/reference identity, retired origins and existing
session/dialog behavior. The compact-preview origin regression was reproduced
before its fix. `pnpm guard:source-file-size` and touched-file fast lint pass.

The desktop harness adds real mounted upload/paste/drop/delete attempts after
deletion and compares persisted task and asset bytes. Final Electron evidence,
independent review and exact-head CI results are recorded with the pull request.
