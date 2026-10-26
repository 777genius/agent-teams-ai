# UAP management desktop qualification

The focused lane is `.github/workflows/uap-management-desktop-e2e.yml`. It runs
`scripts/e2e/uap-management-desktop.ts` against the actual Electron application,
the vendored TypeScript SDK and the staged native Go executable. It uses the
existing `dev:mcp` entry point and raw CDP harness. It does not replace the
renderer, engine, runtime or installed inventory with fixtures.

The workflow runs in the pull-request trust context. It has no privileged
manual-dispatch entry point; existing runs can be rerun through GitHub. Its job
sets `cache-mode: none` and verifies the runner's effective `ACTIONS_CACHE_MODE`
in the first, full-SHA-pinned official JavaScript action, before either project
checkout. The runner injects this variable into action handlers rather than
ordinary shell steps. This is required because the exact
cross-repository source pin still executes code. Read-only repository permission
and a disabled dependency-cache configuration alone do not revoke cache tokens.

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
digest without running npm scripts. The current reviewed native fixtures are
OpenCode 1.18.34 and Claude 2.1.263 on Linux x64. The app's existing runtime bootstrap provisions the
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

Set `UAP_E2E_OPENCODE` and `UAP_E2E_CLAUDE` to the verified native executables and
`CLAUDE_AGENT_TEAMS_ORCHESTRATOR_CLI_PATH` to the real runtime executable returned
by `node scripts/dev-with-runtime.mjs --print-runtime-path`. Then run:

```sh
UAP_E2E_REQUIRE_CLEAN=1 xvfb-run -a pnpm exec tsx scripts/e2e/uap-management-desktop.ts
```

The fixture adds both verified native binary directories to its isolated PATH.
This keeps ordinary native discovery available after the dev launcher removes
the ambient `CLAUDE_CLI_PATH` override.

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
| Claude copy source      | Install a real Claude managed Skill and query the ordinary preload source selector; require the exact inventoried `.agentplugins-runtime/skills` candidate.          |
| Targeted update         | Change the fixture publisher content, review the targeted update, and verify changed native bytes.                                                                   |
| Targeted removal        | Remove the managed Skill while preserving the independent local copy.                                                                                                |
| Local editing           | Use the existing editor and file review; verify saved metadata and unchanged binary assets.                                                                          |
| Delete and restart      | Delete the local copy, verify a durable private backup, stop the app and start it again using the same isolated state.                                               |
| Restart-visible restore | Distinguish both same-name save/delete points by visible action and recorded time after restart, select the exact deletion operation, confirm the same Go-selected point and restore exact bytes. |
| Signed registry plugin  | Browse the current signed catalog, inspect the reviewed `cloudflare-docs` entry, install it for OpenCode and verify actual MCP configuration; then remove it.        |
| Actual native tool call | Review the specific safe SEC302 warning reason, install a SHA-256-pinned source plugin through the ordinary UI, run real OpenCode with a controlled provider, and verify MCP initialization, discovery, one exact tool call and its returned nonce. |
| Native tool removal     | Remove that plugin through the UI, start a fresh OpenCode session, and verify no advertised tool and no MCP connection. |
| Active profile admission | Create a real idle Anthropic lead/worker team through the ordinary app API; verify current run, live member PIDs, owned CWD and exact runtime executable. Reject five retained Apply requests, fresh Prepare and a real UI action for its Claude extension profile. |
| Unaffected client       | Keep that team alive through the OpenCode plugin installation, actual MCP invocation and removal sequence above; verify its native member identities are still live afterward. |
| Stop and mutate         | Stop through the ordinary team API, wait for the observed OS process identities to exit, then perform a fresh Claude update and verify changed Skill bytes and preserved binary content. |

The reviewed registry fixture is `cloudflare-docs` version `0.4.13-uap.1`, from the
active `777genius/cloudflare-docs-bridge` distribution. It contains a remote public
documentation MCP endpoint, no local command or scripts, and requires no provider
authentication. The harness refuses a different catalog version until the new
fixture has been reviewed. It does not send private inputs or claim model/OAuth
qualification.

The active-profile scenario imports only the existing model HTTP fixture; it does
not replace provisioning, liveness, native processes or extension admission.
Five unexpired reviews are prepared before launch so Apply must recheck activity.
The fixture records the actions and target identities: install, update, repair,
locked sync and removal all concern Claude. Healthy locked sync has an
`unchanged` action and qualifies request refusal, not a restore write. The
test compares actual manifest, lock, installer state and native inventories,
and checks absence of each refused request in the real accepted ledger. An
actual accepted installation provides the positive control for that ledger path.
A visible UI error must explain that the active run needs to stop.

The loopback model returns idle responses; no model/OAuth account is used.
This qualifies the application's active-profile mutation boundary with real
team processes. It does not demonstrate that every member discovered or loaded
an installed Skill body, or that a plugin MCP call occurred in those team members.
The `claudeNative` record identifies the independently verified supplied native
artifact; Management's public target inventory does not expose its selected
executable. The separately recorded live team executable is the pinned
orchestration runtime, verified through the actual member OS processes.

The separate native-tool fixture uses the existing disposable HTTPS publisher
and a loopback MCP server. Only its model provider settings are seeded before
installation; UAP owns every MCP configuration write. The provider returns a
deterministic OpenAI-compatible tool request, and the actual OpenCode binary must
dispatch it and return the exact tool result in its next provider request. The
owned noninteractive native process receives stdin EOF before the harness awaits
it: pinned OpenCode reads piped input even with a prompt argument. Its timeout is
unchanged, and failure logs retain an error even when stdout/stderr are empty. The
receipt records native identity, offered tools, protocol methods, arguments and
both installed/removed stages; native stdout/stderr are retained as logs. This
requires no model account and does not qualify live model behavior or OAuth.

## Reliable real input and result observation

All renderer observations use one fixed checked-in CDP function. Selectors,
labels, operation IDs and timestamps travel as `Runtime.callFunctionOn`
argument values. The only evaluated expression is the literal `globalThis`,
used to acquire the owned renderer handle; runtime data is never concatenated
into JavaScript source. Polling callbacks and comparisons run in Node. Remote
handles are released on success and failure without replacing a primary error
with a secondary cleanup failure.

The harness sends real CDP pointer/key events and `Input.insertText`. It checks
that a target is enabled, visible, stable and hit-testable, and that each filled
field has the exact requested value. It waits out finite animations on the target
and its ancestors and dispatches using the successful readiness observation,
without a second readiness read that could race a dialog transition. Tab
navigation additionally observes `aria-selected` and its controlled visible
panel. Runtime selection acknowledges `aria-expanded` on the exact trigger,
finds an option only in that trigger's `aria-controls` listbox, and requires the
exact selected value. These idempotent navigation helpers allow at most three
attempts inside their original 60-second deadline. Runtime selection retries
only a missing opening acknowledgement, waiting at most three seconds for each
acknowledgement; after opening is observed, a missing option or failed selection
fails the run. An observed tab selection followed by a reset also fails the run.
Review/Apply and other mutation submissions are not repeated.

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

Restore selection uses the exact operation IDs and recorded timestamps returned
by Go, with both Before save and Before deletion labels visibly checked after
restart. Confirmation must contain the same selected point from the retained
plan; list position is not identity. The receipt preserves both points and the
selection, and screenshots retain the expanded list and confirmation. The source
plugin review must display the trusted SEC302 insecure-HTTP reason before Apply;
scanner-controlled raw messages or paths are not needed for this assertion.

## Evidence and limitations

The disposable fixture contains `evidence.json`, screenshots and desktop logs,
plus `active-profile-evidence.json` and the isolated model-request log.
The CI lane uploads those files plus native-client provenance. A completed
receipt requires all assertions and no unexpected renderer exceptions. An early
failure preserves its screenshot and error; an exploratory screenshot alone is
not a completed end-to-end result.

The local isolated state validates the shared-state behavior within that fixture.
Default external-CLI ownership interoperability is a separate actual CLI test.
The standalone HTTP viewer has no runtime owner and deliberately refuses mutation;
the HTTP scenario above exercises the desktop sidecar with its real owner.
The harness obtains a separate sidecar capability through the owned Electron IPC,
refuses missing/forged credentials even with valid local headers, and proves that
the old capability is rejected after the actual application restart. It never
records the grant or the private Go credential in receipts or screenshots.
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

## Agent selection and lifecycle coverage

The current panel offers Claude Code, Codex and OpenCode in a single-select
view/context control, initially Claude Code. Installation, removal and local
copy currently bind to that selected context. It does not preselect all three
installation destinations and does not discover additional native agents.
The separate signed UAP Directory supplies Universal plugins; global runtime
catalog badges do not determine UAP availability.

The owner proposed default selection of the three supported agents. Go already
accepts multiple captured target IDs. A minimal future UI change needs a
separate installation-destination checkbox group, preserving the current view,
removal and copy context. Only available captured targets should be selected;
unavailable ones should retain their reason. The explicit selection must be
frozen into the reviewed plan and preserved during attestation/reprepare.
Adding other detected agents also needs trusted host discovery, profile capture
and activity admission; adding labels alone would not establish that support.
These selection changes are not part of the CodeQL correction.

| Client | Existing desktop journey | Separate native UAP CLI matrix |
| --- | --- | --- |
| Claude Code | Local Skill copy, edit, delete and restart-visible restore under the captured Claude root; no native Claude plugin lifecycle. | Actual pinned client install/update/remove qualification on macOS arm64 and Windows x64. |
| Codex | Native plugin install/update/remove is not exercised by this desktop journey. | Actual pinned client install/update/remove qualification on macOS arm64 and Windows x64. |
| OpenCode | Plugin install and removal with actual MCP invocation/absence; standalone Skill install, changed-content update and removal. Plugin update is not exercised through the desktop. | Actual pinned client install/update/remove qualification on macOS arm64 and Windows x64. |

The CLI matrix and desktop journey cross different boundaries. Each receipt
must name its actual source and completed assertions; neither is evidence for
the missing desktop cases. Native fixtures use a scripted local provider,
without live-model or OAuth qualification. New source pins require fresh runs.

