# Legacy Agent Host

Stage 1 portable Team/Runtime host under implementation. The transport-only CLI
remains available without a product profile. A captured product profile enables
canonical Team Task/Message commands and original-command lookup. A handshake
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

This checkpoint is incomplete: the CLI does not yet compose native Runtime
sessions or bootstrap a team; full catalog/review/backup/restore and Desktop
cutover remain in the Stage 1 plan. Uncertain Task notification recovery is held,
not replayed. Technical fixtures and individual native feasibility proofs do not
close the complete P4–P8 acceptance matrix or real account qualification.

The first native Claude integration test is separate from the regular test glob:
`tests/native-claude-team.native.ts`. Run it with the staged standalone Node and
explicit `LEGACY_NATIVE_TEAM_GO=1`, `LEGACY_NATIVE_PROVIDER_ARTIFACT` and
`LEGACY_NATIVE_PROVIDER_SHA256` matching the selected tarball. It creates fresh
TEST roots and localhost inference, uses actual SDK/CLI/MCP and retains its
receipt, including failed attempts. It exercises in-process Team/Runtime owners;
the CLI stdio product path has its own subprocess test. Neither is Desktop E2E.

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
