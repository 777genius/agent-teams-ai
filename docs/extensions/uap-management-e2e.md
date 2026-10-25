# UAP management desktop qualification

The focused lane is `.github/workflows/uap-management-desktop-e2e.yml`. It runs
`scripts/e2e/uap-management-desktop.ts` against the actual Electron application,
the vendored TypeScript SDK and the staged native Go executable. It uses the
existing `dev:mcp` entry point and raw CDP harness. It does not replace the
renderer, engine, runtime or installed inventory with fixtures.

## Artifact inputs

`vendor/uap/sdk/provenance.json` identifies the reviewed UAP source commit and
SDK archive digest. `resources/uap/runtime.json` must identify the same source
and engine version, with a matching native executable digest. The harness checks
both before opening the application and records them with the application Git
commit in its receipt. `UAP_E2E_REQUIRE_CLEAN=1` rejects tracked uncommitted edits.
Exploratory runs may leave that flag unset; their receipt explicitly records a
dirty checkout.

The CI lane checks out the exact UAP source pin, builds its engine, and imports
the existing `provision` helper from UAP's `scripts/run-native-client-matrix.py`.
That helper downloads the pinned real OpenCode binary and verifies the archive
digest without running npm scripts. The current reviewed native fixture is
OpenCode 1.18.34 on Linux x64. The app's existing runtime bootstrap provisions the
real orchestration runtime from `runtime.lock.json`; the existing terminal
bootstrap provisions the terminal runtime. Go is a build prerequisite, not a
requirement for installed app users.

## Run locally

Install the repository's frozen dependencies and provision its Electron binary
using the normal repository setup. Stage the native UAP binary from its reviewed
source pin:

```sh
node scripts/stage-uap-runtime.ts --source /absolute/path/to/pinned-uap-checkout
```

Set `UAP_E2E_OPENCODE` to the verified native OpenCode executable and
`CLAUDE_AGENT_TEAMS_ORCHESTRATOR_CLI_PATH` to the real runtime executable returned
by `node scripts/dev-with-runtime.mjs --print-runtime-path`. Then run:

```sh
UAP_E2E_REQUIRE_CLEAN=1 xvfb-run -a pnpm exec tsx scripts/e2e/uap-management-desktop.ts
```

An existing display may be used with `DISPLAY` instead of `xvfb-run`. The harness
prints its disposable fixture directory. `UAP_E2E_HOLD=1` opens the actual app and
retains the CDP connection details for manual inspection until SIGTERM or SIGINT.
It does not mark the scenario complete in this mode.

Set `TMPDIR` (and `TMP`/`TEMP` where relevant) to an isolated local temporary
directory outside synchronized workspaces before starting the run. Background
synchronization must not restore, remove or alter the native files whose ownership
and exact bytes the scenario is checking. Keep live logs there as well; copy the
completed evidence only after the owned processes exit. This isolates the test
environment without changing native publication or recovery assertions.

Every run uses a new HOME, native configuration directories, UAP state store,
Electron user-data directory and runtime caches. No provider authentication is
required. Only the fixture's own dev process group and detached MCP helper
paths are stopped during cleanup. Evidence remains available after cleanup.

## Scenario assertions

| Scenario                | Actual boundary and assertion                                                                                                                                        |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Empty installation      | Open Extensions and select the available native OpenCode target; the authoritative environment starts empty.                                                         |
| Source discovery        | Serve a disposable HTTPS Skill index with trusted test TLS and text/binary files; discover it through the UI.                                                        |
| Preview and keyboard    | Read acquired SKILL.md with metadata separated from Markdown; Escape returns to the same discovery dialog, and Tab navigates source fields.                          |
| Reviewed installation   | Select the exact candidate, inspect the Go plan, apply it and wait for the authoritative operation result.                                                           |
| Native visibility       | Compare installed text and binary bytes, then invoke actual `opencode debug skill` to discover the new Skill.                                                        |
| Narrow layout           | Render the managed panel at 760px and reject horizontal overflow; retain a screenshot.                                                                               |
| Desktop HTTP            | Observe the same installed environment; reject a foreign Origin and rebound Host; create/delete actual local files and deduplicate an accepted request through HTTP. |
| Copy to local           | Use the existing import dialog and file review, then the Go local mutation path; preserve binary content.                                                            |
| Targeted update         | Change the fixture publisher content, review the targeted update, and verify changed native bytes.                                                                   |
| Targeted removal        | Remove the managed Skill while preserving the independent local copy.                                                                                                |
| Local editing           | Use the existing editor and file review; verify saved metadata and unchanged binary assets.                                                                          |
| Delete and restart      | Delete the local copy, verify a durable private backup, stop the app and start it again using the same isolated state.                                               |
| Restart-visible restore | Find the existing restore point, review restoration, restore exact bytes and verify no pending operation remains.                                                    |
| Signed registry plugin  | Browse the current signed catalog, inspect the reviewed `cloudflare-docs` entry, install it for OpenCode and verify actual MCP configuration; then remove it.        |

The reviewed registry fixture is `cloudflare-docs` version `0.4.13-uap.1`, from the
active `777genius/cloudflare-docs-bridge` distribution. It contains a remote public
documentation MCP endpoint, no local command or scripts, and requires no provider
authentication. The harness refuses a different catalog version until the new
fixture has been reviewed. It does not send private inputs or claim model/OAuth
qualification.

## Reliable real input and result observation

The harness sends real CDP pointer/key events and `Input.insertText`. It checks
that a target is enabled, visible, stable and hit-testable, and that each filled
field has the exact requested value. Tab navigation additionally observes
`aria-selected` and its controlled visible panel. Only this idempotent navigation
may retry, at most three times inside its existing deadline; after selection is
observed, a later reset is a failure. Review/Apply submission is not repeated.

Before Apply or Import, the harness records the displayed operation ID. Completion
requires a different nonempty ID and the primary Completed status; a previous
installation's Completed text cannot satisfy the next operation. Native file and
binary-byte assertions then verify the actual effects.

Successful screenshots wait for finite animations to finish. Infinite activity
indicators remain active, and animations are neither disabled nor advanced.
Failure screenshots are immediate. The local edit assertion checks the requested
metadata in `SKILL.md` and the exact `assets/sample.bin` bytes. After an actual app
restart, restoration must reproduce that edited `SKILL.md` and the same binary
bytes. Focused planner tests separately cover omitted reference documents, nested
scripts, and existing custom text/binary README files. A preview that deletes
unrepresented files is a product failure, not a reason to relax assertions.

## Evidence and limitations

The disposable fixture contains `evidence.json`, screenshots and desktop logs.
The CI lane uploads those files plus native-client provenance. A completed
receipt requires all assertions and no unexpected renderer exceptions. An early
failure preserves its screenshot and error; an exploratory screenshot alone is
not a completed end-to-end result.

The local isolated state validates the shared-state behavior within that fixture.
Default external-CLI ownership interoperability is a separate actual CLI test.
The standalone HTTP viewer has no runtime owner and deliberately refuses mutation;
the HTTP scenario above exercises the desktop sidecar with its real owner.
Native project/worktree installation, the unmerged Host migration, other native
client platforms and authenticated model execution retain their separate
qualification gates. Local project Skill authoring does not establish native
project activation; the master scenario matrix records their evidence separately.

The current desktop journey does not exercise moving-range multi-selection,
real cancellation, an in-flight multi-project context switch, or a live
authenticated team run. Their separate engine/renderer/admission evidence must
be reported at its actual layer; passing this journey does not turn those cases
into desktop E2E results.

Unit regressions cover delayed observations during acceptance, active-profile
admission, lost-reply request identity, stale/local delete retries, native removal
attestation and catalog disposal. They complement the desktop lane and do not
replace native execution or UI evidence.

