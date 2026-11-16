# Original 75cf Linux native failure — independent R1

**The first failure is explicit cancellation of the third no-tool model probe, not the earlier 3be credentials timeout. No concrete runtime repair is established.**

## Exact original evidence

Repository 777genius/agent-teams-ai, head 75cf2dcbfe2b540325ea50a022cb5195306a8c59; run 43959134948; job 133621512488. Original artifact 14277621511 is 12,696 bytes with SHA256 eb596b99c0cc19e246c3070a89f7d87195db78d9a83c26a5a38d84ba63860635. Its four JSON members match the retained extracted bytes and pass ZIP CRC/path checks. The corrected original decoded job log is 94,683 bytes, SHA256 54d0d1a7240bf9ad96792fc940fc0017d078417f97d2105bbdf2f14473068f77.

The first assertion is opencode-v2-model-probe.native.ts:328: the original management.probe.cancel reply has phase held, expected cancelled. The cleanup assertion then reports original Host exit 1, expected 0. Those are the two errors in the original aggregate. This was an assertion failure after 35.45 seconds, with zero test-runner cancellations. The original 240-second test limit and 60-second model-probe profile budget are unchanged.

The failure summary's unknownProbeCancelled=false refers to a later, unreached unknown-variant case. It does not negate the explicit third cancellation recorded by this first assertion. Catalog never started.

## Confirmed scope and cleanup

The preceding embedded Linux manual Host journey passed its seven original steps: eleven business model calls, two successful inputs, two resolved permission interactions, cold history restore and two original Host exits 0. Its separately counted coordination proof completed and released ownership after four model calls and one metadata call. The model-probe step itself retains only its first two completed no-tool cases and three actual model requests.

All three probe-native children have original exit-0/no-signal events. The original finally also checks all three recorded process groups absent; no such assertion appears in the exact two-error aggregate. This is not complete provider cleanup: the management Host exits 1, the receipt remains INCOMPLETE/cleanup=false, and the sandbox-removal condition is not met. The third per-case namespace and replay checks are unreached. ModelProbeOwner intentionally retains held/resourceHeld debt when native.close cannot confirm cleanup.

The independent always-run POSIX receipt is PASS_NATIVE_FIXTURE_ONLY with eight observations and cleanup=true. Product, installed runtime, custom executable and script qualifications remain false. Credential, permission, external-MCP and final management validators following the failed model-probe step were not reached.

## What the uncapped trace adds

All 237 original rows are retained with no trace-limit event. At 32,361 ms the first retained read-cut failure is before-log / cleanup_unknown (340 ms), with its own deadlineExpired=false and aborted=false. The third child exits 0 at 32,440 ms; at 32,442 ms the close diagnostic is driver-close / unconfirmed, runState=threw, outcome=unobserved, errorClass=unknown.

The exact c930 archive matches the receipt provider digest. Reading that code narrows the raw cleanup_unknown to the underlying execution response/reader custody path. It still does not distinguish reader acquisition, error-path body/reader cancellation, or reader lock release. A network response-end event does not prove these caller-side operations succeeded. The inner read-cut flags do not independently observe the app's combined outer fetch signal.

The old 3be failure was a later credentials journey, third Host epoch, after-log / transport_failure, with a saturated trace. No old credential success, cause or repair transfers to this different failure.

## Existing prospective observation design

The existing unselected two-producer/two-app/three-test design can separately reveal the first app close-entry outer snapshot, first sticky cleanupUnknown transition and unsuccessful driver.close stage. On this explicit-cancel path, ModelProbeOwner already aborts its entry before invoking native.close, so an outer-aborted snapshot is expected and is not first-cause proof.

That design still does not expose the particular ExecutionTransport reader/catch branch. It must not be described as guaranteed complete causal attribution for this new leaf. No extra source inventory, producer change or archive adoption is selected here. Current c930/SPI pins, original cleanup assertions, timers and no-replay behavior remain unchanged. Existing caps/reservations, default-off behavior, V1 preservation and containment by the TEST subscriber remain mandatory if a later observation is selected.

The JSON report binds all reviewed source/archive bytes and records 68 inert checks. No repository code, tests, compiler, providers or GUI ran; no artifact was downloaded again, and no CI or remote state was changed.
