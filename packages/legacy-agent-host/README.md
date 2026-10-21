# Legacy Agent Host transport

P1 transport package only. There is no Team store, provider driver, native session,
single-writer storage lock, durable command outcome or recovery implementation yet.
The executable advertises only its actual transport capabilities and rejects all
product/native methods. A successful handshake means protocol compatibility only.

The package is portable ESM with no runtime dependencies and requires Node
`>=24.21.0 <25`. Build/test with `pnpm --filter @agent-teams/legacy-agent-host test`.
The `./contracts` export is browser-safe; the root server factory is Node-only.
`./cli` and `legacy-agent-host` launch the standalone transport executable.

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
