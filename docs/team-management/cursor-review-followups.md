# Cursor review follow-up, 2026-09-08

The owner explicitly deferred non-critical findings to prioritize release preparation. Independent hosted review of frontend 504f6f60f and orchestrator 2f92ae2e established no new release blocker. Orchestrator review was bounded and does not replace the prior independent reviews and native qualification.

## P2: recover a dead owner of the development bootstrap lock

`ensureBootstrappedRuntime` now correctly validates and executes cached runtime versions under `.bootstrap.lock`. However, abrupt termination leaves its empty exclusive-create lock behind. Subsequent development launches wait 120 seconds and fail even with an intact warm payload. Before this change, a valid warm cache returned before lock acquisition. Packaged native team launch and Stop are not shown affected.

Keep cache validation/version execution under the lock. Add ownership metadata and verified dead-owner recovery with serialized reclamation, or use a suitable existing owner-aware lock. Do not unlink merely by age or move execution outside the lock. Required regressions: dead-owner recovery returns a valid cache without download; live owner blocks execution; simultaneous reclaimers cannot both publish.

Independent offline negative control compared actual base and current bootstrap functions against a valid fixture payload plus abandoned lock: base returns the cache, current code times out. Nine bounded cache/ledger/policy tests passed. The reviewer used a virtual clock and did not run the native runtime. A configured explicit runtime path is a development workaround; no automatic deletion of user cache locks was performed.

Full reports were retained by the owner session under /tmp/cursor-review-20260908/INDEPENDENT_FRONTEND_REVIEW.md and INDEPENDENT_ORCHESTRATOR_REVIEW.md.
