# PR #982 — native coordination fixture model identity repair

Status: independently reviewed and approved; published before the one-file implementation.
Baseline: 6082d89e04bdd91cf7fdb97514c705e7ccc95b1c, 2026-11-28.
Owner: root. This changes one existing TEST fixture only.

## Reproduced failure

The official Linux Stage 1 job 140856887994 in run 46105391457 completed the original native coordination proof and cleanup, but its subsequent original runtime.open returned hold before launch allocation. A clean local build at 50a32653326cf558a2a27e31a68dfdbcf8518634 reproduced that failure in 23.726 seconds.

An isolated diagnostic-only commit 5c022ac3bbdf93e3dc7d2a042061d5946dbff04b repeated the actual native case and recorded only the exception class, fixed result code and source stack. It identified the model/identity guard in readPreparedModelReference, called from attachInitialRuntimeModelAdmission. The receipt was completed, successful and released; the business launch remained unclaimed. No diagnostics changed an admission predicate. That local commit will not be published.

The original TEST profile selected provider TEST-local and native model TEST-model-B. Its original persisted probe instead carried modelId TEST-local/TEST-model-B. The fixture in tests/fixtures/native-opencode-team/coordination-probe.ts supplied that extra public prefix. Current private Team producers retain the native model ID unchanged in the original receipt. The exact sameCapturedModel guard correctly rejects the different retained spelling. Actual native ordinary execution used TEST-model-B; this mismatch belongs to the fixture's admitted input.

## Exact change

Only packages/legacy-agent-host/tests/fixtures/native-opencode-team/coordination-probe.ts:

- Keep providerId and modelId separate when building the original ModelProbeInput: modelId is member.model.
- Assert that this fixture's concrete model does not itself begin with providerId + '/'. The direct startNativeReadiness boundary accepts public aliases; this simple TEST fixture must not accidentally claim coverage of nested native IDs that require the existing production prepareTeamProbe adapter.
- After reading the actual completed original receipt, require saved.providerId, saved.modelId and saved.effort to equal the original member selection. Keep the existing actual ordinary-model and effort assertions.
- Preserve the single original invocation, native compound proof, original scope/cutoff, management receipt bytes, profile hashing, lease, release, model-request count and cleanup assertions.

Do not change production acceptance, native model normalization, provider archives, dependencies, pins, workflow timeouts, credentials, or generic error handling. The exact protected source/model guards remain authoritative. Do not accept both model spellings as interchangeable at replay.

## Verification and integration

1. Preserve the existing genuine RED native receipt and diagnostic stack as local diagnostic evidence.
2. Apply the one-file fixture change after this plan is reviewed and published.
3. Run the existing strict Host build and test-type check on a clean isolated source commit.
4. Run the existing actual Linux embedded-host native test with the same verified Bun 1.3.11, OpenCode 2.1.4 graph, runtime 0.0.161, source census and Node 24.21.0. It must complete the business tool/MCP/approval/cold-resume assertions as well as coordination and cleanup. A later failure remains an unresolved failure and must be diagnosed.
5. Review the exact diff again, retain a normal local commit/checkpoint, and publish with compare-and-swap against the then-current PR head. Preserve parallel work.
6. Observe the next ordinary Stage 1 CI result; no manual rerun/dispatch or fabricated qualification. Source-only Linux success does not claim other platform, packaged desktop or release qualification.

No synthetic unit test that merely mirrors the assignment is added. The existing native test is the regression: it currently fails at the original receipt-to-business admission join and must pass without relaxing that join. Existing nested-model production tests continue to cover the broader native identity contract.

## Review

R1: root inspected the actual persisted profile/receipt, production producers and refusal stack.

R2: provider_team_parity independently inspected the full plan, fixture, ModelProbeOwner, ProviderModelProbePreparation and sameCapturedModel guard and approved the exact change.

R3: root repeated the original-admission, public/native boundary and regression-gate review. The explicit fixture restriction keeps nested native ID handling with its existing production adapter; no broader acceptance change is necessary.
