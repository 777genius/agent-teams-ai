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

Title/body-only PR edits after full qualification retain the existing authenticated same-head/base evidence. The edit run still reports `Full qualification` for the head, and it passes only when that earlier full qualification is re-authenticated. A title/body edit without reusable full evidence, for example after a focused qualification, classifies the unchanged diff again and runs the same scoped checks as a push would. Label changes are classified the same way. Base changes and unknown edits run full CI. Legal texts and issue templates under `.github/` run full CI, so their wording is never reformatted to pass the focused check. Scoped evidence reuse is intentionally not introduced. Postmerge reuse still requires complete full-tier evidence; a focused pass cannot qualify unrelated code or a different tree.

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
content. All these workflows cancel obsolete runs for the same PR only;
main, scheduled and manually dispatched runs remain independent.

Use **Actions → the relevant workflow → Run workflow** for an early smoke or
packaging check while drafting. Manual runs and scheduled security scans still
run regardless of draft state. Keep `ci:full` for forcing full change scope on a
ready PR; it does not turn a draft into a merge-qualified PR. Do not use
`[skip ci]`: it suppresses the workflow that reports the required merge check.
There is no line-count-based bypass for small changes to runtime or shared code.
