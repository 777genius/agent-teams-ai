# Original608 packaged Windows x64: Retry cutoff after recovered UI

[Job133091842656](https://github.com/777genius/agent-teams-ai/actions/runs/43795234711/job/133091842656), run43795234711/attempt1, source `608efb78823d7c74b35f8a674fcfb6faea8ecfc5`, fails the original same-Main step38. The separate packaged V2 step37 has a source-bound PASS and restoration receipt. The same-Main result remains **INCOMPLETE, cleanup=false**.

## Immutable evidence

- Artifact14198298316: 625,065 bytes; SHA256 `519bf00b1622225262dda3d2b69eaf3df70f0434b921bc41041624a18cd54fdf`. Eight entries, CRC verified and safely extracted once.
- Full decoded job log: 314,374 bytes; SHA256 `31ea4744df4cd594653ced95e24ae48fca9431a40416b7784ddb87c4a0501aad`; original UTF-8 BOM and CRLF preserved.
- Same-Main receipt: 750,852 bytes; SHA256 `9488adbdb78f8ce61ecefdd84a16fea78d39a85ee8da4998a5e67b5d0059bc5c`.
- All1798 unique before/after source pins agree and independently match immutable608 after its exact LF-to-CRLF checkout. Gate034d2253, platform71d56291, controls2ea000d3 and workflow0938e9f3 are the actual original bytes. No current delivery bytes were substituted into this audit.

## First refusal and actual progress

First error: `Original Windows UI phase expired: one-explicit-same-Main-Retry`, at `remaining`123 → `validateCensus`179 → `assertOwnedRenderer`207 → `waitRead`157 → Gate502. The failure is in the original post-Retry process-row loop, before either Stop. It is not an orphan/listener mismatch or query-provider exception.

The actual Retry phase record starts at35031.234ms with its unchanged10000ms budget. The final combined observation starts44691.210ms and returns45377.5249ms (686.3149ms), crossing the phase-record upper cutoff45031.234ms. The real cutoff was created immediately before the phase record and is no later than that bound. `returned:true` means the raw observation returned; the subsequent original cutoff rejected it.

| Original Retry milestone | Elapsed from phase record |
| --- | ---: |
| Physical click returned | 4890ms |
| Successor writer observed | 6111ms |
| Original successor Host check completed | 6430ms |
| UI readiness accepted | 8733ms |
| Completed UI evaluations | 3; last result ready |

The original public binding check and fixture afterRetry completed, and `afterRetryPublic` preserves both exact prior same-live/canTerminate process references. Main5428 retained one successor Host7020 after originalHost3372. Dedicated `sameMainAfterRetry` and `stops` fields are absent because their recording points were not reached. The original Runtime observation has generation1 and a succeeded input, but the later cleanup-derived `originalRuntimeGenerations` remainsnull; do not replace that missing final witness with an inferred PASS.

Action counts are exactly one Main, Open, business input, Refresh, Retry and Quit; **zero UI Stops**. The finite peer reports one connection, one registration exchange, zero service-exit observations/failures/model requests/probes/real vendor executions. There is only the before-crash PNG; its hash matches, and it cannot show the later failure state.

## Bounded timing interpretation

Retry retains13 sequential raw observations:12 combined process/listener snapshots totaling8218.6229ms and one standalone process census317.7706ms, total8536.3935ms. The seven pre-click combined observations total4651.8385ms. Full rows are in `retry-timing-audit.json`.

These are inclusive interpreter/query/parse durations. They do not isolate Get-NetTCPConnection, CIM, serialization or CPU cost. The standalone observation is at another instant and cannot be subtracted as an isolated listener benchmark. This repeats the prior0660 post-recovery cutoff boundary in Plan30§13, with a different original timing sample; it is not a demonstrated product readiness failure.

## Cleanup and separate prerequisite

One original Browser.close was sent; its acknowledgement classification is socket-closed. Captured Main exited0 with signalnull. Final family/listener census is drained with both sets empty. The controller independently recorded exactly `{gateController:drained, rootExitCode:1, activeProcesses:0}`.

Nevertheless fixture.afterQuit first refuses `0 !== 2` at its original Stop count check. The receipt contains no nativeCleanup; missing two service-exit/HANDLE/Stop witnesses remain missing. Final absence and aggregate drain do not qualify them. All retained packaged/native input pins remain unchanged and sourceFreezeFailure/peerEvidenceFailure are absent.

Step37 is separately PASS: the native receipt rehashes to `b11fa9ad64abb7f08d6527041e85fab69c33d64ad4236d8565c48852b425be03`; candidate manifest rehashes to `a95fbd84dde0baf9c38e80689f2c704f9bf4e9888d5dbbe56b04c1dc91717146`. Outer/native/UI receipts join the same source/platform/app.asar/Host/Node/candidate. Both native Host exits are0/null, cleanup=true, modelFailures=[], and source/bundle/legacy inputs restored. Coordination remainsunqualified; Desktop/vendor-auth/release flags remainfalse. That original V2 limit is separate from V1 original15s readiness, and this ZIP does not contain all binary payloads for new local rehash.

## Comparison with the already published correction

This run used old platform71d56291. Published ae727104 retains platform5e21bb5f, whose only production delta in this module is the combined snapshot listener statement: direct `MSFT_NetTCPConnection` CIM in place of the old NetTCPIP cmdlet. The original full process query, standalone process/listener/availability/drain paths, ordering, calls, guard authority and deadlines are unchanged. The exact diff is retained in `published-cim-only-comparison.patch`.

The failed observation is on the affected combined path, so this evidence confirms relevance of the selected scope. It does **not** establish query-internal cost or a repaired native deadline. No new source fix is selected. The unchanged original resulting-source x64/ARM P08 scenarios must still produce both Stops and full cleanup. Original15s/P09/full-I386/M16/vendor holds are unaffected.

Only the authorized original log/artifact retrieval, inert hashes and immutable source reads were performed. No project/source import, test, build, GUI/native/provider invocation, canonical edit or workflow action occurred.
