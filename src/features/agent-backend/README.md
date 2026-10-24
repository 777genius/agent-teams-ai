# Agent backend: captured Desktop connection

`main/index.ts` exposes the captured Node child client and its trusted profile.
Create the client before awaiting `start()` so app shutdown can seal pending startup.
`shutdown()` observes only that captured child; confirmed child exit makes no claim
about provider children or durable obligations. There is no automatic restart,
fallback, cancellation, or request replay.

`contracts/index.ts` contains browser-safe failure classifications. Native profile
paths, hashes, credentials, and the RPC client remain main-owned. Notifications are
bounded and pulled with an explicit gap indicator; consumers must rehydrate on gap.

Team policy, provider sessions and durable technical custody belong to the portable
Host, not this feature. The feature supplies captured routing, finite operations,
safe activity projections and the Desktop connection; full existing UI workflow
cutover remains in progress.

The main-owned `BackendOwnerRouter` is the retained-handle routing prerequisite for
P5. Register captured clients with explicit owner revision and storage root, select
a default, then `createHandle(handleId, scope)` before dispatch. The caller supplies
the handle ID and command IDs; the router neither generates command IDs nor retries
effects. `request(handle, command)` and `lookup(handle, commandId, lookupMethod)`
use the original durable owner, including new commands after a default switch.
Switching default or rolling it back affects only new unbound handles. Missing,
corrupt, mismatched, offline or sealed owners produce HOLD/unavailable, never fallback.

`HandleBindingStore` stores immutable routing metadata only. The supplied
`FileHandleBindingStore` uses the existing atomic no-clobber/fsync utility, with
bounded reads and private records. It is independent of the existing command
ledger. Construct the router with the selected store; call `registerOwner`,
`setDefault` and `startOwner` from trusted main composition. Public contracts expose
only `BackendHandle.handleId`; roots, artifact digests and scope binding stay main-owned.

`shutdownOwner` and `shutdown` seal routing synchronously, then dispose the captured
clients, including pending startup. A request waiting on a binding read cannot
bypass that fence. This provides transport shutdown, not scoped Team/runtime cleanup:
later lifecycle composition must retain control callbacks during bounded cleanup
before final client disposal. Routing does not grant authority; the receiving host
still validates current actor/grants and its resource/recovery fences.

`BackendOperationsFacade` supplies a finite app-facing conversation over the router:
Task mutations/reads, message send, original command lookup, and the captured
member Runtime operations. Renderer inputs carry an opaque handle, a caller-supplied
stable command ID and validated operation payload. They cannot supply RPC method
names, backend owners, roots, generations, provider config or native session IDs.
Read calls use the supplied ID for the existing wire envelope and create no receipt.

`registerAgentBackendIpc` and `registerAgentBackendHttp` expose the same validated
facade over `agentBackend:invoke` and `POST /api/agent-backend/operations`. Both require
a shell-supplied authorization callback using captured IPC sender or trusted server-owned
HTTP context, then defer current business/runtime grants to the host. Raw errors and
private host receipt/config fields are projected out of responses. The initial
Task DTO covers the exposed operations; this is not yet the complete review/
attachment UI contract. Runtime activity snapshot/feed use opaque cursors, explicit
gaps and bounded normalized text/tool/result/usage/interaction projections.

Public `preload/index.ts` exports `createAgentBackendBridge(ipcRenderer)` for the
`electronAPI.agentBackend` namespace. Public `renderer/index.ts` exports
`createAgentBackendHttpClient(post, get)` using the app's existing HTTP methods
for the same `AgentBackendApi`. Neither adapter creates IDs, retries requests,
selects a backend or translates transport loss into rejection. The HTTP adapter
uses the app's existing transport policy and has no renderer dependency on IPC.
`AgentBackendElectronApi` is the shared app API fragment for both implementations.

The app installs both clients in its unified API. The Electron shell registers
finite input handlers and discovery against trusted main composition. It captures
only the main window's exact main frame/renderer URL and current service context;
handle existence alone is not authorization. Production HTTP startup now captures
the original feature and service context once. A shell/context replacement holds
that server's routes until the server is restarted; request bodies cannot retarget
it. Standalone startup uses the same descriptor-backed feature with its fixed local
context and app-owned binding directory. This retains the existing local/trusted-
network server model and does not add public-server authentication.

Review watch notifications use a separate captured-server SSE endpoint,
`GET /api/agent-backend/review/events`, with at most 32 streams and 64 retained
watch IDs per server. They never enter the unrelated global `/api/events` feed.
The browser client uses the same server for watch POST, exact cleanup, and events;
the bound review adapter filters original handle/watch IDs. Server stop disposes
watchers and streams. No raw public backend configuration or automatic legacy
routing is exposed.

Bound review watch and Git requests forward their original Task/member scope.
The Host resolves the immutable actor and captured workspaces from original evidence,
Runtime input, outbox and launch records; the caller's project path is only a hint.
Scoped paths must belong to the reviewed evidence. Missing scope keeps the legacy
main-workspace-only behavior. Main partitions watchers by Host-authorized roots and
reauthorizes scoped notifications before delivery, coalescing in-flight checks per
file while preserving original subscription/context and HTTP resync guards.

This bootstrap exposes the existing finite backend operations and review routes.
The browser shell's separate Create/config, provisioning/preflight, and import
hooks remain explicitly unavailable; their dialogs are not claimed as complete
HTTP workflows.

Trusted launch configuration selects `AGENT_TEAMS_BACKEND_DESCRIPTOR_PATH` and
`AGENT_TEAMS_BACKEND_DESCRIPTOR_SHA256`; partial/invalid selection holds instead of
falling back. Without selection discovery is safely unconfigured. The descriptor
and immutable bindings remain main-owned in isolated app userData. Accepted Quit
seals this feature synchronously before awaited service cleanup begins.
Connection handlers are registered after the local context exists and before the
first awaited legacy initialization step. A slow or unavailable legacy runtime
registry cannot prevent discovery or the new captured backend's operations.

`DesktopBackendFeature` is the real main composition for a trusted private descriptor.
Pass `{descriptor: {path, sha256} | null, bindingDirectory}`; the selected private JSON
is bounded to 256 KiB, read from a canonical no-follow file descriptor and checked
against SHA256. The descriptor contains captured owner/profile data and stable
handle/context/scope definitions. `initialize()` durably publishes immutable handle
bindings before discovery. It starts no host; the existing captured client starts
lazily on an admitted finite operation. Null selection returns safe empty state.

`listBindings(contextId)` exposes only opaque handles, labels and member IDs for the
trusted current context. `authorizeHandle(contextId, handle)` is the per-context
gate for the existing finite operation handler. Its `ready` snapshot state means
descriptor/handle availability, not native session readiness. `shutdown()` seals
pending initialization and captured routing before awaiting any child cleanup.

`registerBackendConnectionsIpc/Http` supplies finite no-argument discovery using
the shell's captured context callback; it rechecks context after initialization to
reject navigation/context-change races. Both deny context supplied by a client.
The existing `createAgentBackendBridge` and `createAgentBackendHttpClient(post, get)`
also expose `getConnections()` in the same `AgentBackendApi` namespace. The client
never supplies a context selector; the main shell captures that context.

For mutable shell contexts, operation authorization returns a main-owned
`BackendRequestGuard` with `isCurrent()` instead of a one-time boolean. The finite
adapters carry it through lazy host startup and durable binding reads. The router
checks it immediately before the synchronous wire send and after the response;
the facade checks it again before public projection. A stale pre-send context
returns forbidden/not-dispatched; a stale context after dispatch hides the response
and returns forbidden/UNKNOWN because effects may already exist. Guards are never
serialized into host payloads. Legacy boolean callbacks remain supported for
callers whose captured authorization cannot change while awaiting a request.

The ordinary renderer `api.teams` now decorates sidebar discovery, team/roster/task
board reads, message pages and global tasks with finite `team.snapshot` reads.
Reserved opaque selection keys retain the original captured handle; equal legacy
names stay separate. Snapshot reads use current fenced Team authority and persisted
roster/tasks/kanban/inboxes, with inbox visibility restricted by the captured grant.
Product snapshots contain no native/process/session state. Separate captured Launch/Runtime
reads supply `isAlive`, `processAlive`, `aliveList` and the ordinary Team Stop control.
Member reads run sequentially within bounded Host control capacity; unavailable members
stay unknown while healthy members remain visible. Stop captures the full original roster's
application generations before effects, continues after individual refusals, and never
retargets replacements or invokes a legacy stop. A product-only profile returns authorized
null Launch metadata, preserving offline Task UI without invented runtime presence.
Native process lists/session provenance and other runtime widgets remain pending.
Request-shaped Team destinations (`launchTeam`, create/config/member settings) and
notification click targets also recognize the reserved Host namespace. Unsupported
operations refuse before legacy dispatch; ordinary legacy requests keep their bridge
receiver and argument identity. This is a routing fence, not positive launch/settings
parity. [Scoped native regression and negative routing probes](../../../docs/plans/provider-migration/evidence/p5-host-request-routing-handoff.json)
retain exact outcomes, the initial harness import failure and all remaining scope.
Structured, encoded and markdown task refs stay owner-qualified;
unbound cross-team targets fail explicitly instead of entering legacy routing.

The same decorator maps simple task create/update/non-null assignment/status/
delete/restore/comment and basic text sends to existing finite commands. Simple
CreateTaskDialog defaults (empty arrays and an unowned Task's `startImmediately:true/false`)
are supported: the existing product semantics have no immediate-start target without
an owner. Assigned immediate-start is still an explicit unsupported capability.
Its command ID is retained when the legacy idempotency key equals that ID; a distinct
key, nonempty prompt/related options, assigned immediate-start, attachments and
other unsupported request metadata fail before dispatch. Normal Composer text sends
preserve their prepared message ID as both command and canonical product message
identity, plus summary/actionMode/task refs. Native delivery content reuses the exact
portable Desktop mode protocol/blocks, selected for the captured recipient role.
Human DELEGATE sends require the current lead before effects; a changed captured
role holds recovery. Native mode behavior still needs E2E evidence; this introduces
no separate per-tool SDK mode policy requirement. Uncertain results retain command IDs
for explicit lookup and never retry automatically. Task-start notifications have
controlled Host proof; actual UI start notification, attachments, cross-team and
slash-command sends remain incomplete.

Full P5 still requires resource-local partial-outage handling for merged lists/global
boards: their current DTOs cannot represent unknown counts/per-owner failures, so a
failed owner currently fails the combined read. Do not replace this with invented
zero counts, hidden owners or legacy fallback. Ordinary runtime/launch/review/
attachment workflows and Host change-feed integration also remain open delivery work.

The finite Runtime API now exposes explicit `runtime.restore` with member ID,
published checkpoint reference and source `expectedGeneration`. Main forwards the
original command ID through the captured work lane. Runtime snapshots return only
the application generation, never provider session IDs or private checkpoint bytes.
After replacement, mutating controls must carry the current expected generation.
Selected restore is qualified through actual standalone Host/native paths;
ordinary Desktop Resume controls are still pending.

Private `management` descriptor entries bind an exact runtime/context/project selection
to a captured owner/profile/config revision. Global provider settings may use no Team
handles. `captureProviderManagement` carries foreground guards before/after lazy
startup and replies; retained read/cancel/lookup controls keep the original target.
The private `targetId` hashes the complete owner/profile selection. A restored target
must exist with exactly the same selection; changed captured descriptor/config/artifact pins hold
instead of silently selecting the new default. The target digest never appears in
renderer discovery. The provider-management adapter journals its original private
target digest before starting OAuth, then restores code/cancel/read controls through
this primitive. A missing/changed target holds; it never redirects to the default.
Ordinary Electron management controls and full migration parity remain unqualified.

The captured management conversation also has finite `probe.start/read/cancel` controls.
A consumer may supply an additional Main-owned logical guard when capturing a target;
it is checked before/after lazy startup and replies along with the shell context guard.
Probe read/cancel are retained original-owner controls after cancellation/context switch.
No guard, owner/profile/config selector or arbitrary native method is renderer supplied.

Finite `team.launch.read/start/retry` operations expose only application launch/roster/
attempt/member generation identities. Main strips native IDs, config digests and Host
incarnations. These operations support trusted sandbox setup; ordinary Launch settings,
creation/resume controls and full workflow cutover remain delivery work. Native Stop
attempt evidence retains its missing pre-Quit process observation explicitly:
[handoff](../../../docs/plans/provider-migration/evidence/p5-desktop-native-stop-handoff.json).

`team.launch.start.configuration` now carries finite per-member model/effort/fast/
permission/context choices. The Host publishes the original configuration intent in
its existing launch record before allocation; it reconstructs it on restart and keeps
it during selected restore. Main verifies exact admitted options and the original
command/source revision before accepting the changed configured roster revision.
Public launch snapshots expose only admission command/source revision. Executable,
account, environment, native identifiers and arbitrary provider options remain private.
[Actual Electron and mixed restore proof](../../../docs/plans/provider-migration/evidence/p5-launch-configuration-handoff.json)
qualifies this finite initial-selection path. It does not qualify normal Launch/Resume
dialogs, saved-settings/roster/preflight integration or changes to already allocated
generations. Native parameter observations do not imply correct runtime model labels
in the existing UI.

Ordinary `onTeamChange` subscribers share one sequential `team.changes.read` loop
using captured handles. `team.snapshot` now returns its product state and
`feed: {streamId, sequence, cursor}` under the same Team/current-grant fence.
The Team owns up to 128 volatile invalidations with stable IDs. Replay follows the
snapshot high-water position; initial/unknown cursors, restart and expired retention
produce explicit resynchronization gaps. These are read-side hints, not another
durable business log, Native identity or source of business authority.

`TeamProductReadOrder` retains metadata only. Older sequences and retired streams
cannot replace accepted state, including a Team read awaiting Runtime observations.
Local mutations and Stop invalidate reads crossing dispatch/outcome boundaries;
unknown outcomes are never replayed. Merged list/task responses check their original
observations again before returning. Subscribers deduplicate source events, preserve
current-context/unsubscribe fences and rehydrate a new listener without discarding
the existing source cursor. Independent handles keep working through a read outage.

[Native v3 proof](../../../docs/plans/provider-migration/evidence/p5-team-read-feed-handoff.json)
qualifies this Team product conversation and the ordinary Claude Composer/Task/
reply/Stop regression with localhost inference. Other resources, complete background
notifications, merged-list partial-owner availability and ordinary Launch/Resume
remain Stage1 work; this is not full P5/P8 acceptance.

Selected launch settings now have an authorized `team.launch.configuration.read`
projection: user choices, contextual workspace and member IDs; credentials/process
configuration remain private. `createHostBackendRenderer` shares read-order fences
between direct Host controls and ordinary Team reads, including uncertain results.
`getSavedRequest` translates that selection into the **existing** LaunchTeamDialog
contract; ordinary `getData` supplies its workspace/provider/model defaults without
another form/store. Missing settings leave product records readable with an explicit
warning; stale context or mutation-crossing reads cannot apply their result.

Only existing Create/Launch/Resume/review UI is used. An alternate experimental
Host launch form was removed at the owner's request and is not an accepted workflow.
Complete ordinary launch still needs the existing preparation, roster replacement,
request mapping and provisioning-progress contracts; this saved-data slice does not
claim those operations or full P5/P8 parity.

Existing Create/Launch dialogs now send a finite Team/create preparation context.
The owner-qualified selection-key recognizer is shared through `contracts`, and
the same context partitions model proof and in-flight request identities. Preload
retains that context; Main routes a Host preparation intent before any fork
preflight. The captured Team model adapter uses the same member-qualified probes;
unbound create still returns `ready:false`. Global model tests do not silently
grant Team readiness.

`team.launch.probe.start/read/cancel` now supplies a finite Team-qualified model
check over the same captured handle and original command ID. Main validates
launch/roster/member/model choices and strips private fields. Host selects the
member's private Runtime account namespace/workspace and reuses ModelProbeOwner;
operator/member grant revisions bind the result so revoke/regrant invalidates it.
Model probes leave member Runtime sessions unopened and do not grant global auth
or aggregate launch readiness.

`prepareCapturedTeamModels` is the Main adapter used by the existing preparation
callback. It captures the handle and desired choices before awaiting, derives a
stable initial command ID per launch/roster/member/model/effort/context, and
reads that exact ID first. Only current Host durable absence admits it. A lost
response is read under the same ID on the next call; no second outcome journal or
provider session owner is introduced. Navigation and deadline cleanup address only
the original captured probe. Full desired model choices also accompany cached
runtime-only diagnostics, so a UI cache cannot check another default model.

The existing submission fence also holds one preparation ID. Renders and submitted
work keep it; dialog reset or an explicit provider refresh starts a new preparation.
Main durably associates that ID with its original command before any model dispatch.
Immutable successor links allow a new preparation to renew a known released failed,
cancelled or expired check. Concurrent preparations share one successor. Old callers
always read their original association, including after newer checks and cold reload.
These files contain application IDs/checksums only; Host remains the outcome owner.

UNKNOWN reads retain the original ID. Held or authority-invalidated observations
may be retired only through original cancellation: the Host can settle a held
observation only when native custody was already confirmed released. Live/unknown
custody stays held. Cleanup success never becomes model/auth evidence; the new
intent still needs fresh current control admission and a successful native probe.

Existing Host dialog checks now attach explicit lead/member targets to each selected
provider/model/effort group. Main resolves these UI references against authoritative
Host roles and stable member IDs, including a renamed row's original name. Swapping
the same choices between members invalidates the request cache. Legacy checks keep
their previous untargeted shape. Both the existing dialog and Main member-spec code
use the same model/effort inheritance rule.

The captured lead workspace validates the dialog project context; every member's
probe uses its own captured private account/config/workspace. Unknown or duplicate
targets, partial Claude coverage, provider changes and mixed targeted/untargeted
requests fail before dispatch. Actual SDK/CLI with localhost inference verified two
members with the same saved model/low effort selecting medium for lead and high for
worker, plus renewal and warm/cold replay. This invokes the Main application adapter;
it is not Electron dialog acceptance or vendor authentication.

Untargeted callers retain the conservative saved-selection mapping. Changed
workspaces, unsupported efforts/options and expired or held evidence refuse before
claiming success. Dynamic roster/provider/workspace configuration, other providers,
create, full configuration authority and
ordinary Launch/Create/Resume E2E remain required; model-preflight `ready` is not
native member/Team readiness.

Ordinary `getProvisioningStatus` and `cancelProvisioning` now accept a reserved
`host-run:` application key containing the captured handle, launch ID and roster
revision. A missing owner or changed selection refuses instead of looking up a
legacy run or targeting a replacement. Cancellation captures all member generations
before the first stop, continues independent cleanup after a member refusal and
retains an unknown outcome when physical release is unconfirmed.

The existing `onProvisioningProgress` callback shares the Team observation loop;
it does not start another timer. This keeps long bootstrap visible after the
store's initial polling ends. Unavailable owners do not fabricate failed/ready
events; context changes and mutation-crossing reads discard stale observations.
New subscribers receive a current projection, while timestamp-only observations
are deduplicated. Source launch/admission time survives replay/reconstruction and
Host observation time supplies `updatedAt`; older captures without those facts
cannot acquire invented timestamps. Pending work, human decisions, unknown custody,
partial failures and confirmed stops use the existing progress DTO and diagnostics.
Skipped members stay in the expected roster but do not prevent an otherwise ready
Team; empty/all-skipped rosters do not imply readiness.

Controlled-provider NDJSON integration covers ordinary progress/read/cancel against
the real Host/Runtime owners. This is neither actual native SDK qualification for
the new progress path nor acceptance of the Electron Launch/Create/Resume dialogs.
Ordinary launch submission, dynamic roster settings and the remaining P5/P8 work
are still required.

The portable Host now has authoritative saved-roster read/replace/original lookup
under the existing Team owner. Full teammate settings, stable identities, removed
member restoration, revocation and recoverable controller projection are implemented
and tested through real NDJSON with a controlled provider. The finite Desktop facade
now exposes `team.roster.read/replace/lookup` through the existing preload IPC and
authorized HTTP routes. It captures all existing teammate fields before await,
rejects private selectors/oversized requests, projects only allowed settings and
preserves the caller's original handle/command/revision. Lookup uses a finite control
request with an empty payload or an expected original replacement payload. The
latter verifies receipt fingerprint as well as original command/principal before
Desktop may recover a lost response. Mismatched payload conflicts; absence never
means success. The app's unauthenticated HTTP context remains denying.

Team's admission receipt is immutable handoff evidence, not a live Runtime input
cache. Saved edits hold pending Team commands/deliveries; after admission Runtime's
synchronous current input/custody proof decides whether resources are released.
Main-to-NDJSON tests cover message completion/stop followed by saved configuration,
exact original replay/lookup and stale-revision refusal.

Saved lead/global choices now travel in the same roster DTO. `getSavedRequest`
reads that owner configuration directly; it does not interpret resolved Runtime
values as configured overrides. Unknown settings return null; explicit defaults,
false/off, prompt/args and existing presentation fields round-trip independently.
`getData` refuses mismatched snapshot/configuration revisions and retains configured
teammate settings even without known global defaults. Existing model prefill uses
owner choices before runtime, prior-run or local preferences, including cleared model.

Ordinary `replaceMembers` now carries the revision actually hydrated into the
existing dialog and its original command identity. A renewed model preflight
cannot replace an uncertain roster intent. The adapter captures the full input
before awaiting, invalidates older product reads, and resolves an uncertain save
with one read-only lookup of that exact payload at the original owner. It never
generates a replacement command or reads a newer revision to overwrite a stale form.
Member-settings CAS uses owner-issued version tokens and the existing roster
transition. Descriptive roles cannot replace canonical lead identity in the view.
These are original React-dialog and actual Main/NDJSON checks, not Electron
Launch/Create/Resume acceptance. Fresh native capture, ordinary `launchTeam` and
full existing-dialog E2E remain required in stage1.

The optional trusted descriptor `creation: {owner, contextIds}` enables unbound
save-only creation at that exact Host. The existing Create dialog retains one
command ID for an unchanged save; Main captures its shell context and never accepts
renderer owner/configuration selectors. A lost response allows one lookup of that
original intent. Main publishes only immutable routing metadata and returns a
canonical selection key for the existing Team view. Host discovery reconstructs
dynamic bindings after restart, and dispatch/discovery/authorization share them.
An explicit creation owner must match the full persisted binding; changing a
default or descriptor cannot reassign a retained handle. A context switch after
Host commit leaves the original outcome at Host, without applying a late UI result.

Create with immediate launch still requires captured preparation/model checks and
launch integration. Save-only support does not grant readiness, global provider
authentication or complete Stage1 acceptance.

Existing message/comment controls upload attachment bytes through selected-Team
`attachment.upload` chunks (384KiB), then publish only immutable references with
`message.send` / `task.comment`. The original handle and command ID survive both
steps; uncertain uploads remain owned and are never replayed to another backend.
The portable host reuses `agent-attachments` normalization, MIME/model rules and
artifact layout through its narrow `attachments/*` exports. UI metadata excludes
private paths, while canonical product metadata retains paths for existing
archive/import support. D receives ordered references and resolves exact bytes
through its private attachment port; storage alone is not native delivery.
