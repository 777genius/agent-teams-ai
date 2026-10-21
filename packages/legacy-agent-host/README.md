# Legacy Agent Host

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
stop/interrupt/interaction/reconcile and checkpoint. It does not accept executable,
environment, model, principal, run, generation or native checkpoint bytes. Read
projections omit private provider/configuration/operation identities. Team commits
wake one recovery/dispatch pump; native terminal events allow the next admitted
input. Startup recovers original obligations without allocating or adopting a
native session. Aggregate Team bootstrap is not advertised as complete.

Task recovery prepares canonical policy once on a private detached product JSON
snapshot, then publishes guarded file effects and notification obligations.
Uncertain or changed evidence holds the original intent instead of running the
canonical handler again. Checkpoints publish private payloads before safe
references, and explicit restore keeps the new input queue empty. Actual native
history restore still needs its provider qualification.

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
