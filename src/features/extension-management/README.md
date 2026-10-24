# Extension management

This feature embeds the UAP management engine through the generated TypeScript
SDK. The Go engine owns source acquisition, dependency manifests and lockfiles,
prepared changes, native projections and durable operations. Agent Teams owns the
selected native profile, UI, lifecycle of its child process and admission against
active agent runs.

## Public entrypoints

| Entrypoint  | Consumers                                                 |
| ----------- | --------------------------------------------------------- |
| `contracts` | Browser-safe SDK-derived DTOs and the app API fragment    |
| `main`      | Electron composition, shared facade and HTTP registration |
| `preload`   | IPC bridge; no engine token or base URL leaves main       |
| `renderer`  | Managed Plugins/Skills panel and the HTTP client          |

The feature keeps its own state; the legacy Extensions Zustand slice and native
Claude marketplace identity are unchanged. Both plugin packages and standalone
Skills use the same environment lifecycle, while their UI remains in their
existing tabs. Local Skill authoring retains its separate review/editor workflow.

## Captured authority

The renderer sends a supported client and scope, opaque context/plan/operation
IDs, and bounded source requests. Main resolves the native executable and current
profile from the same resolvers and account environment as agent launch. It does
not substitute the Claude orchestration executable for native Claude Code.

Each app context has an independent UUID. The UAP session's context ID is derived
by Go from validated roots and is preserved in all engine results. Navigation
does not retarget accepted work. Profile drift invalidates preparation and new
application; operation inspection remains available for the captured context.

Production omits UAP's state/dependency root overrides. Go resolves the canonical
CLI home (`AGENTPLUGINS_HOME` or the platform user configuration directory), so
the app shares the CLI's ownership state and mutation lock. All supported native
profiles are captured once; the UI's selected runtime narrows installation and
removal targets. Updating the environment covers the shared manifest and can
affect multiple runtimes. The initial project control is disabled until the
separate UAP project/worktree workstream is qualified.

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

## Verification

Focused tests live in `test/features/extension-management/` and exercise
concurrency admission, exact HTTP request admission, stale profiles, source
identity, idempotent host retry, durable recovery and owned-process cleanup.

The complete acceptance matrix and honest separation between implemented,
verified and dependency-blocked scenarios are in
[`docs/extensions/uap-management-integration-plan.md`](../../../docs/extensions/uap-management-integration-plan.md).
Real Electron tests must use actual SDK, Go, native files and isolated profiles;
these unit tests do not substitute for that qualification.
