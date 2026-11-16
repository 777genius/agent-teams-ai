# Plan 72 — truthful credential verification copy in Settings

## Decision and scope

Correct the demonstrated credential retention/rollback claims in the existing Settings presentation. This is a six-existing-file repair: two presentation files, two existing test expectations, the original V2 Settings rejection read, and its supplementary source roster. Preserve the provider operation, credential storage, cancellation, API/DTO, model verification, source publication, and native ownership behavior. Do not add a new helper, test suite, workflow, route, provider implementation, timeout, retry, or business action.

The prospective source base is `c4e7a936a4c13eb944eb80763c66b8cd1993d16b`. Recheck the six exact preimages against the publication parent before preparing/publishing source. Independent prospective review and publication of this selection precede source afterimages; source review and canonical existing checks remain separate gates.

## Original evidence and causal limit

Original source `75cf2dcbfe2b540325ea50a022cb5195306a8c59`, run `43959134362`, job `133621515611`, artifact `14280940415` produced a Settings receipt with `status: PASS`, 68 recorded steps, and five original local model intents. Its `credentials.rejectedKeyRetainedUntilExplicitReplacement` and `credentials.successfulReplacementVerified` are both true. The original UI helper checks the rejected TEST key in the private auth file immediately after observing rejection and before taking the rejection screenshot; it replaces the key only in the subsequent original action.

The rejection PNG SHA-256 `c3824336f05c5958f029db55ca3eb865977b3d66f7f3d99319c39f31a9767d85` visibly says: “The new credential was not kept.” The generic `auth-failed` presentation branch emits that sentence without a credential-retention result. The same unsupported sentence appears in its invalid-key and account/security-policy branches. The busy panel likewise promises temporary saving, removal on failure, and restoration of the previous connection. The original evidence establishes that those unconditional promises are false for the observed V2 flow; it does not establish a universal retention rule for every provider/error/cancellation path.

The original Settings receipt is 860,677 bytes, SHA-256 `a297113fb281ffb402511aeeb3d87094cf45458eeeb7b5a886d6457efd4da6da`; the archive is 1,348,641 bytes, SHA-256 `dd6453b55d46671ae1502b55000db2cc9305632388a367a28742be381078f732`. The root's separate original-evidence audit is SHA-256 `5b5205bddf4ba05318611f564a20f8bae7264659a2a71788187ce2ed9abc6674`. This scoped Settings positive does not qualify the later live-membership continuation, which failed independently, or the whole job/current candidate. Plan 71's failure-status observation remains separate.

## Exact six write paths

| Existing path | Current Git blob | Natural lines and planned bound |
| --- | --- | --- |
| `src/features/runtime-provider-management/renderer/hooks/runtimeProviderManagementPresentation.ts` | `907fb16a613785324fdbd342c2993e08c8209a55` | 161; three existing return literals only, no line growth needed |
| `src/features/runtime-provider-management/renderer/ui/RuntimeProviderManagementPanelView.tsx` | `176344903eaee49ced9607a29f28a3c556e59f6e` | 2,584; one existing literal, preserve exactly 2,584 |
| `test/renderer/features/runtime-provider-management/RuntimeProviderManagementPanelView.test.ts` | `162fb1fccf81b97d1c2b9c741189584016ff3667` | 5,126; one existing expectation, preserve natural line count |
| `test/renderer/features/runtime-provider-management/useRuntimeProviderManagement.test.ts` | `c9e19b14b433c58494c10b06eac9f82d5f5cd118` | 6,034; one expected string, preserve natural line count |
| `scripts/legacy-agent-host/desktop-opencode-v2-management-ui.ts` | `7f224d52e429bbdecb173d65b470a2ac154de475` | 278; strengthen one original read predicate, remain below 300 |
| `scripts/legacy-agent-host/desktop-proof-supplementary-sources.ts` | `e191694db8ccd8bbd2e05bcdbcacd8cb1703e23c` | 345 → 349; append four explicit common entries |

The existing source-size guard is blob `65775f7889470056ef7cd91ad6c56d9351e6cdfc`, with baseline `8f5deeed4e406894e1ee587ed541014bcb7dde77`. Its frozen legacy cap for the panel is 2,584; keep that cap and file length unchanged. The two existing test paths are excluded by the original guard's test-path rules. All other changed files remain below 800 natural lines. No baseline edits, new exception, compressed formatting, or extraction for a size cap are selected.

## Exact presentation and test changes

In `formatProviderConnectError`, remove only the unsupported sentence from its three existing branches. Preserve branch predicates, display-name substitution, original rejection reason, guidance, raw error suffix, and newline behavior. The resulting invalid-key text is `${displayName} rejected this API key. Copy the key from the correct account or subscription plan, then try again.` The account/security-policy text is `${displayName} rejected the verification request because of an account or security policy. Check the key permissions and account restrictions, then try again.` The generic auth failure is `${displayName} could not verify this credential with a real model request.\n${error.message}`. Do not replace the removed sentence with a universal claim that the key was kept.

For the existing `verifiesWithModel` progress branch, use exactly `Saving the credential, then running one minimal model request.` Keep its heading, busy/live roles, spinner, alternate save-only text, model/quota warning, and branch condition unchanged. Cancellation copy, the existing-credential replacement refusal, empty-response handling, and all operation/state code are outside this repair.

Retain the two existing test scenarios and every action/mock/other assertion. In `explains the real model verification while an API credential is being checked`, keep the heading and model-request assertions, and replace only the positive restoration assertion with `expect(status?.textContent).not.toMatch(/temporarily|new credential is removed|previous connection is restored/);`. In `keeps the API key draft when provider connect fails`, remove only the false middle sentence from the exact expected OpenRouter error. Preserve the exact connect payload, retained input-draft assertion, telemetry assertions, and all other test bodies. No new test or mock framework is needed.

## Original native UI read and source closure

Strengthen only the existing `ui.waitRead` for `original key rejection visible`, at the same position between the original rejected-key submission and private auth-file assertion. Its existing DOM evaluation must still require the error element and also require that this element's text does not match `/The new credential was not kept|the new credential is removed|the previous connection is restored/i`. Use the existing evaluation/read call and original deadline; add no separate CDP/RPC request, waiter, sleep, retry, submit, secret read, or screenshot. Do not change the following original `privateJson` equality, explicit replacement action, successful replacement equality, five model intents, or any remaining Settings/default/inheritance/reload/cleanup step. A regressed false claim must make the existing bounded read fail, rather than be silently accepted.

Append exactly these four literal entries to `desktopProofSupplementarySources`, after all 257 original entries and before its existing closing bracket, in this order:

1. `src/features/runtime-provider-management/renderer/hooks/runtimeProviderManagementPresentation.ts`
2. `src/shared/utils/opencodeModelRef.ts`
3. `test/renderer/features/runtime-provider-management/RuntimeProviderManagementPanelView.test.ts`
4. `test/renderer/features/runtime-provider-management/useRuntimeProviderManagement.test.ts`

The common roster becomes 261 unique entries. Preserve the entire original ordered prefix and the Process and Windows Retry arrays byte-for-byte. These four paths are absent from both original Settings (1,789 paths) and membership (1,777 paths) source vectors and from the current common roster. The formatter's only runtime import is `opencodeModelRef.ts`, blob `3da89e8154f8072873dc78035e2ea168bc42ca25`, SHA-256 `7a337f9349bb13357764eb4d2dd950c2a4bb669e671e645cac703be3ef40ce69`, 108 natural lines, with no imports of its own. Capture this existing pure dependency; do not edit it, perform generic import discovery, add another source admission, or expand the write inventory. Existing type-only contracts and already selected renderer/native construction remain unchanged.

## Review and acceptance

Before source publication, verify all six preimages and postimages, a complete reversible patch, exactly three formatter literals plus the one panel literal, only the two selected test expectations, one existing UI predicate, and four roster strings. Verify all surrounding provider/state code and original native action/authority/custody/deadline/cleanup assertions are byte-preserved. Record natural line counts and the unchanged guard/baseline. Independent actual-source review must assess the exact frozen cut.

Use the existing canonical type/lint/renderer tests and original V2 Settings journey when normal CI reaches them; do not add workflow routing, a manual run, or another acceptance scenario. The two existing renderer cases must pass with truthful text. The original Settings journey must retain its existing five model intents, 68 recorded business/UI steps, rejected-key and replacement auth checks, source/epoch bindings, original requested Quit, native/Host absence, model cleanup, and default/inheritance/reload checks while refusing the false copy at the original rejection read. New evidence belongs to its actual source head; the old 75cf result cannot qualify this repair or other failed suffixes.

This plan and its R1 are prospective source/evidence work only. No project, compiler, test, provider, native, GUI, or CI execution is authorized here. Genuine Claude/Codex, Ready, merge, release, default activation, and Stage 2 remain outside the existing authorized work.
