# Agent backend: P1 host transport

`main/index.ts` exposes the captured Node child client and its trusted profile.
Create the client before awaiting `start()` so app shutdown can seal pending startup.
`shutdown()` observes only that captured child; confirmed child exit makes no claim
about provider children or durable obligations. There is no automatic restart,
fallback, cancellation, or request replay.

`contracts/index.ts` contains browser-safe failure classifications. Native profile
paths, hashes, credentials, and the RPC client remain main-owned. Notifications are
bounded and pulled with an explicit gap indicator; consumers must rehydrate on gap.

This walking slice does not implement Team APIs, IPC/UI cutover, provider sessions,
single-writer storage admission, or recovery of native custody. Those remain with
the host owner and subsequent migration phases.

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
a shell-supplied authorization callback using captured IPC sender or authenticated
HTTP context, then defer current business/runtime grants to the host. Raw errors and
private host receipt/config fields are projected out of responses. The initial
Task DTO covers the exposed operations; this is not yet the complete review/feed/
attachment UI contract. Existing app-shell registration, preload/HTTP clients and
workflow cutover remain unwired until the shell integration is reviewed.

Public `preload/index.ts` exports `createAgentBackendBridge(ipcRenderer)` for the
`electronAPI.agentBackend` namespace. Public `renderer/index.ts` exports
`createAgentBackendHttpClient((route, body) => existingHttpClientPost(route, body))`
for the same `AgentBackendApi`. Neither adapter creates IDs, retries requests,
selects a backend or translates transport loss into rejection. The HTTP adapter
uses the app's existing transport policy and has no renderer dependency on IPC.
`AgentBackendElectronApi` is the shared app API fragment for both implementations.

The shell must still install these adapters into the existing unified app API and
register the finite input handlers against trusted main composition. IPC sender
validation and sender/context-to-handle grants are required; handle existence alone
is not authorization. The current loopback HTTP server does not supply an
authenticated context, so its authorization callback must remain denying until a
trusted context is explicitly captured. No raw public backend configuration or
automatic legacy routing is exposed to solve this seam.
