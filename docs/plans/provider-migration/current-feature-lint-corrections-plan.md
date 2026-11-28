# Current CI lint and formatting corrections

Status: source-reviewed plan candidate; no implementation, lint or test PASS is claimed.
Baseline evidence: original CI run 46131875301, source d4b1e1c7752cefdf9123f39eb91ecd63fba07be4, job 140953507514 reports nine errors.
Current integration source: ed6af11110f95d448486934cf451e0f730b2ccd3; separate Goal integration last reviewed: 185292238137130c9439774f26f6d51f7a63205b. All seven original CI-lint files were checked byte-for-byte on source 567464 and Goal 185292. Incoming ed6af changes only the separate group-refusal formatting file and therefore preserves all seven originals.

## Confirmed scope

The projectBackendResult import ordering was already corrected in an incoming commit. Preserve that change. The historical feature-job evidence identifies eight remaining diagnostics in the first five files below; the sixth file is the OAuth behavior-preservation test, the seventh is the separate renderer diagnostic. The complete remaining edit manifest is these seven existing files. The newly observed Notification formatter failure has already been corrected by incoming ed6af; preserve it without a duplicate edit. Confirm the applicable diagnostics with normal current-source tools after environment recovery. No rules or gate configuration changes.

1. src/features/agent-backend/contracts/groupChats.ts: normal import sorting only.
2. src/features/agent-backend/renderer/createHostCrossTeamApi.ts: normal import sorting only.
3. src/features/agent-backend/main/adapters/output/projectTeamSessionHistory.ts: remove the unnecessary assertion on the projected logs index; preserve validators and output.
4. `src/features/token-usage/main/infrastructure/__tests__/CodexJsonlUsageImporter.test.ts`: remove the unnecessary assertion on the selected test event; preserve all token/accounting assertions.
5. src/features/runtime-provider-management/main/adapters/output/CapturedProviderOAuth.ts: PreparedOAuth becomes an interface; split directResult memoization and creation assignment from their enclosing expressions; replace the preparation try/Promise expression with an immediately invoked async function whose try awaits prepare and returns the existing discriminated value/error outcome.
6. test/features/runtime-provider-management/capturedProviderOAuth.test.ts: one parameterized behavior regression for synchronous preparation throw versus rejected preparation promise while the original journal read is blocked. Preparation starts synchronously, duplicate requests join the same original result promise, no effect occurs, original release exposes the preparation error, and a fresh retry proves retirement.

7. src/renderer/components/team/teamSessionHistory.ts: remove only the unnecessary assertion on the guarded selected legacy history entry.

## OAuth ordering and ownership

The replacement async function invokes prepare synchronously, before its first await and before the scheduled original journal read. Caller context capture must remain immediate. pending is inserted into active first; existing pending.result and directResult Promise identities remain stable; the function must not become an async connect wrapper. Existing read-before-effect logic, candidate captures, terminal original replay, cancellation cleanup and resource ownership do not change.

Use:
const preparation: Promise<PreparedOAuthOutcome> = (async () => {
try {
return { value: await prepare(() => this.assertPending(pending)) };
} catch (error) {
return { error };
}
})();

Memoization uses pending.directResult ??= result.then(() => undefined); followed by return pending.directResult. Creation uses pending.creation = this.deps.intents.create(intent); then const created = await pending.creation. A synchronous create throw stays within the existing outer catch, with createAttempted retained.

## Validation and integration

After reviewed plan publication, run the existing formatter/import sorter on only these files, normal TypeScript and typed lint, then the existing capturedProviderOAuth and projection/token usage cohorts. These OAuth preservation controls are expected to pass on both the unchanged baseline and the refactor; do not label them a product-bug RED. The original lint/format diagnostics are the failure witnesses for this correction. Check existing OAuth tests explicitly cover synchronous preparation capture, both thrown/rejected preparation, same-request promise identity, cancellation while original discovery/preparation is pending, and cold original replay. Independent R2 found that preparation failure itself is not covered by the downstream crypto failure case; add exactly the sixth-path regression described above. Existing original-context capture, pending-cancellation and cold-replay tests stay intact. Do not add tests merely for formatting.

Review the final diff again for promise timing and original-record safety. Preserve the separately prepared Windows reader; it edits another file. Coordinate future C Main changes so the same OAuth lifetime rules survive. Rebase by normal merges and publish with current-head CAS only after local hooks and checks.

## Separate historical failures

The large-message fixture now explicitly captures the intended 1 MiB runtime budget, and the Codex cost UI now uses the existing fullscreen control before exact reply visibility. Those incoming fixes are preserved, not reimplemented. Both need current-source CI/native qualification; historical failures are not marked PASS by source inspection.

## Independent source review

R2 independently reread all five complete current files at 0e7f75f837e2f9079bcc6bb98d4e6e57334c53b5 and the actual historical job log. Their source matches the edafe baseline. Root R3 rechecked the full immediate-capture and promise-identity flow. The added sixth path is an explicit narrow test amendment, not a change to production scope. Execution was unavailable during those source reviews. The executor was restored on 2026-11-28; publication and code application still require normal local hooks and meaningful checks.

## Renderer job follow-up

The historical renderer lint job 140953507550 of the same d4b run later completed with one error and 1,559 warnings. Its sole error is an unnecessary assertion in src/renderer/components/team/teamSessionHistory.ts: the selected legacy[index] after the explicit index < 0 guard. Add exactly this seventh existing edit path and remove only that assertion. Runtime branching, chronology sorting and open-ended window behavior remain unchanged. The existing session-history validation cohort, normal current renderer types and typed lint qualify this correction; no formatting-only test or rule change is added. The feature-job nine historical errors and this renderer-job one error are separate evidence; one feature import fix is already inherited.

The historical d4b Desktop Create job 140953507723 is a separate unresolved native/UI diagnosis. Its detailed phase-specific evidence is retained outside this lint plan. Do not infer that an unavailable original UI target proves a missing reply after Send. This plan makes no native Create/cleanup qualification claim and changes no deadline, cleanup proof or behavioral assertion.

## Inherited Notification E2E formatter correction

Workflow 46161230111, job 141028777574 checked out source 567464. Both real Electron and standalone Node exercises and the Require both real E2E outcomes guard succeeded; only Check production source formatting failed. Its exact diff changed whitespace outside strings in src/features/agent-backend/renderer/createHostGroupChatsApi.ts. The workflow as a whole remains a failure at that historical source, despite its successful E2E steps.

Incoming commit ed6af11110f95d448486934cf451e0f730b2ccd3 has exactly that one-file +4/-2 correction, parent 567464, blob 3896b88cf5edca3779e895993a35efd1955e107b. It matches the separately reviewed 7437-byte, 195-physical-line candidate with SHA256 776283ca7725c42f6759d6dd3ecc4ce84c1a0e8b2f3be72b459e496baa537dd5. All non-whitespace tokens and original command/refusal/lookup guards are preserved. Do not reapply it, add it to our remaining edit manifest, or make a competing Goal-only formatting commit; retain the normal parent/Goal integration. The old eight-path draft is superseded by this seven-path plan.

This inherited source correction does not transfer historical E2E PASS to the new head or establish that its new full CI has passed. Keep normal resulting-source qualification; no manual rerun, cancellation, new formatting-only test, gate weakening, or hook bypass. Publish this reviewed docs-only plan through normal gates before implementing the remaining seven-file correction; run the existing scoped formatter, typed lint, necessary behavior-preservation cohorts, strict types, source-size guards and normal hooks, then review the final diff and publish against the fresh expected head.
