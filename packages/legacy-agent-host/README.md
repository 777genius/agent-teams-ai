# Legacy Agent Host

Explicit Claude model tests reuse the captured management profile and existing
durable ModelProbeOwner. The provider library supplies finite native execution;
this Host checks selected namespace identity and physical cleanup before returning
success. A model test grants no global authentication or team-launch authority.
[Native/Main proof and remaining integration](../../docs/plans/provider-migration/evidence/p5-claude-model-probe-handoff.json)
cover success, wrong-model rejection, cancellation and original-command replay.
Existing Launch/Create/Resume dialogs remain the only accepted UI; their complete
preparation/roster/launch/progress workflow is still in progress.

Finite `team.launch.probe.start/read/cancel` binds model/effort/context checks to
the selected launch/roster/member. Native configuration is derived from that
member's captured Runtime profile. The existing ModelProbeOwner shares its
namespace fence and durable journal with other management intents. Team control,
member authority and their original grant revisions are rechecked before SDK
input and result; revoke/regrant cannot revive an old proof. Public results omit
account paths, native/profile identities and authority digests. This supplies the
Team-qualified model-test prerequisite; ordinary `prepareProvisioning` and the
complete dialogs still need integration. [Scoped proof](../../docs/plans/provider-migration/evidence/p5-team-model-probe-handoff.json).

Stage 1 portable Team/Runtime host under implementation. The transport-only CLI
remains available without a product profile. A captured product profile enables
canonical Team Task/Message commands and original-command lookup. An optional
captured `runtime.members` profile composes individual Claude members through the
selected public provider library, real private Team MCP and the durable Runtime.
A handshake
means API readiness, not member or aggregate team readiness.

The package is portable ESM and requires Node `>=24.21.0 <25`. Provider Session SPI
and driver implementations install from pinned local artifacts; the current
agent-runtime engine, PostgreSQL and fork executable are not dependencies.
Canonical Task policy and filesystem locks reuse `agent-teams-controller`.
Build/test with `pnpm --filter @agent-teams/legacy-agent-host test`.
Use Node 24.21+ (below 25) for this standalone package. When the root workspace
runs under Node 26, select an existing Node 24 executable for the actual CLI
subprocess fixtures with `AGENT_BACKEND_TEST_NODE`; the fixture profile digest
and child PATH use that same executable. Root captured-Host tests already honor
this variable, and CI captures it before switching to the frontend Node version.
For example, `AGENT_BACKEND_TEST_NODE=/absolute/path/to/node24 pnpm check:ci`
keeps the frontend test runner on its selected Node while testing the CLI on 24.
The `./contracts` export is browser-safe; the root server factory is Node-only.
`./cli` and `legacy-agent-host` launch the standalone transport executable.

The trusted Desktop profile can set `LEGACY_AGENT_HOST_PROFILE_PATH` and
`LEGACY_AGENT_HOST_PROFILE_SHA256` together. The CLI reads the bounded, exact-digest
private file before acquiring the canonical store writer lease or creating Team
state. Its schema is exported from `./team-host`; paths, principal and grants are
composition data, never model/renderer arguments. Team RPC requires the captured
owner/scope envelope and a caller-prepared command ID. Policy diagnostics are
bounded on stderr and never appear in stdout NDJSON.

`./team` and `./team/filesystem` expose the product owner and its filesystem
composition. `./runtime` and `./runtime/filesystem` expose the technical owner and
store. The Team outbox hands the original immutable input to Runtime; only Runtime
claims native dispatch. The `./mcp` endpoint uses an injected captured Team
connection, private route/Bearer capability, current binding checks and stable
mutation IDs. It does not instantiate another controller/writer.

The Runtime RPC surface selects only a captured member ID: open/read/dispatch,
stop/interrupt/interaction/reconcile, checkpoint and explicit restore. It does not accept executable,
environment, model, principal, run, native configuration generation or native checkpoint bytes. Read
projections omit private provider/configuration/operation identities. Team commits
wake one recovery/dispatch pump; native terminal events allow the next admitted
input. Startup recovers original obligations without allocating or adopting a
native session. `runtime.restore` accepts an original command ID, member ID,
published `cp1-…` reference and `expectedGeneration` from the source snapshot.
It requires released source custody and validates exact selected history before
publishing a new technical generation in the existing launch record. Team delivery
reads this selection; old receipts keep their original binding. There is no second
binding registry. After replacement, mutations require the current expected generation;
stale controls fail before effects. Concurrent repeats of one restore share its pending
result, and restart never retries an unknown native allocation. Aggregate Team
bootstrap and ordinary Desktop resume are not advertised as complete.

An optional private `management` profile list composes owned OpenCode management
servers through the existing public provider library. `management.catalog` accepts
only a captured profile ID/config revision and optional provider ID; executable,
endpoint and credential roots cannot be supplied through RPC. Directory reads
carry model counts; an explicit provider selection includes bounded model metadata.
`management.credential` supports API credential set/forget with a stable command ID;
`management.credential.lookup` reads its original receipt. The private journal stores
fingerprints and outcomes, never keys/metadata values. Uncertain claims are held
after restart, rather than repeated. One credential namespace serializes writes;
unknown writer cleanup holds it. This offers process-crash recovery, not a new
power-loss durability guarantee. `./management/contracts` exports only safe metadata.

An explicit `claude` management profile also serves `management.claude.metadata`.
It selects a pinned SDK revision, executable digest, cwd and HOME/config namespace;
the RPC caller supplies only the captured profile ID/config revision. The public
provider library initializes SDK model/account-source metadata without input,
tools, MCP or a persisted conversation. Host checks namespace identity and confirms
physical cleanup before returning; unresolved custody holds that resource. The
result contains no email, native session ID or credential and grants no auth/model
execution readiness. These reads require neither a Team nor the fork executable.
`management.oauth.start/read/authorization/complete/cancel` own bounded browser/code
flows with stable IDs and the same namespace writer fence. Public progress never
contains URLs, instructions or codes; authorization is a private Host→Main reply.
Cancellation retires the captured native process before releasing its namespace.
Pending flows after a crash remain held; replay never starts a second login.
`teams: []` is valid for global management without Team bootstrap.

Explicit provider catalog reads also return allowlisted native auth methods with
original method indices and supported prompt metadata. Unknown widget/condition
semantics disable that method rather than dropping required native fields.
The Desktop port now connects catalog/model metadata, API key set/forget and
OAuth code/cancel with durable original Main routing. `management.probe.start/read/cancel`
own explicit, at-most-once no-tool model tests. Auth changes and probes serialize
within the same captured native namespace. The probe publishes completed only after
its native process is physically stopped; cancellation wins over late native success,
and cold pending probes remain held. Responses contain no model text/native IDs.
Defaults and the complete ordinary UI are still being integrated. Native connected/catalog presence is not
execution proof. OAuth process E2E uses a TEST OpenCode-shaped server, and does
not qualify a real vendor login.

Task recovery prepares canonical policy once on a private detached product JSON
snapshot, then publishes guarded file effects and notification obligations.
Uncertain or changed evidence holds the original intent instead of running the
canonical handler again. Checkpoints publish private payloads before safe
references, and explicit restore keeps the new input queue empty. Selected native
history restore has a scoped Claude/Codex/OpenCode proof with localhost scripted
inference; vendor authentication and the ordinary Desktop Resume workflow remain open.

This checkpoint is incomplete: full catalog/review/backup/restore, mixed-provider
teams and Desktop cutover remain in the Stage 1 plan. Technical fixtures and individual native feasibility proofs do not
close the complete P4–P8 acceptance matrix or real account qualification.

The first native Claude integration test is separate from the regular test glob:
`tests/native-claude-team.native.ts`. Run it with the staged standalone Node and
explicit `LEGACY_NATIVE_TEAM_GO=1`, `LEGACY_NATIVE_PROVIDER_ARTIFACT` and
`LEGACY_NATIVE_PROVIDER_SHA256` matching the selected tarball. It creates fresh
TEST roots and localhost inference, uses actual SDK/CLI/MCP and retains its
receipt, including failed attempts. It exercises in-process Team/Runtime owners;
the CLI stdio product path has its own subprocess test. Neither is Desktop E2E.

`tests/native-claude-host.native.ts` is the separate actual-CLI/native scenario.
It requires explicit GO plus selected provider, native executable, complete host
source and compiled-tree digests. Ordinary tests do not launch provider agents.
Native cleanup tracks captured process handles and isolated POSIX groups, retiring
confirmed-ended groups. This is not proof against descendants escaping those
groups; Windows cleanup remains unconfirmed until its process-tree adapter is
qualified. Selected native history lookup is read-only, rejects ambiguous or
symlinked stores, and bounds history to 64 MiB and individual JSONL rows to 1 MiB.

The separate `tests/native-codex-team.native.ts` uses the actual pinned Codex
app-server through public D with in-process owners, explicit
`LEGACY_CODEX_TEAM_GO=1` and the selected provider artifact/digest. The archived
passing profile explicitly approves six Team tools only in the TEST config. It
does not qualify production Codex host composition or interactive human approvals.

Frames are UTF-8 NDJSON, one JSON-RPC 2.0 request with a string/safe integer `id`
per line. Batches and client notifications are intentionally unsupported. A frame
limit counts bytes before LF (including optional CR), before decoding or parsing.
Call `host.handshake` with `{ "protocolVersion": 1 }` before invoking injected
methods. The response includes build identity, unique host incarnation,
capabilities and effective limits. No raw payload is included in diagnostics.

`createHostServer` accepts streams, build identity, trusted limits and injected
methods marked `work` or `control`. Long asynchronous work handlers do not block
the reader. Work cannot consume reserved control request capacity. Handlers own
their business authority, idempotency, persistence and per-session ordering;
transport IDs are not business command IDs. Generic handler failures return a
safe error. Handler error messages are never disclosed, including `HostRpcError`;
the transport emits the constant `Operation failed` for allowed custom codes.
Custom handler errors use codes -32099 through -32010 and may follow partial
effects. Codes -32001 (handshake), -32002 (busy) and -32601 (unknown method) are
reserved transport rejections before handler admission. Invalid/duplicate request
ID (-32600) can refer to an already running original request; generic handler
failure (-32603) does not prove that no effect occurred.

Output has bounded priority and data queues plus at most one in-flight frame.
Responses and control overtake queued data. Dropped data generates an aggregated
`host.gap` notification `{ "dropped": N }` before subsequent queued data; consumers
must rehydrate through the owning feed's snapshot/replay contract. This package
does not invent a cursor or fabricate durable history. Data producers never await
stdout. Exhausted priority capacity or a blocked write closes the transport.

`dispose()` is idempotent transport disposal: it seals ingress, aborts handler
signals, closes streams and invokes bounded `onDispose`. That signal is not proof
that a native effect was cancelled. Owners must retain their durable obligations
and dispose all captured resources independently. `closed` distinguishes cleanup
completion, failure and timeout. App Quit/Relaunch must perform its scoped graceful
cleanup before transport disposal. Stdio cannot reconnect to a live child;
replacement/exit/custody/storage-lock policy belongs to Desktop composition.

`team.launch.read/start/retry` is also available through the finite captured Desktop
facade. With no Runtime profile, an authorized `read` returns null; start/retry refuse
before allocation. Ordinary Team presence and Stop consume Launch/Runtime state while
product snapshots remain free of inferred native/process/session provenance. This does
not qualify ordinary Launch/Resume controls or full Desktop cutover.

Initial `team.launch.start` also accepts finite per-member user configuration.
Composition maps model/effort/fast/context/permission choices to the selected private
provider profile; incompatible options refuse before any partial publication. The
existing launch record publishes the original intent and its opaque options before
provider creation. A queued unopened input keeps its original delivery. Claimed or
allocated generations cannot be reconfigured through this initial-selection path.
Current grants apply to replay, and changed/dropped options conflict. Recovery checks
the captured base profile and reconstructs the same selected configuration; selected
restore retains it instead of reverting to descriptor defaults.

Configured start returns private admission correlation for Main to validate the
original command, source revision and exact options before accepting the new roster
revision. Public snapshots expose only the admission command/source revision.
[Native configuration proof](../../docs/plans/provider-migration/evidence/p5-launch-configuration-handoff.json)
qualifies actual Opus/medium requests through Electron and after mixed native
checkpoint/restore. Ordinary Launch/Resume dialogs, dynamic roster/config lifecycle
and full settings/extension parity remain incomplete.

`team.snapshot` and `team.changes.read` now share Team's current-grant read fence.
The snapshot includes its read-stream position; replay returns later invalidations
with stable source IDs. The Team-owned volatile journal/cursor registry is bounded
to 128 entries. Initial/unknown cursors and expired retention return explicit gaps;
restart creates a new read stream without changing durable command outcomes.
Snapshot state/metadata fit the existing 512 KiB bound. These technical invalidations
create no new durable product writer, command log or native allocation.

`team.roster.read/replace/lookup` exposes Team-owned saved application configuration.
The captured principal supplies one command ID and the expected product revision;
the owner retains the lead, preserves member IDs and Task/inbox bytes, and stores
all existing teammate options. Omitted options clear an override in a full replacement.
Optional `savedSettings` contains the original lead/global launch choices, presentation,
prompt, worktree/custom args and local-model override. Missing outer settings means
not captured. A teammate-only command preserves them; a supplied object fully
replaces them, so omitted inner options clear overrides while explicit false/off
survive. Trusted profile values initialize an absent owner only, never overwrite
settings on reopen. Effective native models/accounts are not saved defaults.
Restoring a removed name retains its product identity without restoring its old grant
or delivery target. Descriptive roles stay in settings; controller authority uses
the canonical lead/member role.

The decision and original receipt are one atomic Team state publication.
`config.json` is a recoverable projection: restart completes that exact projection
or holds if foreign bytes replaced it. Replay never reruns membership policy. State
is bounded to1 MiB/1024 roster receipts/1024 removed members; exhaustion refuses
before publication and does not erase outcomes. Runtime proof is synchronous and
outside Team's lock. Live, pending or unknown custody refuses an edit; confirmed
released resources are detached without deleting their launch/Runtime journals.
Task/delivery recovery debt also holds changed configuration.
An admitted Team delivery is a completed handoff; its cached admission phase is not
polled as live input state. Runtime's current input/custody proof owns that check,
so completed messages followed by confirmed stop do not permanently block edits.

A stale static runtime descriptor cannot allocate from saved settings it did not
capture. Settings-only changes require the same released-runtime proof and advance
the product revision. Product snapshots include that configuration revision for
coherent form hydration. Warm and cold reads of the current Launch selection return
unconfigured after an edit; historical journals remain preserved on disk.
Ordinary Desktop `replaceMembers` now reaches this owner with the form's original
revision and command ID. Member-settings relaunch validates owner-issued version
tokens for the complete source roster, target identity/kind and explicit model/
effort choices inside the same CAS transition. It cannot change membership.
Fresh per-member native capture and ordinary Launch integration are still stage1
work; these APIs do not claim that Electron existing-dialog E2E is complete.

Dynamic configuration creation is now an explicit Host capability. The private
profile may enable `creation.contextIds`; it is disabled by default. The finite
`team.registry.create/lookup/list` methods validate the captured owner/context and
publish one original creation intent before bootstrapping a Team through the same
filesystem owner. This registry owns creation outcomes and discovery metadata;
subsequent roster, Tasks, messages and Runtime state keep their existing owners.
Replay and cold recovery retain the original identities. A previously published
Team with a missing ownership marker stays held rather than recreating defaults.
No provider session is opened by save-only creation.

`runtime.providerTemplates` optionally declares private, unique provider defaults
for new members or a changed provider. Exact matching per-member recipes retain
their own account. Templates are never inferred from another member; their full
digest binds capture/reconstruction, and an existing native OpenCode session cannot
be used as a fresh template. Executable, account, environment and native identity
remain Host composition data. These prerequisites do not establish full Create
launch/preflight, mixed advanced-option or Desktop Resume parity.
