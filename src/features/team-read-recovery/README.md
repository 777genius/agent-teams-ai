# Team read recovery

The renderer entrypoint owns the messages-head handoff behind an older-page read. A queued caller observes the head read actually performed. If the older page detects a changed feed, it releases older ownership and starts that same queued head before awaiting it, avoiding a self-wait cycle. Settlement retires only the matching queue record.

This bounded checkpoint preserves existing store projections, error behavior and context/team epoch guards. It does not add typed cross-process recovery metadata, deferred retry credit or worker admission policy; those remain separate accepted-plan work.

The contracts/main/preload/renderer entrypoints carry validated plain worker failure metadata over the existing four read channels. Worker cooldown owns the recovery ID and retryAt; raw read results are optional and legacy/browser APIs retain their signatures and behavior. Recovering, busy, fatal and disposed worker outcomes stop heavy-main fallback on all five worker-consuming paths. Renderer-local errors retain human message and validated metadata through unwrapIpc. This transport checkpoint does not schedule retries, add admission numbers or change TaskChange worker lifecycle policy.
