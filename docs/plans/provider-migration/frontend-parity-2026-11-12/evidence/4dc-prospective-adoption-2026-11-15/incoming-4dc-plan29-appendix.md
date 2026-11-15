
## Original Windows service-pair failure localization — 15 November 2026

### R1: observed failure and bounded correction

Exact source `a02ab70edfdcb4169627e804f0337c9ad6b52af6` fails the original
Windows process fixture at `debug-service / child-lines` on both
[x64 job132959932736](https://github.com/777genius/agent-teams-ai/actions/runs/43762390679/job/132959932736)
and [ARM64 job132959932738](https://github.com/777genius/agent-teams-ai/actions/runs/43762390679/job/132959932738).
The preceding cancellation scenario completes. The retained broker target output
has ended before the unchanged ten-second readiness deadline, but its original
exit payload and the new fixture prerequisite outcomes are not retained in the
failure log. Cleanup subsequently triggers the broker-exit callback assertion;
the final event wait replaces the directly thrown readiness timeout. The
independent outer controller drains with rootExitCode1 and zero active processes.
This is failed qualification, and does not localize a production exception policy.

Keep the correction in three existing TEST files:

- `tools/owned-process-broker/nativeFixture.cpp`: separate the existing service-pair
  prerequisites in their original order. On their first failure emit one bounded
  fixed-key JSON record to existing stdout, with a closed numeric stage and an
  already-observed numeric result where applicable. Preserve original return62/63,
  short circuits, API calls, five-second waits, handle closes, CREATE_NEW publication
  and eighty-child churn. In `wow64Startup`, retain the existing query, architecture,
  wait, exit and publication results without repeating calls. Missing/unreached
  observations are not represented as successful zero results.
- `tools/owned-process-broker/nativeDebugServiceScenario.ts`: only when the existing
  child-lines wait fails, project its already-held rootExit payload, observed
  root/child counts, the two fixed success-marker booleans and the validated closed
  prerequisite record. Never forward raw stdout/stderr, paths or environment.
  Rethrow the original failure; no extra process query, action, retry or wait.
- `tools/owned-process-broker/nativeGate.ts`: register the original caught scenario
  error through the existing event guard before diagnostics and cleanup callbacks.
  The original helper cleanup is still awaited independently. This prevents its
  later callback assertion from replacing that error; a separate cleanup timeout
  remains failure and is not represented as successful cleanup.

Estimate: 60–100 changed TEST lines, zero product lines; complexity3/10,
reliability8/10, confidence8/10 for localization, no product-fix claim.
Root source review and independent qualification audit agree that the current
logs do not justify changing startup breakpoint acceptance or deadlines.
Independent P09 reviewer additionally required carrying the closed C++ record
through the existing stdout collector, preserving short-circuit reachability,
and latching the caught error before any diagnostic callback.

After source application, independently review the exact diff; run the existing
event/output/context helper suites, original scripts compiler, scoped lint and
source-size guard. Await both original resulting-source Windows jobs. The
result must determine the next correction; this diagnostic cut itself cannot
qualify P08/P09. No source oracle, provider invocation policy, workflow selection,
Draft/base, main, release or activation change is included.

### Exact source review and local checks

Independent reviewer `/root/p09_review` accepted the three-file diff over
published plan `3957f2b28417647578d71a465cd61d4e09b5deb9`: nativeFixture
`579a7aadf70a284cb44f7ec3690dab32c4d76e92`, scenario
`f8eb84e20fb323e5838b918a7934853785ab9ee5`, nativeGate
`17f5e7b66605bd4d28cf3935b7fa73ea2933a21d` (the final source tree is authoritative).
The existing owned-process helper suite passed53/53 with no skips; scoped
TypeScript7.0.2 and the complete legacy-host-scripts compiler, focused lint, source-size and diff checks passed.
The full-workspace typecheck was terminated with code137, including a separate
memory-bounded invocation; neither is a PASS. Both actual Windows native runs
remain required, and no product fix or P08/P09 acceptance is asserted.
