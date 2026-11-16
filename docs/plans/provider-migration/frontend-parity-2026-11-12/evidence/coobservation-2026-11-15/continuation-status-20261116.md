# Frontend parity continuation — 16 November 2026

## State of the work

End-to-end parity is **not complete**. The original frozen CI cohort has retained failures and unfinished routes. The new conversation-readiness regression is published as tests only; its actual RED has not run because the local execution service reported **no usable execution environment**.

The latest published source is [c5ff4fc283e58d486c58147b4dfb00144ca10d34](https://github.com/777genius/agent-teams-ai/commit/c5ff4fc283e58d486c58147b4dfb00144ca10d34). The test file preserves all 78 previous cases and adds 19 actual-source regressions. Both UI producers remain unchanged. Every created commit was immediately pushed with an exact expected-head lease.

The original CI results below qualify only [E: 3e41e39b101ccc06bb24203be245ac55dcf1502f](https://github.com/777genius/agent-teams-ai/commit/3e41e39b101ccc06bb24203be245ac55dcf1502f), tree `6addcdaf71094340d366dc8a97258d68aaa7a47b`, PR1213's original opened event and attempt 1. They do not qualify the later test append.

## Confirmed original gates

| Gate | Actual retained result | Evidence |
| --- | --- | --- |
| Four frontend shards | 25,836 PASS / 38 SKIP; 2,155 files PASS / 7 SKIP. Original live/native exclusions remain. | [Host part 1](pr1213-host-01-20261116.json) |
| Team Runtime contracts | 184 / 184 PASS, plus the original shared 168 / 168 and helper 7 / 7. | [Host part 3](pr1213-host-03-20261116.json) |
| Whole workspace and Host/MCP types | Actual `pnpm typecheck:workspace`, whole Host TEST configuration, MCP source/test types and the separate backend-test compiler passed on E. | [Host part 3](pr1213-host-03-20261116.json) |
| Host Team typed lint | 0 errors; all 6,241 warnings retained. No warning-baseline comparison is claimed. | [Host part 3](pr1213-host-03-20261116.json) |
| Teams creation GUI | Windows x64, macOS ARM64 and Linux x64 all passed their original 12-case prerequisites, GUI and verifier. | [Part 1](pr1213-teams-01-20261116.json), [part 2](pr1213-teams-02-20261116.json) |
| Process matrix | Completed: 3 successful jobs / 2 Windows failures. Linux reports 403 PASS; both Darwin jobs succeeded in their original scopes. | [Original run](https://github.com/777genius/agent-teams-ai/actions/runs/43834444719) |
| Stage1 matrix | Completed: 7 successful jobs / 2 Darwin P09 failures. | [Original run](https://github.com/777genius/agent-teams-ai/actions/runs/43834444738) |
| Embedded Linux credential gate | Passed unchanged, with four Host epochs, cleanup and cold recovery. Historical M failure remains separately retained. | [Linux Stage1](pr1213-process-stage1-08-20261116.json) |
| Native SPI / HTTP / V1 compatibility | Original scoped gates succeeded with their explicit skips and false broader-qualification flags. SPI permits strict HOLD or effect-confirmed; its uninspected artifact outcome is not inferred. | [SPI](pr1213-process-stage1-10-20261116.json), [HTTP](pr1213-process-stage1-09-20261116.json), [V1](pr1213-process-stage1-11-20261116.json) |

Raw/upload/API joins are not represented as ZIP/member/receipt/image inspection. Earlier actual root archive checks are attributed separately inside the retained evidence. No archive download occurred during this unavailable-environment continuation.

## Original failures and remaining routes

| Boundary | Retained failure or remaining work |
| --- | --- |
| Installer, macOS ARM64 | The selected conversation button moved from y=178 to y=186.5 at the original final geometry guard. No press/release followed that refusal. |
| Cross-team, Linux x64 | The original Task detail Close button failed the final geometry guard after banner absence, canonical clarification absence and an awaited terminal receipt. That receipt may be completed or rejected; its actual phase has not been read. Later Review, notifications, cross-Team and oversized-comment stages were unreached. This is a separate path from the conversation-preview regression. |
| Process Windows ARM64 | Original Codex A/B readiness exhausted its 15-second budget before native readiness. |
| Process Windows x64 | Original OpenCode A/B readiness exhausted its 15-second budget; retained held/open-unknown observations do not prove a cause. |
| Darwin strict P09 | x64 baseline image witness refused with errno 13; ARM64 resumed A markers where the strict oracle requires empty output after mutation. The oracle remains unchanged. |
| Packaged Windows x64 | The original 10-second Retry phase expired in the later same-process-reference ownership/census guard. An earlier ready sample was non-atomic with the refusal. |
| Packaged Windows ARM64 | The original 10-second Refresh phase expired at the final owner check before physical input. Retry was unreached; later emergency cleanup is not normal product cleanup. |
| P11 / genuine M16 | Native live-membership and genuine donor/old-owner migration qualification remain open. E's prerequisite type gate is closed, but neither later journey was selected or executed here. |

At the retained **11:04:53 UTC snapshot**, all **22 Host execution jobs** are terminal: **20 successes and 2 failures**. Their complete original logs are retained across [parts 1](pr1213-host-01-20261116.json), [2](pr1213-host-02-20261116.json), [3](pr1213-host-03-20261116.json) and [4](pr1213-host-04-20261116.json). The later separate aggregate job133252049135 failed its original matrix-result gate; the whole Host workflow is FAILURE. This consequent aggregate failure is not a third product-flow failure; [part 5](pr1213-host-05-20261116.json) retains its complete terminal evidence. Native OpenCode V2 Settings passed its actual specialized verifier, with five finite localhost model intents, five probes/screenshots and nativeRemaining=0; general verifier step30 was skipped and is not promoted. Packaged Darwin ARM64 succeeded, both Windows jobs failed, and Darwin x64/Linux remain active. General subsequently completed with [FAILURE at its original Draft policy gate](pr1213-owned-05-20261116.json): `Draft feedback does not qualify for merge`. Its plan and [Fast feedback](pr1213-owned-04-20261116.json) passed separately; Fast feedback retained 118 policy passes, actual workspace/Host TEST/MCP types and fast lint with 0 errors/218 warnings. All 12 conditional skips remain skips. The original Announcements workflow passed; CodeQL and Sentry remained skipped. The full non-atomic API snapshots are preserved in the [retention index](pr1213-terminal-retention-index-20261116.json).

## Concrete next step: the published conversation regression

The prospective scope is published in [f3fb3ead](https://github.com/777genius/agent-teams-ai/commit/f3fb3ead0315508901531e8f54b75f21518492a7). The full test-only publication, its 409-line runner, complete source/dependency/tool census and exact [RED binding](ui-conversation-red-binding.json) passed independent byte-level review. Complete actual publication readbacks preceded the binding.

The new cases exercise the actual `ui.click`, its generated DOM expression and the real `openChat` helper. They cover delayed selected-row readiness, body/neighbor decoys, duplicate rows, missing/empty/disabled/covered controls, literal escaping, a revoked final marker and retained owner/geometry refusals. Four cases check boot/partial forwarding for ordinary and lead names.

A bounded [existing-route review](ui-conversation-existing-route-feasibility.json) checked all 42 unchanged workflows. The Host route runs eight files after different fresh CI install/build inputs and fails before the later evidence/cleanup steps on expected RED. The separate CI route is Draft guarded and includes fixed native matrices. Neither invokes the exact reviewed runner or preserves its pinned input and captured-cleanup contract. No drop-in route or alternate runtime was selected.

The same qualified environment must first become available. Then use the exact reviewed runner and binding for one whole-file RED, preserving all 78 original passes and all 97 cases. Actual semantic failure, complete raw/receipt/input preservation and captured cleanup need independent acceptance **before authoring or selecting either producer**. Subsequent producer R2/publication/readback, one GREEN and three scoped guards remain gated. All five new execution budgets are unused. No substitute runtime, expanded timeout or replay is selected.

The Driver.close diagnostic proposal remains dormant because the current unchanged Linux credential gate passed. Its earlier bare D test candidate is unselected; no diagnostic producer, runner, export, install or execution occurred.

## Retention and source boundaries

The [machine-readable index](pr1213-terminal-retention-index-20261116.json) binds 23 complete terminal evidence packages (190 complete outer payload instances), original body identity, current API snapshot, test publication readback and RED input. Source and workflow trees are unchanged by this documentary checkpoint.

A fresh read of delivery [PR1192](https://github.com/777genius/agent-teams-ai/pull/1192) still resolved to `72e6ec04444969d343d73834c70bc4e261100fc9`; provider [PR8](https://github.com/agent-teams-ai/old-provider-implementations/pull/8) still resolved to `c79b81bf002eaac95436da71c7049d7f309906a9`. Neither branch was modified here.

Frozen PR1206/1207/1208/1211/1212/1213, their original runs and all 42 workflows remain unchanged. No main/default merge, Ready, release, default activation or Stage2 action was selected. Real Claude/Codex commands, including version probes, were not invoked.

## Later original Packaged result — 11:25:57 UTC snapshot

The original [Darwin x64 packaged job](https://github.com/777genius/agent-teams-ai/actions/runs/43834444828/job/133212588425) completed successfully at 11:21:10 UTC. Its complete [late terminal record](pr1213-owned-06-20261116.json) preserves the raw log, job/run/artifact APIs and the exact original workflow and qualification sources. The earlier Darwin x64 active observation above remains a historical snapshot.

The job passed the actual packaged V2 Host tools/MCP/Stop/cold Resume route and the separate finite SDK macOS app-relaunch route. Its capture tests report 25 PASS and one Windows-only SKIP. The V2 output reports cleanup and source/bundle restoration, while desktopJourneyQualified, vendorAuthQualified and releaseQualified remain false. The artifact upload and API agree on ID14220497882, 798186 bytes and SHA256 b4b06487be126cdee00f89a227478bf4db0142dfe66c76cc21710f40690c0da6; the ZIP, members, artifact receipts and images have not been independently inspected during the environment outage.

At this later snapshot, the five Packaged platform jobs are two successful Darwin jobs, two failed Windows jobs and one Linux job still running. The classifier passed separately. This does not close either Windows failure or the overall end-to-end task. These results still qualify only frozen E; the 97-case conversation file remains unexecuted and neither UI producer has changed.

## Latest retained Linux and aggregate state — 16 November 2026

The original Linux packaged job133212588426 completed SUCCESS at11:42:05UTC. [Its complete late evidence](pr1213-owned-07-20261116.json) retains actual managed Git11PASS, bundled-undici2PASS, capture25PASS/1Windows-onlySKIP, scoped compilers, all four unsigned Linux targets and the original packaged V2 PASS. The printed V2 receipt reports cleanup, nativeExit0 and restoration of checkout, bundle and legacy runtime. Its Desktop/vendor/release qualification flags remain false; archive contents and images for that Linux packaged job have not been inspected in this continuation.

All five Packaged platform jobs are now terminal: Linux and both Darwin jobs SUCCESS, both Windows jobs FAILURE. The classifier passed separately. The [dated aggregate census](pr1213-owned-08-20261116.json) preserves complete jobs API at12:00:20UTC and complete run API at11:55:15UTC. Aggregate133274162113 is still queued, runner_id0, zero steps, conclusion null. These are non-atomic observations; the API started_at value does not establish execution. There is no terminal aggregate raw or final whole-Packaged qualification in that census.

## Incoming delivery P11 correction and integration boundary

A subsequent read found delivery PR1192 at852d9bd3f9142603340f71ca998739e69da00084, after documentary R1 commit9ec3fecdfd67e5d6cc635df9d2d6d43bea4187fb. The [complete incoming audit](incoming-delivery-p11-readonly-audit-20261116.json) retains the exact comparison with prior72e6 and the actual source/test evidence. The sole new source change adds a cutoff assertion after each awaited P11 poll observation; the90-second budget is unchanged. Our corresponding P11 preimage is identical to the incoming preimage. The incoming retained A run establishes123 cases,120PASS/3semanticFAIL; retained B GREEN is null. This does not close the later P11 native journey or M16.

The incoming UI test file contains51 cases, while our E file has78 actual passes and the published conversation append plans97 total cases, still unexecuted. The E/incoming comparison has44 common case names,7 incoming-only and34 E-only cases. The E-only group includes25 saved-Launch,5 passive-navigation and4 provider-receipt cases. Imported helpers and later sections also differ; no combined test count or automatic source adoption is claimed. Incoming Selection contains additional Stop-convergence behavior; our Selection retains the saved-Launch stability correction. The shared44-case source block is identical, while the complete test files and their surrounding helpers differ.

The [current retention catalog](pr1213-retention-catalog-20261116.json) links the original evidence, later platform outcomes, queued aggregate census and the separate incoming audit. The earlier snapshots and both published documentary checkpoints remain intact. Read-only probes have now established a usable replacement shell and Git access. The old checkout, installed dependencies, compiled outputs and direct TEST Node are absent, so the prior RED binding cannot execute on this filesystem. The separate [fresh bootstrap R1](ui-conversation-fresh-bootstrap-r1-20261116.json) selects a clean restoration of exact c5ff sources and fresh dependency/tool verification before rebinding the same whole97-case check. All five test/guard budgets remain unused. No bootstrap, producer change, real provider invocation or incoming source integration has occurred at this checkpoint.
