# PR #982: bounded Desktop process catalog

Status: implementation candidate delivered after the independently reviewed plan; execution qualification is pending.
Baseline: e88c9a2e87a0d916312ad3c306221e57cd10a405.
Finding: https://github.com/777genius/agent-teams-ai/pull/982#issuecomment-7231365203.

## Reproduced boundary and required behavior

The review reports 250 accepted registrations with 4096-character commands producing a 1,099,560-byte Desktop process.list response. createTeamProcessMethods currently returns the complete list; its unchanged priority frame limit is 1 MiB. createHostTeamsApi.getData calls this endpoint after the independently paginated Team snapshot. Snapshot paging and the native MCP process-list fix therefore do not close this Desktop path.

Keep the fresh process read. On Windows, the synchronous Team snapshot intentionally reports unknown for original version-5 captures; WindowsTeamProcessCommands.list performs the original bounded asynchronous native observations. Reusing snapshot.processes would remove the existing same-live/canTerminate behavior. Preserve original processRef, pendingStop, metadata, ordering, and the Stop/lookup command identities.

## Production manifest (7 files)

1. packages/legacy-agent-host/src/process/createTeamProcessMethods.ts
2. src/features/agent-backend/contracts/processes.ts
3. src/features/agent-backend/contracts/operations.ts
4. src/features/agent-backend/main/adapters/input/validateBackendOperation.ts
5. src/features/agent-backend/main/adapters/output/projectProcessResult.ts
6. src/features/agent-backend/core/application/readHostProcessCatalog.ts (new)
7. src/features/agent-backend/renderer/createHostTeamsApi.ts

Existing pageProcessCatalog and WindowsTeamProcessCommands behavior are reused unchanged. No new transport, process control operation, storage, native authority, dependency, compiler option, frame cap, registry cap, request deadline, or production size exception is added.

## Host boundary

Use existing pageProcessCatalog over the exact list obtained by the current target.commands.windows.list(deadline) or target.commands.list() path. Keep the current 10-second per-request native deadline and the existing pre/post target assertions.

For process.list only, accept the strictly validated optional cursor (existing offset-dot-64hex format). Reject unknown payload fields and malformed cursors before entering the Owner read. Preserve the empty-object request and small/empty array response.

Create one private random page key in createTeamProcessMethods. Before any async observation, bind the continuation key to that original Host instance and the exact already-validated binding with the existing structural digest. Never derive it from a renderer-selected PID, result position, or new commandId. Each continuation resolves and reads the original owner again. Changed rows/observations, foreign binding, another Host instance, malformed cursor and unavailable ownership fail before publishing a partial catalog. The existing helper preserves whole records, caps serialized pages at 240 KiB and limits the catalog to 1024 rows.

## Main and shared contract

Change only process.list payload to { cursor?: string }. Add a public process-catalog-page union to BackendOperationResult; retain the legacy array alternative.

Implement an allowlisted reader beside readBackendProcesses. It validates page kind, nonempty process rows, safe integer total in 1..1024, total at least the page length, a 64-lowercase-hex revision, and null or the strict cursor. Every row uses the existing readBackendProcess checks and duplicate-id check. Extra fields must not cross Main projection. The Main process result projector accepts the bounded union; input parsing rejects malformed cursors and extra fields. Keep other process operations unchanged.

## Renderer assembly

Add a small dedicated complete-catalog reader following the existing group collector pattern. It calls a supplied request(cursor), asserts the captured scope before and after every await and before publication, and accepts a legacy array only as the first complete result. For pages, require one revision and total, no duplicate process ids, no repeated cursors, no total overflow, and exact total at the terminal page. Stop after the existing 128-page ceiling. Never publish partial rows or automatically restart on drift.

getData captures a copy of the original handle once and uses this reader for the existing fresh process read. Each page retains the existing current(check) and snapshot.assertCurrent assertions. The final Team view receives the fully assembled fresh process rows. No cached snapshot observation authorizes native Stop. All calls remain read-only; control and retry identities do not change. Each original Host request keeps its existing deadline; no timed-out request is retried or extended.

## Required regression evidence

The original independent Codex review reproduced the large accepted catalog through the real Desktop handler and HostOutput on e16383cc5a65706d508acdb6bc8965655125f0ba; the relevant source blobs are unchanged through the published plan. Retain that reported execution as baseline evidence. The new regression reaches the same handler and asserts actual frame admission before inspecting a page, so the old unbounded response fails at the transport boundary. Local execution of this new regression remains pending.

After the change:
- Real canonical process registration/public projection of at least 250 4096-character command rows, actual createTeamProcessMethods and actual HostOutput: each bounded frame accepted, no priority_overflow, decoded wire pages reconstruct every exact row in order under the unchanged default and review-v1 process frame cap.
- Host negative controls: malformed/unknown cursor payload before Owner read; foreign binding/Host cursor; changed rows; revoked owner after an async Windows list; small and empty old shape.
- Main input + actual process output projector + collector: complete large catalog, page kind/total/revision/cursor validation, duplicate/incomplete/mixed/repeated/overflow cases, 128-page ceiling, allowlisted rows and capabilities.
- Actual createHostTeamsApi.getData composition: paginated snapshot plus independently paginated fresh process rows; Windows-like snapshot unknown must be replaced by the original async list same-live/canTerminate result; pendingStop survives; context/read-order/handle changes never publish partial rows or dispatch another owner.
- Preserve and rerun the existing process Stop/lookup, process snapshot, MCP paging and real HTTP/MCP regression cohorts, including the incoming e88 schema/type corrections.

Use TEST-only process ports and canonical registration metadata, not real vendor services or arbitrary OS processes. Record source reviews separately from actual test verdicts. Run meaningful strict compilation and existing source/architecture gates without weakening them. Current-head normal CI remains required.

## Independent review record

- R1: root traced the actual Desktop handler, Main input/output projection, renderer getData, snapshot paging and Windows list call graph on the baseline.
- R2: coordination audit independently reviewed the existing page helper, Windows observation behavior and the Main/renderer requirements. Approved this seven-file scope before implementation.
- R3: frontend audit independently checked the real consumer, generic invoke surface, row validator and existing control tests. Approved with explicit cross-binding/cross-Host cursor controls and the whole-catalog 1024 bound.
- The cursor tests must isolate identity from revision: identical rows under another validated binding in the same factory, and identical rows/binding in a new factory, both reject the old cursor. A malformed cursor performs zero Owner list reads.
- The original registry is bounded to 8 MiB and 1024 rows, with at most 64 additional retained missing rows within the same 1024 total. The unchanged 128-page ceiling accommodates accepted whole-record pages; no larger cap is needed.
- These are source reviews, not execution results. The executable baseline, strict checks and current-source native acceptance remain pending while the local executor is unavailable.

## Verification execution during the local environment outage

The local executor became unavailable before this slice could run. Independent source reviews approved delivering the complete candidate through the existing GitHub PR and validating it with the ordinary CI triggered by that source commit. This changes where validation runs; it does not relax a validation gate.

The independent baseline reproduction above is attributed to the original review, not to a local run by this implementation owner. The new Host and Main/renderer regressions, canonical package build, strict test compilation and current-source native acceptance are all pending at delivery. No local hook, compiler, unit, native or end-to-end PASS is claimed.

The canonical Host test command builds the package, checks tsconfig.test.json, and includes tests/*.test.ts. Normal PR CI must establish the result. A failure requires a source or fixture correction followed by the normal checks on the resulting commit. No manual CI run, rerun, cancellation, change of limits or substitution of skipped/old results is authorized by this note.

## Delivery and coordination

Review this plan twice against the actual call graph before publishing it. Publish the reviewed plan on the existing PR branch before production edits. Keep the branch open/unmerged, preserve incoming work and the reserved macOS files, and update by a normal fast-forward lease only. No external messages, manual CI reruns/dispatch/cancellation or default Host activation are included.
