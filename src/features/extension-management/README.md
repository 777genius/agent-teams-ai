# Extension management

This feature embeds the UAP management engine through the generated TypeScript
SDK. The Go engine owns source acquisition, dependency manifests and lockfiles,
prepared changes, native projections and durable operations. Agent Teams owns the
selected native profile, UI, lifecycle of its child process and admission against
active agent runs.

## Public entrypoints

| Entrypoint  | Consumers                                                 |
| ----------- | --------------------------------------------------------- |
| root        | Browser-safe HTTP client, independent of UI and app store |
| `contracts` | Browser-safe SDK-derived DTOs and the app API fragment    |
| `main`      | Electron composition, shared facade and HTTP registration |
| `preload`   | IPC bridge; no engine token or base URL leaves main       |
| `renderer`  | Managed Plugins/Skills panel and local ownership hook     |

The feature keeps its own state; the legacy Extensions Zustand slice and native
Claude marketplace identity are unchanged. Both plugin packages and standalone
Skills use the same environment lifecycle, while their UI remains in their
existing tabs. Local Skill authoring retains its separate review/editor workflow.

## Captured authority

The renderer sends a bounded client ID and scope, opaque context/plan/operation
IDs, and bounded source requests. Main resolves native executables and captures
profile roots from a passive environment; the selected client must belong to that
captured inventory. Agreement with the eventual member
launch environment remains a qualification goal: Codex launch can refresh its
selected account/runtime context and use a different root or binary. The
[launch-readiness proposal](../../../docs/extensions/team-extension-launch-readiness-options.md)
records this conditional gap and the options for discussion. Main does not
substitute the Claude orchestration executable for native Claude Code.

Each app context has an independent UUID. The UAP session's context ID is derived
by Go from validated roots and is preserved in all engine results. Navigation
does not retarget accepted work. Profile drift invalidates preparation and new
application; operation inspection remains available for the captured context.

Production omits UAP's state/dependency root overrides. Go resolves the canonical
CLI home (`AGENTPLUGINS_HOME` or the platform user configuration directory), so
the app shares the CLI's ownership state and mutation lock. All supported native
profiles are captured once per context. Installation has a separate multiselect:
available Claude Code, Codex and OpenCode targets start checked; additional
detected clients start unchecked. The selected view narrows inventory and
targeted removal. Updating the environment covers the shared manifest and can
affect multiple runtimes. The initial project control is disabled until the
separate UAP project/worktree workstream is qualified.

Additional targets come from the pinned Node SDK's `discoverTargets` operation,
which runs the Go engine's bounded `manage discover` command. Go owns the native
detection rules, user-scope support policy and private profile locators. The SDK
passes only permitted environment locators and bounds output, time and process
cleanup; it does not execute discovered clients or refresh authentication. Main
retains the established capture for the three team runtimes, canonicalizes
qualified additional profiles and passes them to Management startup. A display
label or reason without a qualified profile never grants installation authority.
Detected unsupported clients remain disabled with an explanation.

A safely inspectable profile remains captured when its client is no longer
detected. Go refuses new installation to that profile, while existing bindings
remain inspectable and removable. Empty undetected extra targets are hidden from
the selector; installed bindings and the current view remain visible. Changes to
detection or profile identity require a fresh context and review. Discovery adds
installation targets only: it does not add team runtimes or local authoring roots.

## Mutation and runtime admission

`ExtensionRuntimeGate` reserves the native profile before awaiting the active-run
check. Launch preparation holds the complementary read admission. The app wraps
team creation/relaunch, member attachment/restart, live roster mutation and lead
runtime restart at their existing API boundaries. Unknown saved runtime provider
information is treated conservatively. The legacy runtime snapshot does not
expose all original profile roots, so an already active client may conservatively
block another profile of that client until a stronger captured-runtime authority
is available.

The facade restores outstanding operations before it admits a new runtime after
app restart. A successful inspection of an old operation cannot clear the fence
for newer work: clearance uses the environment's outstanding-operation inventory.
An in-flight apply acceptance also holds the fence while an inspection races it.
An empty inventory cannot resolve an uncertain acceptance: the same request's
authoritative result is required, and retries preserve that request identity.

If the SDK confirms that its owned engine process has exited, the facade reconnects
once using the original captured authority. The logical context and shared mutation
fence survive. A replacement must match the captured session and pass a fresh
durable-environment inspection before it becomes usable. Failed inspection remains
fenced and retries on that same live child; an ordinary HTTP failure never causes a
live engine to restart. Old connection callbacks cannot publish into the replacement
generation. Unaccepted process-local reviews expire, while accepted/uncertain
request identities remain available for exact observation or retry. A sibling
context cannot release the shared fence while reconnection is still uninspected.

Local Skill create/edit/import/delete now delegate to retained Go plans under the
same canonical mutation lock. The old Node apply/trash fallback is removed.
Editor previews preserve exact old-file digests from the bytes shown in review;
the engine rechecks those digests and the directory snapshot at apply. Native
managed projections are read-only in local detail views. Unknown ownership also
disables editing, and a successful inventory read only informs the UI: Go alone
authorizes effects under its lock.

Project authoring roots resolve against the existing host project inventory;
arbitrary absolute renderer paths do not register projects. Project local drafts
remain separate from unsupported native project plugin activation. Admission keys
include the actual local Skill roots and the affected native profile roots.

Copy-to-local discovers exact Skill directories inside captured managed inventory,
skips symlink escapes and bounds traversal. Multi-Skill packages require an exact
candidate. The shared import dialog accepts feature preview/apply callbacks, so
desktop HTTP uses the same retained Go plan without exposing the entire legacy
Skills filesystem API. Source bytes, file limits, binary files and destination
hashes follow the existing import inspection. An unavailable materialized source
has an explicit reason; the renderer never invents a native path.

## Transport

Electron IPC requires the owned window and its main frame. The desktop HTTP
sidecar uses the same facade and validates actual loopback peer, exact local Host,
same-origin Origin, JSON Content-Type and bounded request size for every new
endpoint. It does not inherit authority from the legacy server's permissive CORS
configuration. The existing standalone viewer advertises an unavailable
management capability with a desktop-app action, and refuses mutation calls.
It has no runtime owner and is not converted into an agent host by this feature.

## Review and operations

The Go plan is opaque. The UI displays its affected aliases/targets, version
changes, warnings, conflicts and expiry, and applies its handle with a retained
request UUID. A lost reply does not mint a replacement identity. Accepted,
running, succeeded, partial, failed, canceled and interrupted states remain
distinct. Cancellation is an explicit engine request, not a polling abort.

Source Skill discovery retains a catalog handle in Go. The preview button reads
the candidate's actual `SKILL.md` through that handle and uses the existing
Markdown viewer. A catalog plugin is resolved again by the trusted host so its
canonical signed Directory source identity reaches Go unchanged.

## Artifact identity

`vendor/uap/sdk/provenance.json` identifies the exact source commit and digest of
the vendored SDK tarball. `resolveUapExecutable` only accepts a staged native
executable with matching platform and checksum in `resources/uap/runtime.json`.
Packaging must build native UAP from the same reviewed source commit as the SDK.
The desktop development bootstrap also stages that exact pin when it is missing
(Git and Go are development prerequisites). Packaged installations use the bundled
executable; there is no implicit latest lookup, public release or source build in
the installed app.

The source stager selects the exact toolchain declared in that pinned UAP
`go.work`; an ambient newer Go installation cannot silently change the compiler.
The packaged CI matrix provisions Go explicitly on every runner. Refresh the SDK
tarball, provenance and native source pin together, then run the packaged matrix.

Provenance also records the verified ancestor release and the embedded engine
version, for example `0.1.91+agentteams.<source-prefix>`. The signed registry uses
the real installer version for compatibility; the source default
`0.1.0-development` cannot represent this later release baseline. Staging validates
the version against the pinned baseline tag and source, records it in runtime.json,
and invalidates older cached builds. Neither build nor startup queries a latest
release. A new baseline must be checked against its immutable upstream release tag.

Signing changes executable bytes. The macOS signing hook preserves the existing
signer options and bounded retry policy, refreshes the helper digest after nested
signing and before the outer app seal, then verifies without writing. Windows
refreshes after the builder's signed resource copy. `afterSign` only verifies the
final source/platform/checksum. A checksum is never silently updated at app startup.

## Verification

Focused tests live in `test/features/extension-management/` and exercise
concurrency admission, exact HTTP request admission, stale profiles, source
identity, idempotent host retry, durable recovery and owned-process cleanup.

The complete acceptance matrix and honest separation between implemented,
verified and dependency-blocked scenarios are in
[`docs/extensions/uap-management-integration-plan.md`](../../../docs/extensions/uap-management-integration-plan.md).
Real Electron tests must use actual SDK, Go, native files and isolated profiles;
these unit tests do not substitute for that qualification.

The Electron harness also exposes one controlled Cursor executable to passive
detection. Before changing installation selections, it checks the real
Go/SDK/host session and UI: the three available team clients are checked and the
extra detected target is unchecked. The executable writes a persistent witness
if run; the harness checks its absence and unchanged executable bytes after the
initial UI observation and again after owned desktop shutdown, including failed
runs. This qualifies the detection/selection boundary only, not Cursor native
execution, installation or Skill use.
