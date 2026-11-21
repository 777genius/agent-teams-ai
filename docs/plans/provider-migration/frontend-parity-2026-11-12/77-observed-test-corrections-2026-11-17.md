# 77. Correct the two observed TEST failures on the integrated parity head

## Selection and evidence

This is a bounded continuation of Plans 73 and 75 on `5c55a4a2008f4a6131d265344d384b39415ad055` (tree `c8a560d3ac23a5e17c45ad8b0f0aec299eaa163d`). It selects exactly two existing TEST source lines. It adds no product feature, decoder, provider, workflow, dependency or acceptance route.

The original Windows ARM64 Process job [133788424969](https://github.com/777genius/agent-teams-ai/actions/runs/44008164538/job/133788424969) failed the existing build step with `TS2339` at `nativeEmulatedOwnerLossScenario.ts:361:54`. Its full log SHA256 is `9d0b764aeecdf663acac9626ee3efe384050feef02b8e18772d7f59cf92a9543`. The native scenarios were not reached; the sole archived member is the original source-head file.

The original finite Claude Desktop job [133788425778](https://github.com/777genius/agent-teams-ai/actions/runs/44008164473/job/133788425778) failed the unchanged 90-second preflight wait before its Launch click. Its receipt SHA256 is `ba63cb192b689d3656c707be8f830b666580ccb4ddba8280d3d1417b1fe3840b`; the retained DOM and screenshot show `Model "sonnet" is not available` and a disabled Launch button. The fixture saved `sonnet`, while the unchanged SDK catalog producer exposes the finite peer's resolved `TEST-claude-sonnet` as the launch value. The receipt also shows catalog-refresh/runtime-unavailable messages; this correction does not establish that every cause of the incomplete preflight is resolved.

## Exact source cut

1. In `tools/owned-process-broker/nativeEmulatedOwnerLossScenario.ts`, current blob `8fb3cb0f34230df7849fe5efa23dddf1f39db191`, delete only `if (opened.state !== 'fulfilled') throw opened.error;` immediately after the existing `assert.equal(opened.state, 'fulfilled')`. Keep that assertion and the following native-ready assertion unchanged. The assertion already throws on rejection and narrows the union; the removed branch is unreachable. Do not reorder rejection handling, change the accepted state, cast the value, or change the original W05 actions, counters, failure receipt, clocks or cleanup.
2. In `scripts/legacy-agent-host/desktop-emulated-runtime-fixture.ts`, current blob `a9d725fbe11278dd98611b49d570c19d80684087`, replace only the Claude arm of the existing model constant: `provider === 'claude' ? 'sonnet' : 'TEST-model'` becomes `provider === 'claude' ? 'TEST-claude-sonnet' : 'TEST-model'`. The existing constant continues to supply saved launch settings, the member/template and the seeded legacy schedule. Preserve the other providers, finite peer, all permission/effort values, selectors, assertions, routes, budgets and cleanup. The peer already accepts this exact model; no alias or provider behavior is added.

Both paths are already in the selected proof rosters. No roster, workflow, source-size baseline or production source change is selected. Existing callers consume the fixture's saved model; any discovered coupled literal conflict must be resolved in prospective review before publication, not silently added to this cut.

## Review, publication and qualification

Review this plan and its bound R1 independently, publish the exact documentary files to the existing delivery branch with ordinary expected-parent CAS, and close the complete published-document readback before creating source afterimages. Independently review the two exact source deltas and their strict forward/inverse and unchanged-file proofs; then publish immediately with ordinary CAS and verify the complete official source readback. Every unrelated byte and incoming change remains preserved.

The existing original workspace/Host/broker types, lint, tests and applicable Desktop/native/packaged scenarios remain the execution gates, only in CI. Do not add a test that merely restates these literals, a local execution, a separate RED cycle, a rerun/dispatch, a timeout extension or a weaker oracle. The future coherent head must supply its own original results and cleanup; source review and the old receipt do not predict PASS.

Keep the primary PR head at the current source while useful original jobs are active. A later primary fast-forward requires the existing fresh complete ref/PR/CI guard. Preserve Draft PR1192, its base, all genuine-provider restrictions, the P10 historical-input hold and the unselected Plan40 writer-contract decision. No Ready, merge, release, default activation or Stage2 is selected.
