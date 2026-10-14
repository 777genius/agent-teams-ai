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

## Bounded follow-up scope

This follow-up starts from source checkpoint
`706a42311f737057caf382b7d2d821149647d8b1`. Its critical regression contract is
in `test/features/team-task-detail/renderer/taskDetailSession.integration.test.tsx`:
the two deferred late success/failure cases must both retire the same-team
pending submit while the independent team submit and draft remain untouched.
Existing retirement policy tests are in
`test/features/team-task-detail/core/taskDetailCriticalPolicies.test.ts`, and the
existing team reset coverage is in `test/renderer/store/teamSlice.test.ts`.
`test/renderer/components/team/dialogs/TaskCommentInput.test.tsx` remains the
existing input behavior suite; the lightbox counter correction intentionally has
no separate count test.

Focused verification commands are:

```sh
pnpm exec vitest run test/features/team-task-detail/renderer/taskDetailSession.integration.test.tsx test/features/team-task-detail/core/taskDetailCriticalPolicies.test.ts test/renderer/store/teamSlice.test.ts test/renderer/components/team/dialogs/TaskCommentInput.test.tsx
pnpm typecheck
node scripts/ci/check-source-file-size.mjs
```

The Linux synthetic native harness must run from a clean integrated checkout.
Supply its exact final integrated 40-character SHA as the sole positional
argument; the harness also requires that same SHA from `git rev-parse HEAD` and
rejects a dirty worktree. The exact environment and argument shape are:

```sh
DISPLAY=<isolated-xvfb-display> \
TASK_TABS_E2E_SCRATCH=/srv/workers/<owned-scratch> \
TASK_TABS_E2E_PNPM=<pinned-pnpm-js-entrypoint> \
node scripts/e2e/task-detail-tabs-desktop.ts <exact-integrated-40-character-sha>
```

`TASK_TABS_E2E_PNPM` is optional when the hosted runner has the pinned pnpm
entrypoint on its normal command path. The harness uses a synthetic fixture and
denies non-version runtime calls; it is not a real-team or provider-launch test.

## Current V17 corrective scope

The V19 MiMo source packet targets the four confirmed defects from checkpoint
`c95f45028d8164de770168b9a6abf7383454f5eb`: legacy Markdown links retain their
paired cross-team target; successful deletion/restoration sets an identity-scoped
intent before refresh; context switches preserve locally preparing draft files;
and team resets make old detail data unavailable without dropping the draft.
FileReader completion uses the captured session identity and its still-registered
preparation ID. Backend reads, submits and saves retain their origin/epoch guards.

The worker's sandbox lost its linked-worktree Git index after writing eight
files. The primary integrated the immutable packet, completed lifecycle wiring in
the existing mutation/read-authority helper and team slice, and retained the
existing fresh group-chat gate instead of the packet's redundant callback.
Late team-delete/restore acknowledgements are also fenced from clearing another
context's current task and pending draft. The focused test below reproduces that
failure when those guards are absent. Task-log help uses the shared Radix Tooltip.

The additional current regression command is:

```sh
pnpm exec vitest run test/renderer/utils/taskReferenceUtils.test.ts test/renderer/store/taskDetailOriginAndLoading.test.ts test/features/team-task-detail/renderer/taskDetailSession.integration.test.tsx
```

The integrated corrective candidate passed 372 focused tests across 15 suites,
`pnpm typecheck`, touched-file fast lint and the unchanged source-size guard.
Two additional deferred team-context cases were reproduced failing without the
late-acknowledgement guards, then passed with the guards restored.

The original critical assertions remain; literal link expectations are independent
of the production href builder. Current native E2E, independent review and the
required exact-head CI must still verify the integrated source. Restoring native
dependencies and loading SQLite/node-pty proves the Electron ABI only.

## Previous V15 verification (historical only)

The previous V15 corrective candidate passed `pnpm typecheck` and 310 focused tests across
12 existing or directly affected suites. They cover the readonly FileReader
race, hidden clocks, team/reference identity, retired origins and existing
session/dialog behavior. The compact-preview origin regression was reproduced
before its fix. `pnpm guard:source-file-size` and touched-file fast lint passed.

That historical desktop run added real mounted upload/paste/drop/delete attempts
after deletion and compared persisted task and asset bytes. Those results do not
prove this bounded follow-up; current final Electron evidence, independent
review and exact integrated-head CI results belong to this follow-up's hosted
handoff.
