# Team read recovery

The renderer entrypoint owns the messages-head handoff behind an older-page read. A queued caller observes the head read actually performed. If the older page detects a changed feed, it releases older ownership and starts that same queued head before awaiting it, avoiding a self-wait cycle. Settlement retires only the matching queue record.

The handoff preserves existing store projections, error behavior and context/team epoch guards. Recovery transport is described below; deferred retry credit and worker admission policy remain separate accepted-plan work.

The contracts/main/preload/renderer entrypoints carry validated plain worker failure metadata over the existing four read channels. Worker cooldown owns the recovery ID and retryAt; raw read results are optional and legacy/browser APIs retain their signatures and behavior. Recovering, busy, fatal and disposed worker outcomes stop heavy-main fallback on all five worker-consuming paths. Renderer-local errors retain human message and validated metadata through unwrapIpc. This transport checkpoint does not schedule retries, add admission numbers or change TaskChange worker lifecycle policy.

`core/application/TeamDataReadWork.ts` owns live full/thin retrievals, refresh tokens and queued/fresh flags in the captured context and team scope. A different scope starts its own retrieval; a late release or queue cleanup cannot remove replacement ownership. The renderer store captures scope before physical joins and checks automatic-poll admission through the live store getter. Empty work owners are pruned, and completed snapshots remain in the store.

This data-scope checkpoint preserves thin selection followed by post-paint full enrichment, the queued enrichment's early acknowledgement, force-fresh bypass and the legacy full-refresh completion contract. It does not yet provide an observable full-data fresh successor, immediate connection/subscriber disposal or cooldown/retry scheduling.
