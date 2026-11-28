# PR #982 - bounded retained process snapshot reads

Status: reviewed implementation plan, not an E2E qualification. Scope: the existing Host Team snapshot page protocol and its original Desktop consumer. No runtime, provider, process writer, launch, or receipt changes.

## Reproduction / invariant

The canonical Owner includes retained `processes` in its product snapshot. `pageOwnerSnapshot` spreads all non-task/non-message fields into every page; at ~100 accepted 4 KiB command rows the retained processes alone exceed the 128 KiB MCP budget. Thus valid records cause `hold` before any other page can be read. The Desktop consumer currently only collects tasks/messages and Kanban segments, so changing the Host page shape without updating the collector would lose process history.

## Plan

1. Keep existing process rows intact, in persisted order. When `processes` is an array, place zero rows in the common page envelope and add each complete row as a page segment. Do not introduce native-process lookups or rewrite any records.
2. Add `processTotal` to every page whose source has processes (including an empty array), and use the existing principal/revision/byte-budget-bound continuation. Reject a single row exceeding the page budget; no truncation.
3. Extend the Main projection to validate a nonnegative safe `processTotal` with a process array, and the read collector to append whole projected process rows across pages. Require stable presence/total on every page and exactly the advertised number before publishing any product snapshot. Retain support for old single-page shape without `processTotal`.
4. Add focused regressions: large retained history at both 128 KiB and 384 KiB envelope sizes; strict original order and exact record identity; lossless Desktop reconstruction; no partial published snapshot on missing/stale/changed pages; ordinary empty history and small snapshots unchanged.
5. Run Host compile/tests, Main TypeScript and focused Desktop tests, 800-line guard, and then native E2E/CI on the *new exact head*. Never claim full readiness from a local unit suite or a queued workflow.

## Critique R1 - safety and trust

The original Team Owner must still enforce the read/grant fence on each page; cursors retain current principal/revision signature and no caller-selected process path is added. The 128 KiB limit applies to serialized whole pages, not only to process row count. Process data must pass the existing `readBackendProcesses` projection on each page.

## Critique R2 - compatibility and completeness

Do not reinterpret a process as a task; keep the existing `processes` product field. Use an explicit `processTotal` to fail closed on missing pages and reject count changes. Without that field, accept only the historical unsegmented contract. Reassembly must occur before `readOrder.acceptSnapshot`, not after a partial UI update.

## Critique R3 - scope and integration

Keep this change independent of the ongoing OAuth custody, configured Restart lineage, macOS native Resume/Review/Quit, and runtime input-budget work. Avoid touching their owned files. Reject any single oversized record rather than silently slicing security-sensitive command metadata; the existing accepted process row limit is far below a page. Do not merge #982 until independent review and all exact-head required acceptance gates succeed.

Estimates: ~90-150 LOC including focused tests, complexity 4/10, expected reliability 8/10 after tests, confidence 8/10 in diagnosis. No production claim before CI.
