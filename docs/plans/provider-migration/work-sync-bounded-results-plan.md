# PR 982 — bounded Work Sync status and report acknowledgements

Status: consolidated design approved by root after independent R3 review; publishing before implementation. Root approved the bounded projection, original-header guard and pure scalar-excess direction. Independent frontend R3 approved the final E-slot envelope and replay distinction. No Work Sync production or test edits are authorized before publication. Source trace: cf0d178aeb350c8a0fb113ec89e44836030966ee. This text supersedes R0 and the earlier whole-status H+G proposal. The executor is available again. This plan records source review and JSON arithmetic, not compiler/runtime evidence for the unimplemented Work Sync change.

## 1. Concrete fault and unchanged authorities

The independent PR review reproduced three accepted task subjects of 30,000 CJK characters yielding approximately 271,238 UTF-8 bytes and the existing MCP output-limit failure. createHostWorkSyncComposition returns a full agenda for status and another full agenda inside report.status. WorkSyncCommandReceipt independently caps the COMPLETE serialized receipt at 512 KiB UTF-8; a larger accepted agenda can exceed it after canonical reconciliation/report publication. The canonical Work Sync status decoder has no aggregate item-count/JSON-byte cap, so there is no claimed global maximum agenda size.

The fix bounds only the command acknowledgement. Canonical agenda/status, report validation, token contents/expiry, receipt fingerprint, original receivedAt/mutationId, source input, outbox custody and policy effects remain the same. No new tool, cursor, command ID, journal, owner, retry or deadline. No limit is raised.

The native report schema permits at most 200 optional taskIds. requiredReport currently copies every agenda item, which can produce invalid suggested arguments. For more than 200 items omit taskIds completely; do not slice it or replace it with an empty list. The existing report validator always evaluates the FULL original current agenda/token: caught_up still refuses any work; blocked without IDs checks current blocker evidence.

## 2. Exact production manifest

All paths have the prefix packages/legacy-agent-host/src/ except where stated.

1. NEW work-sync/projectWorkSyncResult.ts: pure projection/strict compact-variant validation, shared result-byte budget, essential-scalar preflight calculations. Expected 250–450 lines; no store or effect owner.
2. work-sync/TeamWorkSyncCommands.ts: exact original-header result reserve before the first write; pure bounded acknowledgement on fresh completion and retained replay; compare the COMPLETE original running receipt after await before completion. Expected +30–50 lines.
3. composition/createHostWorkSyncComposition.ts: existing original persistence ports wrapped with essential-result preflight, one initial read before the use case, and corrected requiredReport suggested taskIds. Expected +35–65 lines.
4. mcp/workSyncTools.ts: truthful description of compact results and current/full task reading. No schema/input-limit change.

No edit to commandContracts.ts, generic MCP formatter, canonical status decoder, report policy or status storage adapters. If source implementation proves another path is required, amend/review this manifest before touching it.

## 3. Small, full and compact response variants

Let B be the exact available result budget for THIS original receipt (section 5), at most the existing 256 KiB formatter limit. Its raw JSON fits the existing Host transport as well: the existing HTTP wrapper is bounded by three times those bytes plus fixed framing, below 1 MiB. First retain the exact original full result when its serialized UTF-8 bytes fit B and the completed receipt validates. This preserves existing small usable responses, except the independently invalid >200-task suggested call, whose optional taskIds are omitted.

Only a result that cannot fit uses the explicit compact variant. The result contains a workSyncProjection marker with version:1 and kind:'compact'. For status this marker belongs to the status result; for report it belongs to the report-result wrapper. A report wrapper preserves accepted, code, message and projectionDegraded exactly. It contains the same compact status shape below.

Compact status is an allowlisted reconstruction, not a spread of historical arbitrary JSON:

- teamName, memberName, state, evaluatedAt, and providerId when present.
- agenda: original teamName/memberName/generatedAt/fingerprint; itemsOmitted:true; actionableCount from the FULL original items.length; byKind with work/review/clarification/blocked_dependency counts whose sum equals actionableCount. There is NO items:[] substitute. sourceRevision and diagnostics are explicitly omitted.
- reportToken and reportTokenExpiresAt unchanged when present. The same original token is also used in nextRequiredToolCall.
- report and lastAcceptedReport, when present: original state, accepted, agendaFingerprint, reportedAt, expiresAt when present, and source when present. Historical taskIds, note, repeated team/member names and rejection explanation are explicitly omitted. This keeps exact acceptance and lease facts.
- runtimeAdmission, when present: original state and controlRevision when present. Pending/unknown/superseded cannot be hidden by projection.
- recoveryHealth, when present: schemaVersion, autoResumeStopped (derived from presence of the original latch), the original autoResumeStopLatch.stoppedAt/controlRevision when the latch exists, and original recoveryHealth.controlRevision when present. A large legal stop reason is explicitly omitted; it is not called corrupt and does not block reporting. Episode/reservation arrays, unresolved intent ID and diagnostic attention metadata are omitted.
- statusOnlyIncomplete, nextRequiredAction and nextRequiredToolCall are kept for status results when originally present. nextRequiredToolCall keeps the SAME commandId/state/agendaFingerprint/reportToken; its taskIds are omitted in compact mode. Its state was chosen from the FULL agenda before projection.

The fixed marker includes an omittedDetails list with exact existing paths and collection counts where applicable. Its paths are a finite literal allowlist; never enumerate arbitrary unknown keys into it. Unknown additional metadata is excluded from the reconstruction and represented only by a fixed additionalMetadataOmitted boolean. It explicitly names agenda.items, agenda.diagnostics, agenda.sourceRevision, diagnostics, statusRevision, pendingReportReceipt, shadow, report.taskIds/note/teamName/memberName/rejectionCode, lastAcceptedReport equivalents, recoveryHealth.episodes/reservations/unresolvedIntentId/attentionAt/attentionAcknowledgedAt, and recoveryHealth.autoResumeStopLatch.reason when those fields existed. Do not promise that omitted diagnostics can be retrieved by the task tools.

The marker may include guidance for the existing bound task_briefing/lead_briefing and team_get tools. Every briefing-chunk page recovers the complete FORMATTED BRIEFING, whose producer deliberately caps displayed queues and text. It does not reconstruct every omitted Work Sync item or historical diagnostic. Following every team_get nextCursor and merging taskParts yields the complete current canonical task board, within the existing captured Team authority. Those are later reads; they neither recreate nor retarget the original report token. A changed agenda is handled by the existing stale-fingerprint/token refusal, without automatic status retry.

Strict compact replay is mandatory. New completed receipts already contain compact results; recognize the explicit marker, validate the allowed fields/counts/required-call consistency and return the original compact result. Never infer zero tasks from the absence of items or compact again from missing details. Old full results derive counts from their ORIGINAL stored agenda.items. Unknown/unprojectable oversized retained shapes hold without mutation.

## 4. Essential scalar guard before business effects

Internal statusRevision and pendingReportReceipt are omitted as complete internal CAS metadata from compact acknowledgements. Neither field is a report tool input, and deferred native settlement consumes original command headers, not receipt.result. Their canonical storage and conditional token are unchanged. This avoids imposing new arbitrary ID caps merely to copy internal metadata into MCP.

Validate every preserved scalar structurally at this boundary: runtimeAdmission is not validated by the existing canonical decoder, and recoveryHealth validation returns the original raw object rather than its normalized reader result. Check the known state enums and typed numeric values without assuming a TypeScript cast. Preserve the existing recovery/latch reader's accepted positive digit-string revision representation exactly: its raw serialized bytes participate in E; do not require a new numeric-only shape or normalize it. runtimeAdmission requires its own explicit state and numeric-revision check. The remaining historical authoritative lease/timestamp/fingerprint fields can still be unbounded in the existing import decoder. Do not assume a maximum from TypeScript or label a legal arbitrary stop reason corrupt. Before running Reconciler/Reporter, measure the actual required historical scalar projection plus a proved upper bound for new native-produced fields against B.

The repeated-read budget uses excess over the finite generated prototype. Reserving the whole original status plus G on every read would double-charge this operation's own generated fields: its first commit can replace a one-character token with a 635-character token, and a later read would incorrectly reserve that growth again. Use a pure per-position envelope, with no mutable tracking:

For every preserved scalar position j, let g_j be the generated JSON-VALUE byte ceiling below, and e_j = max(0, UTF8(JSON(value_j)) - g_j). Missing fields contribute zero. Let E be the sum including the explicit destination multiplicities. G = 16,384 covers all fixed field names/brackets, every optional slot, finite omission metadata, read guidance, counts and all generated ceilings. Require G + E <= B before use-case entry and at subsequent read/prospective-write guards.

| Preserved position | g_j, UTF-8 JSON-value bytes | Multiplicity or qualification |
| --- | ---: | --- |
| status.teamName, status.memberName, agenda.teamName, agenda.memberName | 130 each | Four separate actual positions; generated names are at most 128 ASCII characters. |
| status.state and each report state | 15 each | Existing enums; still_working is the largest generated value. |
| status.evaluatedAt, agenda.generatedAt, reportTokenExpiresAt, each report.reportedAt/expiresAt, latch.stoppedAt | 29 each | toISOString can produce 27 characters; every raw old position is measured. |
| status.providerId | 11 | Existing provider enum. |
| agenda.fingerprint | 76 | Count twice for a STATUS acknowledgement: status plus nextRequiredToolCall.arguments. Once for REPORT. |
| reportToken | 637 | New token at most 635 ASCII characters. Count twice for STATUS, once for REPORT. |
| report.agendaFingerprint and lastAcceptedReport.agendaFingerprint | 1,538 each | Incoming report fingerprint permits 256 characters with six-byte JSON escaping. |
| report/lastAcceptedReport.source | 6 each | Existing app/mcp/test values. |
| report/lastAcceptedReport.accepted | 5 each | Boolean. |
| runtimeAdmission.state | 12 | Existing typed state enum. |
| runtimeAdmission.controlRevision, recoveryHealth.controlRevision, latch.controlRevision | 24 each | Generated finite numeric JSON text; accepted raw recovery/latch digit strings are preserved and charged by their actual excess. |
| report.wait and lastAcceptedReport.wait | 1,098 each | Only after explicit PR #1315 integration; whole strict bounded block. |
| autoResumeStopped | 5 | Boolean; stoppedAt/controlRevision have their own slots. |

STATUS token/fingerprint excess is counted twice even though a canonical status snapshot does not yet contain the suggested call. This reserves their later copies. Root and agenda names use separate actual positions. Fixed generated nextRequiredAction/tool/commandId/state values are included in G. A retained completed reply is handled by section 7's exact actual-size check, not this fresh producer envelope.

For the two report destinations, the exact envelope is E(raw report) + (raw lastAcceptedReport is present ? E(raw lastAcceptedReport) : raw report.accepted is true ? E(raw report) : 0). The existing getMemberWorkSyncAcceptedReport prefers a present accepted raw lastAcceptedReport; only its absence falls back to an accepted report. The existing decoder requires a present lastAcceptedReport to be accepted. Do not assume that report and raw lastAcceptedReport are otherwise consistent or substitute a different effective report. This counts a possible future accepted-report duplication before it occurs. The compact projector preserves the actual present fields; it does not materialize an absent lastAcceptedReport merely because the envelope reserves it.

Every original authoritative scalar, including old token/expiry/agenda fields, is measured. In particular, Reporter can return unchanged original read.status from reportJournal.ensure's already-accepted branch. The new-token bound alone cannot cover that branch. This rule never forces an old token into the fresh 635-character ceiling.

The existing Reconciler, Reporter rejection/acceptance/unchanged branches and recovery helpers retain/copy already-counted core fields, delete omitted metadata, or replace fields with values within these generated allowances. Their own transitions therefore cannot increase E. Both possible report destinations and both STATUS token/fingerprint destinations are explicit above. A new uncounted promotion is a plan change, not a reason to add mutable budget state. Retained completed-command replay uses pure actual projection within B, not fresh E+G admission.

The existing native composition has the required read-only join:

- Build the same original persistence object inside the command effect callback, using the original mutationId and unchanged original authority.
- Wrap its SAME statusMutations object methods in place, retaining the original methods first; statusStore.read closes over that object, so substituting only a spread object would miss that caller. After an actual successful read, validate/project the preserved essential scalar shape and its proof budget before returning that snapshot.
- Perform one initial guarded read BEFORE invoking Reconciler or Reporter. Their audit, recovery repairs, reportJournal, token creation, canonical commit and outbox work have not started.
- Pass this SAME guarded port into the use case, so later reads and existing CAS-conflict retries cannot import an unchecked large required scalar state.
- Wrap compareAndWrite to validate the prospective compact acknowledgement's preserved scalar budget BEFORE delegating to the original conditional write. Do not replace/reconstruct its original expectedToken, incarnation, mutationId, reportReceipt or replacedReceipt. Newly assigned statusRevision IDs are omitted from the acknowledgement.
- Keep the fixed result budget B and exact original command throughout. Recheck ordinary original authority around every existing await. External concurrent source/state changes retain the existing hold/conflict semantics; no retry is introduced.

Source proof: createNativeMemberWorkSyncPersistence.readSnapshot -> MemberWorkSyncStatusAuthority.startRead -> createMemberWorkSyncJsonBackend.read -> readMemberWorkSyncJsonStatus is read-only in this native composition. Native withPreparedBackend creates the bound paths/backend; it does not import/repair/publish. Directory creation, canonical writes and metrics publication are in compareAndWrite.

The canonical essential guard can run after the original Team prepared/running receipt exists, because execute registers that original before its async effect. It promises ZERO BUSINESS effects before an unsupported essential scalar is refused, not zero command-journal writes. Running originals remain held/nonretriable as today. The separate receipt-capacity guard below runs before ANY new command write.

For legacy state, use computed B up to the existing 256 KiB wire threshold, not a blanket 96 KiB essential-state rejection. An old response that can still be safely represented should retain its full original form where possible. Unsupported oversized authoritative legacy fields are an explicit pre-business refusal; they are never normalized/truncated after a successful report. Large non-authority details are explicitly omitted instead.

## 5. Exact receipt reserve and original readback

For a fresh command, construct the exact prepared receipt as today. Before its first store.write, calculate J as the UTF-8 size of {...prepared, phase:'completed', result:null}. Its framing and ALL original header/payload fields are included. B = min(256*1024, 512*1024 - (J - 4)). Validate a hypothetical complete receipt containing an unpersisted placeholder JSON string whose serialized bytes are exactly 96*1024. Use the existing validateWorkSyncCommandReceipt; do not duplicate or relax its 512 KiB validator. This proves at least 96 KiB for the bounded normal-producer acknowledgement. Refusal occurs before prepared/running write and before the use case. The placeholder is never saved and is not a synthetic success.

Keep an independent deep snapshot of the original running receipt before invoking the effect; the callback receives its own clone, never the expected snapshot. Derive the composition's B from that same original through the pure budget helper. After the effect and original authority checks, read the actual running receipt under the original store fence and compare its COMPLETE JSON semantics with the captured running receipt, including receivedAt, mutationId, nativeInput, operation/payload, metadata and additional keys. phase/fingerprint alone is insufficient: those do not commit all fields and would let another header steal the earlier capacity proof. Refuse missing/corrupt/replaced originals. Do not change the existing payload fingerprint definition.

Then try exact full result, otherwise the typed compact result. Require result bytes <= B and validate the exact completed receipt through the existing validator before the existing write. Complete only this original receipt; no new command, effect replay or repair. The pre-effect scalar proof and tested producer maxima must make a capacity-only error after a successful canonical effect unreachable for an unchanged legal original.

## 6. Numerical proof, distinguished from execution

The maximal MCP report payload with state still_working, agendaFingerprint 256 U+0000, reportToken 4096 U+0000, 200 taskIds of 256 U+0000, note 4000 U+0000 and leaseTtlMs 3600000 serializes to 358,020 ASCII JSON bytes. Six-byte escaping is included.

Actual Host header producers:
- TeamHost principal/profile IDs <=256.
- Definition backend/team/member IDs and names are ASCII safe segments <=128; runId/generation <=256; runtime.normalizeBinding bounds all five at256.
- Runtime delivery inputId=deliveryId and inputId/messageId<=256; original cause command<=256; TaskStartCause.taskId<=128.
- RuntimeTeamCoordinator creates hostIncarnation as UUID36.
- RuntimeOwner bounds native sessionRef<=1024 and creates operationRef as UUID36.
- Identity/fingerprint digests are hex64. New command mutationId is UUID36 and receivedAt is at most 27-character ISO text.
- NativeMcpAuthority stores only fixed original IDs, bindings and one fixed cause; no raw task subject or message content.

A synthetic upper-bound header with all free 256/1024-character strings represented by six-byte JSON escapes, maximal safe revision numbers, the larger TaskStartCause branch, payload:null and phase:completed is 33,683 bytes (no result key). Replacing payload:null with the maximal report payload and adding the exact result key plus 96 KiB result gives 490,013 bytes: 34,275 bytes below the unchanged 512 KiB cap. This is an arithmetic/source upper-bound calculation, not a semantically valid receipt fixture or runtime test. Generic standalone owners permit some longer identifiers; the actual byte/validator preflight remains mandatory and those generic input caps are not changed.

New agenda fingerprints are 'agenda:v1:' plus64 hex chars =74 ASCII chars. With two native ASCII names<=128 and at most27-character ISO expiry, HMAC token JSON payload is at most438 bytes; base64url upper bound584 plus prefix/separators/fixed43-character signature is635 characters, below the unchanged MCP4096 input bound. Current native agenda sourceRevision is a structural digest but is omitted from compact output. New report code is a fixed enum-like literal. The largest dynamic validation message is 'Task ' + taskId + ' is not in the current actionable agenda.': at most256 incoming taskId characters with six-byte JSON escaping plus46 fixed ASCII characters. All new time values come from toISOString. The exact compact prototype stored with this draft uses every optional field, maximal counters, all fixed omission paths/counts and fixed read guidance. Deliberately combining mutually exclusive upper-bound fields gives 8486 ASCII JSON bytes for status and 10186 for a report (including the largest dynamic 256-character escaped task message). The future GOAL wait extension gives 12398 bytes. This establishes a conservative fixed generated-fields delta G=16,384 bytes for cf0d and the named future wait extension; it is arithmetic/source proof, not runtime qualification. The finite product test must use the exact implementation schema and reject an unreviewed larger shape. Historical scalar carry is measured separately and must count accepted-report duplication.

## 7. Original replay and effect semantics

Read and validate the original command namespace, binding, principal, input fingerprint and completed phase BEFORE pure projection. Original prepared/running/held rows remain held and never rerun the business effect. Old full completed results are projected from their original stored count/token/accepted fields. New compact completed results replay the validated original compact bytes/values. Neither path writes a receipt, reads/reconciles current canonical status, issues a token or changes receivedAt. Internal lookup()/accepted() continue returning original validated receipts for custody/settlement; the bounded response belongs to execute()'s acknowledgement and replay, not a rewrite of historical originals. A changed canonical agenda during replay cannot alter the original result.

accepted() and settlement retain the same original header proof and mutationId. Canonical status/report JSON remains full. Omitted result details never become a smaller canonical agenda or report payload.

## 8. Required finite gates

New tests/mcp-work-sync-output.test.ts using actual owner/composition/native original authority and actual MCP formatter and the existing authenticated HTTP fixture; reuse existing native-mcp-authority fixtures for authority negatives.

- Independent reported three-CJK reproduction is attributed, not claimed as local RED. Run a new finite unchanged-source baseline for status and report when execution returns; three30k CJK subjects exercise256KiB wire failure, six exercise512KiB receipt completion risk.
- GREEN: full canonical subjects/items and original token/fingerprint persist; bounded status and both accepted/rejected report responses; exactly-once canonical/outbox effects; report truth/caught_up/blocked semantics. Exercise Reporter’s already-accepted reportJournal.ensure return of ORIGINAL read.status, including a large legacy token/lease scalar, to prove the pre-effect original E envelope rather than the fresh token bound.
- Own-transition boundary: use a legal large accepted report fingerprint so G+E is exactly B; perform the real token replacement and accepted-report duplication, then the later guarded read. It must not fail by reserving generated bytes twice. Independent arithmetic control: B=100000, G=16384 and fingerprint JSON-value bytes43346 give score100000 before and after token1-to635 plus report-to-lastAcceptedReport duplication; a rejected-report replacement lowers it to58192. This is arithmetic only until the actual-use-case fixture runs.
- >200 items: suggested taskIds omitted, not sliced; actual parser accepts suggested call; whole-agenda checks retained. Complete team_get pagination covers canonical tasks; briefing guidance does not claim all details.
- Meaningful fixed producer/max escaped MCP payload and largest native header; exact budget and+1 byte; capacity refusal before first command write/effect; unsupported preserved historical essential state refuses before business effects while an original running receipt may exist.
- Large legal stop reason/notes/diagnostics omitted explicitly with no new canonical cap; all manual-stop/control/runtimeAdmission/lease facts retained.
- All compact optional branches/count sums/omission paths fit the proved budget; strict compact replay after changed canonical state keeps original token/count/state and zero effects.
- Old oversized full completed receipt and cold replay: same projection, original receipt bytes unchanged. Malformed compact marker/counts, unprojectable old shape, foreign principal/binding/input, changed payload or replaced original receipt refuse without repair.
- During effect replace only receivedAt/mutationId/additional header key (same original fingerprint): full running-original equality refuses completion; no borrowed capacity proof.
- Existing forced-nudge/outbox/original-input revocation and report token expiry regressions remain required. No build/strict/runtime success is claimed until actually executed.


## 9. Explicit integration appendix for parallel PR #1315 (not merged)

Parallel head e25e3701a8e2601a44e252d9d10163ca66f50346 is based on cf0d. It remains another owner's branch. This draft does not authorize merging or editing it. Its changes overlap composition, command owner, MCP tool input, commandContracts, Work Sync policy types/Reporter/Validator. Integrate explicitly only after the parent branch includes them; preserve the following rather than overwrite with this draft's base.

- The command owner uses the existing WorkSyncInputAuthority union. Goal authority carries its goal association instead of a DO cause; it must retain its original source/mode and original-record checks.
- checkedSource/assertWait, original record/same horizon supersession, task association, goalWaitEnabled and repeated pre/post-await authority checks remain unchanged. Goal forceNudge remains unsupported and no DO outbox/message port is manufactured. Existing accepted-delivery settlement continues filtering DO originals.
- Keep the entire bounded wait block in the original command payload/fingerprint and in compact report/lastAcceptedReport when present. Keep outer report accepted exactly. New goal consumers inspect completed report accepted plus ORIGINAL receipt.payload.wait/header/time; they do not derive goal authority from compact agenda metadata.
- Strict optional wait has kind:'ci'; repository <=256 ASCII repository characters, runId<=24 decimal digits, expectedCommit40/64hex, optional taskId<=128ASCII, horizonAt<=64 date text, fixed status, and optional supersedes(runId/expectedCommit). A deliberately conservative serialization bound allows all64 horizonAt characters to require six-byte JSON escaping, even though such a string is not necessarily a valid date. Exact wait upper bound is 1098 JSON bytes; max report input with wait is 359126 bytes. The DO header with this extra payload and96KiB result remains below512KiB. The separate goal header is source-proved: TeamGoals creates goalId with effectId (36 ASCII); validateGoal additionally bounds any retained safeSegment goalId at128 ASCII and requires a positive safe integer revision. Replacing the DO cause with that maximal goal association gives23,964 header bytes and481,400 completed bytes including this maximal wait payload plus96KiB result. The actual exact-header preflight remains mandatory.
- The all-optional compact prototype including two complete wait blocks is 12398 JSON bytes, below the fixed16KiB generated delta. Original historical wait is preserved and participates in the essential-scalar measurement, never dropped silently.
- Future integration gates: original GOAL status/report and wait/supersession/horizon negatives, >200 task agenda with intact wait, pure retained replay preserving accepted and original payload.wait, DO nudge/settlement unchanged, and exact complete goal-header/result receipt budget. These are pending integration tests, not claims about the unmerged branch.

## 10. Post-commit truth and failure qualification

The new guard does not promise transactionality across the entire existing use case. A canonical commit that succeeds with a degraded metrics/journal projection must still yield the existing accepted:true/projectionDegraded result when the policy returns it. The compact acknowledgement copies those fields exactly. A subsequent genuine port/original-authority failure can leave the original command running/held, as today; it must not manufacture accepted:false or retry a committed report under another ID. Tests must execute the real Reporter with committed/degraded responses and a later guarded read/CAS failure, asserting the existing truthful result or held original, exactly-once business publication, and no replay of the effect. All full-receipt comparison is private; do not emit or persist a new checksum field.
