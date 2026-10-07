# Owned process broker: unactivated capability slice

This is PR4a, not product activation. No existing launch factory imports this bridge.
Windows SDK/MSVC x64 and ARM64 execution, pinned Electron fd3 behavior, packaged resource
staging, PR4 consumer migration and PR5 durable evidence gates are still required.

The executable owns one unnamed, non-inheritable, no-breakaway Job. Atomic
`PROC_THREAD_ATTRIBUTE_JOB_LIST` admission creates a suspended root. Only fd0-2 are
target-inherited; broker copies close after creation. Private fd3 remains outside
the target. Owner registration/persistence and observation installation precede resume.
The root handle witness, fresh zero ActiveProcesses accounting, target drain, control
loss and release are distinct. Broker/root PIDs are never substituted for each other.

Allocate/register before prepare. Preparation failure carries the same pending handle.
Force Stop seals admission before waiting. `abandonControl` seals and closes only this
private endpoint for unconfirmed last-handle containment; it retains unknown outcome
records and cannot authorize resource/metadata release. Genuine receipts are private
object capabilities, checked against immutable owner and component coverage. Unknown
attempts remain immutable. Up to 64 attempt records are retained; further attempts fail
explicitly instead of evicting unresolved ownership. One coalesced Stop uses the earliest
app deadline; late native proof cannot rewrite an expired outcome. Graceful Windows Stop
is unavailable. Targets using PTYs, IPC/fd inheritance, relative executables, shell flags,
drive-current-directory environment entries or external service dispatch are unsupported.

Control framing is 32 bytes, protocol 1, u64 request ID, exact 128-bit generation;
launch 1 MiB, other 4 KiB, 8 queued native replies, 4 pending app requests, 1024 frames.
Control writes time out after 5 s. Native admission and accounting do not depend on target
stdio consumption. Launch values remain on the private pipe, never diagnostics/argv.
Birth tokens are fixed 16-hex FILETIME values read through the original process handle.

Only private fd3 uses Node's `overlapped` stdio option. Native reads and writes use separate
OVERLAPPED/manual-reset events and terminal original-handle result queries. Partial writes
share one 5 s whole-frame budget. Pending failure latches before exact-operation CancelIoEx;
unproven terminal cancellation uses nonreturning self-termination without freeing storage.
Accepted Release stops further command reads; complete in-budget ACK and original exit 0
are separate assertions. Fixed exit categories 70-77 plus bit 128 for unproven cancel drain
and bounded bridge cause/phase facts expose no launch values. Later exit cannot replace failure.

Host commands, from the repository root (source was not locally executed):

```text
pnpm exec vitest run --config tools/owned-process-broker/vitest.config.ts
node node_modules/@typescript/native/bin/tsc --noEmit -p tools/owned-process-broker/tsconfig.json
pnpm exec tsx scripts/build/buildOwnedProcessBroker.ts x64 <isolated-build-dir> <explicit-stage-dir> "C:\Program Files\CMake\bin\cmake.exe"
<gate-controller.exe> <absolute-node.exe> <absolute-node_modules/tsx/dist/cli.mjs> <absolute-nativeGate.ts> <staged-broker.exe> <fixture.exe> <birth-failure-broker.exe> <accounting-failure-broker.exe> <release-delay-broker.exe>
```

Supply the absolute path to your installed `cmake.exe` explicitly (the example is a common installation path). The helper validates it as an absolute regular-file executable before spawning and does not resolve CMake through PATH. No dependency is installed by this helper.

The controller creates a fresh sandbox and atomically contains Node plus all fixture/broker
descendants in its independent outer no-breakaway Job. Every pending capability is retained
for private-control abandonment in finally, and direct helpers are awaited. Only the controller
removes the sandbox after its original Node handle exits and fresh outer accounting is zero.
Any 120 s deadline/emergency termination makes the gate FAIL, even if containment succeeds.
The Node scenario log alone is not PASS. Run only through this controller, never standalone.
Neither the controller nor any fault/scheduling executable is staged as the product broker.

Repeat build/run on a real Windows ARM64 runner with `arm64`; cross compilation or
emulation alone is not its runtime gate. Run the same nativeGate using pinned Electron's
Node mode and then the staged packaged resource path. Record exact source/binary SHA256,
PE machine, actual process.versions and architecture. The birth-failure executable is
a separately compiled fault fixture and must never be staged or packaged as the broker.
Its query failure is injected, not evidence that the OS normally fails GetProcessTimes.
The separately compiled accounting fixture injects one QueryInformationJobObject failure,
then performs actual successful Job queries: first attempt remains unknown even after zero,
and only distinct fresh reconciliation can confirm. A release-delay fixture pauses the writer
after a fully written ACK; the raw native gate reads Released, ends owner control and requires
the original broker process to exit 0, exercising reader/writer scheduling rather than a mock.
Release waits up to the same 100 ms state-lock budget as Resume. This unstaged variant also
uses a watcher-held original mutex and an actually failed lock probe before bounded unlock;
the contention gate requires all three native facts, a genuine Released ACK and original exit 0.
The production broker does not compile the contention toggle or emit its fixture-only ACK facts.
This same unstaged variant requires an actual post-Launch ReadFile ERROR_IO_PENDING before
Prepared, proving concurrent read/reply scheduling. Native pending-write timeout/cancellation
storage races remain an explicit OPEN runtime gate; synthetic bridge tests cannot prove them.
The new unstaged pending-write fixture qualifies only the shared native transport primitive.
Its native supervisor holds a private connected byte-pipe reader until a real WriteFile pending
and GetOverlappedResult incomplete observation. Positive drain has its own OVERLAPPED/event/
64 KiB buffer under the original writer deadline. The deadline cohort leaves the peer unread,
records exact CancelIoEx/result facts and requires original writer exit 74 or 202 according to
terminal proof. Pending storage stays live to a proved terminal result or original process death.
The original supervisor exits 0 only after fresh inner Job 0; the outer controller still owns
the Node/Electron run and all descendants. No product Stop/Release receipt is derived.
Before spawn, nativePendingWriteGate reads checkout/native-evidence/binary-sha256.txt anchored
to its own source module, with strict bounded full-path/digest and actual PE-architecture checks.
The current workflow creates that inventory before either gate; running without it fails closed.
Only the pending-write fixture compiles its passive observation definition, and staging remains
exactly normal broker plus manifest. Both new cases run after all 17 existing scenarios on both
real architectures under Node and pinned Electron. The native workflow must provide
current-source WRITE evidence before merge.
Claims remain branch-observed: unhit terminal/undrained/partial/late-completion races and direct
broker-fd3 backpressure remain OPEN. Neither pauses nor an elapsed deadline prove API pending.
Its compile-guarded numeric `OWNED_PROCESS_TEST_TERMINAL_RACE=1` fixture toggle forces a
failure CAS after genuine full ACK and before success CAS; the raw gate separately requires
original exit 74. A bounded two-way atomic handshake requires the actual losing success CAS
and its observation before exit 74; missing handshake exits 75, so it cannot pass by elapsed time.
Normal broker ignores this toggle. ACK alone is never this negative gate's success.
Default product-side admission reads a maximum 4 KiB strict manifest, hashes a maximum 16 MiB
PE file and verifies schema/platform/architecture/protocol/file/digest before starting the
broker. Mutable filesystem check-to-spawn races are not a malicious-OS security guarantee.
The injected BrokerTransportFactory is trusted composition (private streams/control/events)
for alternate launch adapters and policy tests, not an untrusted IPC input or target process.

Native gates capture independent original process handles with matching birth tokens
before Stop, then wait those handles. They exercise nested descendants, root-first exit
and final JSON tail with descendant-held pipe, blocked output, breakaway refusal,
query-failure unknown, owner EOF, broker crash, mismatched generation and unrelated
sentinel isolation. Flood waits for the exact first nonce, a target-written nonce/byte-count
progress record after actual stdout WriteFile completion, and paused stdout at its high-water
mark before Stop. Output remains unconsumed and bounded; Resume ACK alone is insufficient.
A target-only first-effect nonce precedes scenario work/descendant spawn:
absent while suspended/cancelled/birth-failed/unpublished, exact nonce present after resume.
They run only disposable fixture processes in the controller's new temp directory.
Stream parser, protocol and helper diagnostic callbacks preserve their first exception as an
awaited gate rejection. The owning finally still abandons private capabilities and waits only
its direct helpers; diagnostic logging failures cannot skip that cleanup. Portable tests throw
from actual output/decoder/event callbacks and require rejected waits plus owned cleanup.
No taskkill/PID scan is proof. Fixture handle witnesses and Job accounting are separate
assertions. A successful future protocol test is not a native-tree/packaging claim.

Official API contracts used:

- https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-updateprocthreadattribute
- https://learn.microsoft.com/en-us/windows/win32/api/jobapi2/nf-jobapi2-queryinformationjobobject
- https://learn.microsoft.com/en-us/cpp/c-runtime-library/reference/get-osfhandle

Remaining activation gates include pending/create-stall races, slow control
reader and bounded writer fallback, concurrent earlier-deadline Stop, handle exhaustion,
parent Job restrictions, exact packaged x64/ARM64 fd inheritance, and PR4b/c generation-
fenced consumer cleanup. No Linux implementation is included; existing behavior is
untouched and its accepted PR4 Unix gates remain mandatory before activation.
