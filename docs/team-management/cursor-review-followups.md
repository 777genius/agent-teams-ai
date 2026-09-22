# Cursor review follow-up, 2026-09-08

The owner explicitly deferred non-critical findings to prioritize release preparation. Independent hosted review of frontend 504f6f60f and orchestrator 2f92ae2e established no new release blocker. Orchestrator review was bounded and does not replace the prior independent reviews and native qualification.

## P2: recover a dead owner of the development bootstrap lock

`ensureBootstrappedRuntime` now correctly validates and executes cached runtime versions under `.bootstrap.lock`. However, abrupt termination leaves its empty exclusive-create lock behind. Subsequent development launches wait 120 seconds and fail even with an intact warm payload. Before this change, a valid warm cache returned before lock acquisition. Packaged native team launch and Stop are not shown affected.

Keep cache validation/version execution under the lock. Add ownership metadata and verified dead-owner recovery with serialized reclamation, or use a suitable existing owner-aware lock. Do not unlink merely by age or move execution outside the lock. Required regressions: dead-owner recovery returns a valid cache without download; live owner blocks execution; simultaneous reclaimers cannot both publish.

Independent offline negative control compared actual base and current bootstrap functions against a valid fixture payload plus abandoned lock: base returns the cache, current code times out. Nine bounded cache/ledger/policy tests passed. The reviewer used a virtual clock and did not run the native runtime. A configured explicit runtime path is a development workaround; no automatic deletion of user cache locks was performed.

Full reports were retained by the owner session under /tmp/cursor-review-20260908/INDEPENDENT_FRONTEND_REVIEW.md and INDEPENDENT_ORCHESTRATOR_REVIEW.md.

## P2: observe accepted Cursor messages without preparing the profile again

The four-provider sandbox run `mixed-four-e2e-0908` (`ecf81fce-d2a3-4f65-8e42-353f6fa1201d`) completed Astra -> SuperGrok -> Z AI -> Cursor -> Astra, all five tasks, four provider files and the final ACK. Runtime source was `847aea485640b8dc5579656eec081dd660bb764a` (v0.0.87), frontend `87d3901ff14dd5714d46f73ce39be087d6cedced`. Anthropic was explicitly skipped because its account quota was exhausted.

Cursor delivery observation reported terminal timeouts despite accepted prompts continuing and completing. Existing-session observation enters full scope/profile preparation, including native status checks, inside a 20-second host_start deadline. The session also recorded managed_config_changed:mcp,provider. The exact operation consuming the deadline remains unproven. Do not replay accepted prompts based on this diagnostic alone.

Follow-up: observe the existing owned session without preparing or creating a host, preserving team/run/session/PID identity checks. Report configuration changes separately. Regressions should cover slow native status with a responsive existing endpoint, no new host, and no repeated accepted prompt.

SuperGrok initially hit a held file lock before provider dispatch, then a strict scope mismatch during recovery. A narrow retry succeeded. The precise lock owner was not established; credential rotation is a hypothesis, not a confirmed cause. Strict authority checks remain unchanged.

Local evidence: `/tmp/mixed-five-e2e-20260908/evidence/four-provider-proof.json`. The owned test team was stopped after completion.
