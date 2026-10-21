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
