# Packaged PR verification

The Electron packaged CI workflow keeps its five platform jobs and existing native,
runtime, architecture, SQLite/PTY, MCP, minimum macOS and application smoke checks.
Its existing path filter remains in place, with the policy scripts and dedicated
`tsconfig.packaged-ci.json` added for self-validation. This is not a repository-wide
packaging check, and release packaging is unchanged.

Each platform typechecks the policy and its tests with the project's pinned native
compiler after its existing frozen dependency install. The dedicated configuration
extends the root settings and includes only packaged CI scripts. Root configuration
and other workflows are unchanged.

For intermediate draft PRs already matching the existing trigger paths, ordinary
`src/**` and `test/**` changes qualify for `app` scope, including a window IPC change
accompanied by other source or test edits. This does not broaden workflow triggers:
a source-only PR without a matching existing trigger path still runs no packaged
workflow. Both macOS package commands add `--dir`, producing the `.app` without
DMG/ZIP creation. Windows and Linux still produce their normal packages.

Eligible regular files use `.ts`, `.tsx`, `.mts`, `.cts`, `.js`, `.jsx`, `.mjs`,
`.cjs`, `.css`, `.html` or `.svg`. Additions, modifications, deletions and renames
are allowed; both rename paths must qualify. Packaging inputs always use `full`:
participant avatars under `src/renderer/assets/participant-avatars/**`, the three
`src/shared/utils/{posthogBuildPolicy,sentryBuildPolicy,sentryArtifactInventory}.ts`
helpers, config/tooling names, and paths containing `config`, `resources` or `scripts`
directories. Files outside `src/**` and `test/**`, binary/unknown extensions and
mixed changes containing any excluded file also require `full`.
Protected file and directory comparisons ignore case; allowed roots and source
extensions remain case-sensitive.

The classifier reads one complete raw local merge-base diff of the event's verified
base/head commit SHAs with NUL-delimited filenames and full object IDs, not the
GitHub file-list API. Existing endpoints must be regular mode `100644` or `100755`;
only additions/deletions may have a missing endpoint. Copies, type changes,
symlinks, submodules, control/traversal paths, empty diffs and unavailable/malformed
evidence conservatively use `full`.

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

This change does not register `packaged full gate` as a repository-required
status check. The operator must require a successful packaged full gate and all
mandatory CI for the exact current PR head, plus independent technical review.
Existing branch protection and rulesets remain in force. A rerun retains its original event
payload; use a fresh ready-for-review/label event to change scope.

Lightweight policy checks (no app or agent launch):

```sh
node --test scripts/ci/packaged-ci-policy.test.mts
ELECTRON_BUILDER_DIST_DRY_RUN=1 node scripts/electron-builder/dist.mjs --mac --arm64 --publish never --dir
ELECTRON_BUILDER_DIST_DRY_RUN=1 node scripts/electron-builder/dist.mjs --mac --x64 --publish never --dir
node ./node_modules/@typescript/native/bin/tsc --noEmit -p tsconfig.packaged-ci.json
```

Any live canary must use a newly created sandbox/test repository or an explicitly
test-only existing repository. Do not run teams, provisioning, terminal runtime,
task assignment or agent actions on real user projects. Canary comparison should
cover a draft window-only update, mixed source/test edits, a config update, `ci:full`, ready for
review, a base edit and a title/body edit while a full run is active. Confirm the
last edit neither cancels the full run nor replaces its canonical checks.
Native canary results remain tied to their recorded product SHA. Policy updates
require focused classification proof and final CI on the current PR head.

## Teams CI metadata edits

The main `CI` workflow also preserves current-code checks after a proven PR
title/body-only edit, for ready and draft PRs. A previous null body is valid.
Strict proof requires the complete PR/repository/base/head identity, valid commit
SHAs, nonempty current/previous titles, and only `title`/`body` change records
containing `from`. Base changes, unknown fields and malformed/missing identity
require full qualification. The draft lifecycle contract is unchanged.

Authenticated postmerge reuse checks at most eight newest source runs. It may
cross only complete successful metadata runs whose exact skipped job set and
immutable source proof match the selected full run. The closest nonmetadata run
must satisfy every full-run requirement; failed, cancelled, pending, unknown or
incomplete evidence requires fresh CI. Final reads recheck the selected full run,
each crossed metadata attempt and the unchanged run listing. Metadata never
extends the source evidence expiry or creates full qualification by itself.

All `edited` events use a unique concurrency group without cancellation before
planning. Proven metadata runs skip dependency installation, tests, lint and
Windows execution, and use noncanonical check names. Potential metadata plan
failures also use noncanonical names and fail closed. Their informational result
never creates a successful `Full qualification`; a successful canonical full
run for the current PR head remains mandatory. Unknown/base edits still run
full CI. Verify title/body edits while a full run is pending and after it succeeds,
plus base/unknown edits, on a disposable test PR using `gh`.
