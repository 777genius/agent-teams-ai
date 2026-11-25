# Windows readiness: bounded original-call attribution

## Observed gap and scope

Continue P09's original Windows readiness investigation without changing its admission or acceptance contract. The content base is `af14a3a040bd464872d3484a36a4ef2e5fc86b76` (tree `c3d95cc2314de9e6b2a334372fb1b2ef757745e2`); the selected C8 journey and all preceding changes remain.

The original B852 Windows x64 [job 133260431137](https://github.com/777genius/agent-teams-ai/actions/runs/43856040134/job/133260431137) refused OpenCode Team A at its unchanged 15-second readiness boundary. Its retained first-refusal record contains 17 synchronous consumer-current calls, 10,122 ms total, 643 ms maximum and 555 ms last, with no truncation. These totals do not identify which existing operation consumed the time. No performance improvement or readiness fix is claimed.

## Selected implementation and review

Add optional fixed count/duration spans around the same existing initial authority, read-consumer, prepared-reference and final authority operations. Measure only when the existing private TEST diagnostic has a subscriber, no refusal has latched, and the original 4,096-call limit admits the call. Preserve the original operation order, nested authority checks, source/account reads, Date.now calls, thrown business Error, first-refusal latch, consumption and deadlines. No extra native operation, read, retry, cache or positive freshness result is introduced.

The four original diagnostic source/test files retain their reviewed complete preimages: `prepareTeamModelReadiness.ts` (`08552af7`), `saved-team-model-probe.test.ts` (`6a668dae`), `nativeEmulatedSourceProfile.ts` (`ae066b7c`) and `nativeEmulatedSourceScenario.ts` (`dd1e8cd2`). Add only three missing operands to the current C8 scoped-lint list (103 → 106), retaining the whole C8 workflow and the original ten Runtime tests and full type/lint scopes.

Both existing readers accept the previous exact diagnostic shape and validate the optional eight-field span record as closed bounded numeric data. Span durations are not an exhaustive partition of the whole call. Measurement has overhead inside the unchanged budget; invalid measurements mark the existing truncation flag. The existing saved-team-model test instruments actual retained calls, checks partial-throw accounting and exact Error identity, and verifies fresh consumption without diagnostic clocks after unsubscribe.

Estimated change: 82 net lines across five existing paths, including 31 test lines. Producer 739 lines and Scenario 800 lines remain within their selected caps. Complexity 3/10; source confidence 8/10. Independent source review confirms preservation of the original authority/error paths. Compiler and runtime qualification on the resulting source remain required.

## Required original validation

Use the unchanged Process workflow's original Host build, Host test compiler, dedicated retained-host reader compiler and complete 18-file contract command, which already executes the amended saved-team-model test. Keep the existing Team full workspace/dedicated type checks, complete typed lint and MCP lint. No replacement command, extra absent-field RED cycle, extra workflow, timeout increase, action replay or acceptance relaxation is selected.

Inspect any resulting original Windows refusal spans together with their exact source, native inputs and deadline. Missing span evidence is not a cause, and passing diagnostics alone is not native acceptance. The separate ARM post-open readiness, packaged Windows Retry/Stop and Darwin selected-byte boundaries remain unresolved until their original checks succeed or an explicit contract decision is made.
