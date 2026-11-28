# Bounded process-unregister acknowledgements

## Confirmed current defect

PR #982 review `4725118363` reports a successful canonical metadata removal whose full remaining catalog exceeds MCP output limits. A finite TEST-only reproduction additionally confirmed an earlier durable-journal limit. It used the actual filesystem Team Owner, canonical registrations and process MCP tools, with no native process adapter or native requests.

- 100 accepted registrations with 4096-character ASCII commands: unregister removes one row, then the prospective 438639-character completed receipt exceeds the existing 128 KiB journal bound. The original receipt stays prepared; lookup, replay and a cold owner cannot confirm completion.
- 30 accepted registrations with 4096-character Unicode commands: unregister removes one row and durably completes. The actual projected receipt is 366006 UTF-8 bytes, beyond the existing 256 KiB MCP bound. Both mutation and original lookup fail with output-limit.
- Existing paged process_list reconstructs the current remaining catalog exactly in both cases. Replaying the original command does not repeat removal.

The repaired acknowledgement must fit both boundaries before the policy mutation. Keep the original ID/PID selection, requestDigest, command fingerprint, grant/principal/Team checks, selected immutable refs, journal phases and native custody. Do not increase limits, truncate catalog rows, add tools or migrate old receipts.

## Exact repair scope

Three production files:

1. `packages/legacy-agent-host/src/process/TeamProcessCommands.ts`: construct a completed unregister receipt without the remaining catalog. Validate the exact compact completed shape before canonical removal, preferably before the prepared publication when possible. The prepared receipt still precedes the actual removal; completed publication still follows it. A write failure retains the original uncertainty and cannot trigger a new deletion.
2. `packages/legacy-agent-host/src/process/projectProcessViews.ts`: project a compact completed-unregister acknowledgement with `resultOmitted: true` from both fresh and retained records. Validate every retained legacy result row using the existing allowlist before omission. Do not rewrite a retained record or infer completion from current registry contents. Register, metadata-stop and terminate projections preserve their current behavior.
3. `packages/legacy-agent-host/src/mcp/processTools.ts`: clarify that mutation/lookup return the original command acknowledgement and that the existing paginated process_list provides the complete current catalog. No parameter or cursor changes.

Do not add a remainingCount: the visible process catalog can also contain retained rows for unknown native stop outcomes, so it is not necessarily the canonical remaining array. The acknowledgement confirms only its original command state. Historical prepared records remain prepared, even if their selected registry row is now absent.

The shared projection covers immediate mutation and lookup consistently. Retained malformed results still fail closed. No native stop, signal, PID reuse, process-custody or authority policy changes accompany this repair.

## Finite regression gates

Use real canonical registrations and the actual Owner/journal/MCP path in TEST roots. Run the two actual-size regressions against unchanged process production before copying the candidate.

- Both ASCII journal overflow and Unicode MCP overflow return a bounded completed acknowledgement after exactly one removal; the original receipt is durably completed.
- Same-command replay, original lookup and cold lookup preserve exact journal/registry bytes and never remove another row. A changed selector with the same command ID conflicts.
- Current process_list pages reconstruct every remaining row and complete optional field without truncation.
- A retained large completed receipt receives the same bounded projection without rewrite. An old prepared receipt remains unconfirmed. Invalid legacy row data remains held.
- A compact completed receipt that would exceed the existing journal limit is refused before the canonical mutation; no new larger cap or ambiguous success is introduced.
- Revoked/wrong principal or Team authority remains refused. Register, metadata-stop, terminate and unknown native-stop retention retain their existing behavior.

Root integrates the latest remote source first and preserves independently published OAuth/catalog changes. Use pinned Node 24.21.0, the existing Host build, exact-options scoped strict checks and the related finite process/MCP tests. Standard current-head CI is still required. No manual workflow controls, main merge or native acceptance claim.

Estimate: **4/10** complexity, **45–80 changed production lines** in three files and **180–260 test lines**. These are design estimates. The baseline reproduction is execution evidence; the candidate is not yet qualified by this plan.

## Execution evidence

The implementation changes exactly the three planned production files by **+25/-26** and adds one **219-line** test file with six cases. Complexity remains **4/10**. Independent source review confirmed unchanged native custody, authority, original receipt identity and retained-result validation.

Before copying production changes, both actual-size ASCII/Unicode regressions failed on the published baseline. An additional boundary regression demonstrated 816 accepted PID-history rows being removed even though a 131071-character prepared receipt fit and the 131073-character compact completed receipt did not. Its first diagnostic worker run did not report a reliable assertion and was not counted as regression evidence; one bounded TAP run reproduced the actual assertion after replacing a huge Buffer failure diff with an equally strict byte-equality check.

On the combined `a01484ee4787698f7e3ce1d5b98a585edad54876` source plus the protected auth-progress repair, the pinned Host build passed. An exact-options strict check and all **60/60** tests passed across nine related files, with no skipped cases: the new unregister tests; existing process command/owner/capture-record tests; MCP, HTTP and Host catalog pagination; Team snapshot paging; and ModelProbe custody. This covers successful acknowledgement, complete current catalog retrieval, exact replay/cold bytes, malformed retained rows, unchanged metadata-stop/native-unknown behavior and refusal before the boundary mutation.

No caps, timeouts, native adapters, public request parameters, tool count, runtime pins or workflow settings changed. Historical prepared receipts remain unconfirmed. Current-head required CI remains a separate delivery gate; controlled TEST contracts are not genuine native-provider acceptance.
