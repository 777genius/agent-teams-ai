# Packaged PR verification

The Electron packaged CI workflow keeps its five platform jobs and existing native,
runtime, architecture, SQLite/PTY, MCP, minimum macOS and application smoke checks.
Its existing path filter remains in place, with the policy scripts and canonical
TypeScript configuration added for self-validation. This is not a repository-wide
packaging check, and release packaging is unchanged.

For intermediate draft PRs, only modifications (`M`) to
`src/main/ipc/window.ts` qualify for `app` scope. Both macOS package commands add
`--dir`, producing the `.app` without DMG/ZIP creation. Windows and Linux still
produce their normal packages. Other files, mixed changes, additions, deletions,
renames, unknown paths, empty diffs and unavailable/malformed evidence use `full`.
The classifier reads the complete local merge-base diff of the event's verified
base/head commit SHAs with NUL-delimited filenames, not the GitHub file-list API.

To obtain final packaging evidence, mark the PR ready for review or add `ci:full`.
Both trigger `full` scope, including macOS DMG/ZIP generation. Reopening, pushing,
and label changes also re-evaluate the policy. Base-branch edits require `full`.
Title/body-only edits use unique concurrency groups and noncanonical job names;
they do not cancel or replace the current code checks.

`packaged full gate` runs after the matrix even when a dependency fails or is
skipped. It succeeds only when classification succeeded, the scope is `full`, and
all five platform jobs succeeded. An `app` run deliberately leaves this gate red,
even if all smoke jobs pass. Forks retain the existing restriction on packaged
jobs, so their skipped matrix cannot satisfy the full gate.

The repository is currently unprotected. A check alone does not enforce merging:
the operator must require a successful full gate and mandatory CI for the exact
current PR head, plus independent technical review. This change does not create
or alter branch protection or rulesets. A rerun retains its original event
payload; use a fresh ready-for-review/label event to change scope.

Lightweight policy checks (no app or agent launch):

```sh
node --test scripts/ci/packaged-ci-policy.test.mts
ELECTRON_BUILDER_DIST_DRY_RUN=1 node scripts/electron-builder/dist.mjs --mac --arm64 --publish never --dir
ELECTRON_BUILDER_DIST_DRY_RUN=1 node scripts/electron-builder/dist.mjs --mac --x64 --publish never --dir
pnpm typecheck
```

Any live canary must use a newly created sandbox/test repository or an explicitly
test-only existing repository. Do not run teams, provisioning, terminal runtime,
task assignment or agent actions on real user projects. Canary comparison should
cover a draft window-only update, a mixed/config update, `ci:full`, ready for
review, a base edit and a title/body edit while a full run is active. Confirm the
last edit neither cancels the full run nor replaces its canonical checks.
