# Adopt the checked provider archive for settled V2 fetch rejection

## Source and scope

Continue the original provider/Host migration using producer `c930d3c8b9a213762528d6e28c9ed0172ab1fa27` (tree `a9ce51413c87bc65b54fe07e45a1dc13b2b4c63a`) from the existing open Draft [producer PR8](https://github.com/agent-teams-ai/old-provider-implementations/pull/8). App content base: `b5791b2cc05b8d7becf148816fd994baeb407510`, tree `e4a3ed50a2a342a8f24d39cc3421d67103563c8e`.

The original V2 fetch rejection now clears settled pending state while retaining explicit unknown cleanup obligations and the same failure object. The complete consumed-source delta from `9423f600` includes three existing opt-in suggestion ownership commits and two fetch-fix documentation/source commits. It changes three production owners, three tests and four documents. Host Claude/Codex configurations do not enable suggestions; ordinary input/custody behavior, dependency graph, exports and Session SPI remain unchanged.

## Accepted producer evidence

[Source CI 43872562100](https://github.com/agent-teams-ai/old-provider-implementations/actions/runs/43872562100) passed its original build, types, 563 controlled source tests and two packed-consumer tests on both Node 24.21.0 and 26.11.1. The app adopts only original artifact `14228920904`: ZIP 193,575 bytes, SHA-256 `6088116cd6df79958c9f0e3024a0df3a0718ab4daf190a3c312fb8118b2ba8e5`.

[Original native matrix 43872562132](https://github.com/agent-teams-ai/old-provider-implementations/actions/runs/43872562132) completed successfully on attempt 2 at 13:47:49 UTC. All 53 entries were reconciled with original ZIP/receipt bytes: 51 positive completed receipts and two unchanged expected HOLD controls; all have cleanup true and qualified false. Fifty original executions were retained. Three macOS ARM64 jobs initially had no runner and no steps because GitHub could not acquire hosted capacity; one failed-jobs continuation executed only those three, retaining their original cancellation evidence.

The three actual continuation jobs are embedded `133333756520`, pinned-tool `133333756515` and target-interrupt `133333756546`; their artifacts are `14230404313`, `14231521582` and `14229784508`. The two expected HOLDs remain the stock model terminal qualification and SDK 2.0.0 ESM-import floor controls. No cancelled or queued execution was counted as success.

## Exact app change and review

Select the previously reviewed six-path patch: the Host package reference, five corresponding lock path references plus one integrity, and four new archive/provenance files under `vendor/provider-migration/v2-settled-fetch-c930d3c8/`. Original provider TGZ: 186,425 bytes, SHA-256 `9d66036c17a4c2bf86dde9171d94d3048e5df6f6f1ee17ff05758e3a7cf2be41`, Git blob `3a044485d5c05da43f46febd0fc76c65fa79ef1f`. It was neither rebuilt nor edited.

Keep the byte-identical Session SPI at the existing `host-logs-thinking-9423f600` path with its current Host dependency, workspace override and lock entries. Preserve all historical archives and other app leaves. Tar member sets remain 253/253; only three corresponding JavaScript owners and two private-field declarations differ.

Source/patch R2 accepted the exact six-path candidate and unchanged activation boundary; the required original native-receipt condition is now satisfied. Fresh complete app-tree inspection confirms both touched preimages and absence of the new archive directory. The original archive-integrity verifier passed before and after under local Node 24.22.1; forward/inverse application was exact. Complexity 2/10; source/package confidence 9/10.

## Resulting-source qualification

The existing app workflows must still compile and exercise this dependency through the actual Host and packaged Electron. In particular, the earlier Linux credential-close failure is not declared fixed by producer success alone. Keep original native, Windows Retry/Stop, Darwin P09, GUI, cleanup and full aggregate gates. Draft, default-off behavior, no main merge, no release, no Stage 2 and the prohibition on real Claude/Codex execution remain.
