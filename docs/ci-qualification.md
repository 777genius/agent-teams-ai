# CI qualification by change scope

`Full qualification` is the single required merge check. It validates the jobs selected by an immutable local Git diff; a skipped or failed selected job cannot qualify. Unknown paths, ambiguous events, renames, unsupported file modes, and mixed areas fall back to full CI. The `ci:full` label forces full qualification.

| Scope           | Allowed changes                                                                                                                | Required checks                                                                                                                     |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| Documentation   | Markdown under `docs/`; root README, CHANGELOG, CONTRIBUTING, AGENTS, CLAUDE, AGENT_CRITICAL_GUARDRAILS; `.github` PR template | Changed text formatting and scope-policy tests                                                                                      |
| Assets          | Raster images under `docs/` or `landing/assets/`, optionally documentation                                                     | Asset signature/size checks and scope-policy tests                                                                                  |
| DMG artwork     | Raster images under `resources/dmg/`, or only validated display fields in `package.json` `build.dmg`, optionally documentation | Asset/configuration validation plus macOS fixture DMG build, mount, background hash, Finder icon coordinates, and Applications link |
| Renderer source | Added/modified TSX UI primitives directly under `src/renderer/components/ui/`, optionally documentation                        | Workspace typecheck, renderer/features lint, architecture guards, and all root test shards                                          |
| Full            | Runtime, IPC, shared code, dependencies, signing, packaging logic, workflows, other source, or unrecognized changes            | Existing full qualification and applicable platform packaging checks                                                                |

Source narrowing is intentionally limited to UI primitives. Root tests remain broad because cross-feature usage makes filename-only test selection unsafe. Extend the allowlist only with corresponding impact evidence and policy regression tests.

DMG artwork uses a disposable app bundle and never launches the application or an agent runtime. It verifies the installer layout with the pinned electron-builder implementation. Platform packaging still runs for dependency or packaging logic changes.

Title/body-only PR edits retain the authenticated CI run for the same head, base and synthetic merge instead of repeating it. The edit run skips the heavy jobs but still reports `Full qualification` for the head. On a ready PR that check passes only after the same-input run has completed full qualification and that result is re-authenticated. If the edit arrives while that run is still queued or running, which is the usual case for bot-written descriptions, the check waits for it (at most 90 minutes, polling only the run status) and then verifies it. It fails when the awaited run fails, is cancelled without a newer same-input run, the PR head or target branch moves, or the deadline passes. It never passes or skips early. A title/body edit without reusable full evidence, for example after a focused qualification, a failed or cancelled run, or while a scoped run is still running, classifies the unchanged diff again and runs the same scoped checks as a push would. Label changes are classified the same way. Base changes and unknown edits run full CI. Legal texts and issue templates under `.github/` run full CI, so their wording is never reformatted to pass the focused check. Scoped evidence reuse is intentionally not introduced. Postmerge reuse still requires complete full-tier evidence; a focused pass cannot qualify unrelated code or a different tree.

| PR event (same head)                                    | Edit run does                                                  | `Full qualification` of the edit run      |
| ------------------------------------------------------- | -------------------------------------------------------------- | ----------------------------------------- |
| Title/body edit, same-input full run completed green    | Plan only                                                      | Passes after re-authenticating that run   |
| Title/body edit, same-input full run queued or running  | Plan only                                                      | Waits, then passes or fails with that run |
| Title/body edit, latest same-input run failed/cancelled | Classifies the diff and runs its checks                        | Result of its own checks                  |
| Title/body edit, scoped diff, scoped run not reusable   | Runs the scoped checks again                                   | Result of its own checks                  |
| Title/body edit on a draft                              | Plan only                                                      | Fails, as for every draft                 |
| Base change or unknown edit                             | Full CI                                                        | Result of its own checks                  |
| Proof cannot be completed (API, identity, ambiguity)    | Classifies the diff and runs its checks (plan) or fails (gate) | Never passes without complete evidence    |

## Small intermediate commits

Keep an in-progress PR as a **Draft**. Main CI already runs fast feedback
(typecheck, fast lint and architecture guards); draft feedback cannot qualify
`Full qualification` for merge. Mark the PR **Ready for review** when it
is ready to run full or scope-selected qualification.

CodeQL, Codex runtime installation, public runtime bootstrap, OpenCode desktop
and packaged E2E, and Anthropic-compatible packaged E2E defer automatic PR jobs
while the PR is draft. `ready_for_review` runs them for the current diff when
their path filters match. Converting back to draft cancels superseded PR runs.
Announcement validation continues on drafts because it validates publishable
content. All these workflows follow [run supersession](#run-supersession):
a newer revision of the same PR cancels its obsolete runs, while main,
scheduled and manually dispatched runs remain independent.

Use **Actions → the relevant workflow → Run workflow** for an early smoke or
packaging check while drafting. Manual runs and scheduled security scans still
run regardless of draft state. Keep `ci:full` for forcing full change scope on a
ready PR; it does not turn a draft into a merge-qualified PR. Do not use
`[skip ci]`: it suppresses the workflow that reports the required merge check.
There is no line-count-based bypass for small changes to runtime or shared code.

## Run supersession

Workflow concurrency decides which runs a newer run may cancel. Automatic check
workflows use one canonical expression, defined in
`test/workflows/runSupersession.mts`. `test/workflows/runSupersession.test.ts`
evaluates the concurrency of every workflow for simulated events and fails for a
workflow that has no assigned policy.

| Event                                                   | Group identity                | Cancels older runs in the group                                               |
| ------------------------------------------------------- | ----------------------------- | ----------------------------------------------------------------------------- |
| `pull_request`                                          | Workflow, event and PR number | Yes: a newer run for the same PR stops its queued and running checks          |
| `push` to another branch (not default, not `release/*`) | Workflow, event and ref       | Yes: older runs of the same branch                                            |
| `push` to the default branch, `release/*` or a tag      | Workflow, event and run ID    | No: every commit keeps its own evidence, such as the announcement range check |
| `schedule`, `workflow_dispatch`                         | Workflow, event and run ID    | No: manual runs never cancel each other                                       |
| `merge_group`                                           | Workflow, event and queue ref | No                                                                            |

PR groups use the PR number rather than the head branch, so fork PRs and a fork
branch named `main` cannot share a group with pushes. Including the event name
keeps a PR number, branch name and run ID from colliding.

Explicit variants:

- `CI` appends an edit suffix: each `edited` run gets its own group and never
  cancels code checks, as before. Later edits do not cancel edit runs either:
  the metadata and postmerge proofs never cross a cancelled run on the same
  head, so a later edit or the post-merge main run would repeat full CI.
  Title/body edit runs stay cheap instead (see above).
- `Electron packaged CI` runs only for PRs and isolates only title/body edits;
  a base change runs its code checks and supersedes older ones.
- Landing deployment keeps one cancelling group per ref, so a newer push or
  dispatch cancels an older deployment that is still queued or running. A
  manual re-run of an older run deploys its original commit, so do not re-run
  superseded deployments.
- Release, signing and draft recovery workflows queue per release tag, ref,
  release ID or fixed operation group and never cancel running work. GitHub
  keeps at most one pending run per group, so a third queued operation replaces
  the pending second one.
- ReviewRouter, the manual-only Mac updater workflows and reusable workflows
  declare no workflow-level group. A called workflow sees the caller's `github`
  context, so the same expression there would join the caller's group and cancel
  or block the caller.

Cancellation never passes the required check. `Full qualification` keeps its
static name and runs only `if: always() && !cancelled()`: a cancelled run reports
it as cancelled, never skipped or successful, and the PR waits for a newer run.
Job-level `always()` conditions in cancellable workflows must include
`!cancelled()`, so a cancelled run does not start further jobs.
