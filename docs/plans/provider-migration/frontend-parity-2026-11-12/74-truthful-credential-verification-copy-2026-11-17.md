# 74. Truthful credential verification copy in Settings

## Decision and exact source boundary

Correct the demonstrated unsupported credential retention and rollback promises in the existing Settings presentation. Root selects only the six existing paths below on actual `b3ddf344cbfdb13b152036f5a865c0d3c29365b4`, tree `1150bc2c4e9d6a2b7dda0e4215fe138092402a86`. The closed Plan71 actual-document R2 was read in full: SHA256 `ef70b1201f7688829df2d8ec5e033636eebad8dd9d40263103bff8f1a319dc97`, 13,698 bytes. This base adds only Plan71 documents to actual12d; all six source preimages remain exact. Rebind every selected preimage and roster/reference tuple to the eventual publication parent after queued work; preserve Plans71–73 and every unrelated leaf.

The repository document is `docs/plans/provider-migration/frontend-parity-2026-11-12/74-truthful-credential-verification-copy-2026-11-17.md`, with prospective evidence under `evidence/plan74-truthful-credential-verification-copy-2026-11-17`. Both paths are absent from the complete base tree. This is our Plan74; the reviewed external document numbered 72 is source material, not authorization to adopt its branch, roster or other plans.

| Selected existing path | Exact preimage Git blob | Natural lines / selected boundary |
| --- | --- | --- |
| `src/features/runtime-provider-management/renderer/hooks/runtimeProviderManagementPresentation.ts` | `907fb16a613785324fdbd342c2993e08c8209a55` | 161; exactly three existing return literals, preserve 161 lines |
| `src/features/runtime-provider-management/renderer/ui/RuntimeProviderManagementPanelView.tsx` | `176344903eaee49ced9607a29f28a3c556e59f6e` | 2,584; one existing busy literal, preserve exactly 2,584 lines |
| `test/renderer/features/runtime-provider-management/RuntimeProviderManagementPanelView.test.ts` | `162fb1fccf81b97d1c2b9c741189584016ff3667` | 5,126; replace one existing assertion, preserve natural line count |
| `test/renderer/features/runtime-provider-management/useRuntimeProviderManagement.test.ts` | `c9e19b14b433c58494c10b06eac9f82d5f5cd118` | 6,034; one existing expected string, preserve natural line count |
| `scripts/legacy-agent-host/desktop-opencode-v2-management-ui.ts` | `7f224d52e429bbdecb173d65b470a2ac154de475` | 278; strengthen the same original rejection predicate, remain below 300 lines |
| `scripts/legacy-agent-host/desktop-proof-supplementary-sources.ts` | `eb917dd3cf76a917430b3a0cb3b20ea387307f99` | 349 → 353; append exactly four common source entries |

No new source file, helper, test scenario, dependency, workflow, route, provider implementation, business action, timeout or retry is selected.

## Source-confirmed defect and causal limit

The root-accepted bounded finding is SHA256 `65e7d1753ba29817ed375d13d4d2daeb892971c7bdcfee5fce252477887b64d4`; its reference manifest is `70e816e609855e0443041d4a766653db6dcd2fd8388cf569469ebfa852fd827e`. In current formatter lines 108–132, three error branches append “The new credential was not kept.” using only the error message/code, without checking a retention outcome. Current panel lines 409–410 and 783–798 promise temporary storage, removal on failure and restoration based only on the selected API method and model-verification form kind.

The existing finite V2 UI contract contradicts those unconditional promises: lines 205–209 wait for rejection and then require the rejected TEST key in private auth storage before the screenshot; lines 210–213 perform the subsequent explicit replacement and verify the replacement key. The source-only finding establishes the presentation contradiction. It does not prescribe different credential storage or a universal retention rule for every provider, error or cancellation. No large original receipt/PNG was reacquired for this selection and no historical PASS qualifies the new source. Provider-catalogue failure diagnostics and the unresolved missing-catalogue cause remain separate.

## Exactly four presentation literals

In `formatProviderConnectError`, remove only the unsupported sentence from the three existing branches. Preserve all branch predicates, display-name substitution, rejection reason, guidance, raw error suffix and newline behavior. The resulting return text must be exactly:

- Invalid key: `${displayName} rejected this API key. Copy the key from the correct account or subscription plan, then try again.`
- Account/security policy: `${displayName} rejected the verification request because of an account or security policy. Check the key permissions and account restrictions, then try again.`
- Generic auth failure: `${displayName} could not verify this credential with a real model request.\n${error.message}`.

Do not replace the removed sentence with a claim that the key was retained. Preserve the existing-credential replacement refusal, unclassified error passthrough, success/cancellation copy and all other functions exactly.

Replace the one existing `verifiesWithModel` busy literal with exactly `Saving the credential, then running one minimal model request.` Preserve its branch condition, heading, spinner, live/busy roles, save-only alternative, model/quota warning, operation/state code and all other panel bytes. No credential result or new DTO/state is introduced.

## Two existing assertions and the same original rejection observation

Keep the existing `explains the real model verification while an API credential is being checked` case, every action/mock and both heading/model-request assertions. Replace only its current positive restoration assertion with `expect(status?.textContent).not.toMatch(/temporarily|new credential is removed|previous connection is restored/);`. Keep the existing `keeps the API key draft when provider connect fails` case and remove only the false middle sentence from its exact expected OpenRouter error. Preserve its connect payload, retained input-draft assertion, telemetry and every other assertion. No new test or test framework is selected.

Strengthen only the current `ui.waitRead` labelled `original key rejection visible`, at its exact existing position after the rejected-key submission and before the private auth-file equality. Within that same existing evaluation, query the existing error element once, require it to exist, and reject text matching `/The new credential was not kept|the new credential is removed|the previous connection is restored/i`. Keep the current wait call, original deadline and existing observation loop; add no second waiter, CDP/RPC request, timer, sleep, submit, retry, secret read or screenshot. If false copy returns, this existing bounded observation must fail rather than silently accept it.

Preserve the complete native UI action sequence and every other assertion. In particular, retain rejected-key storage equality, rejection screenshot order, one explicit replacement action, replacement-key equality, model verification, default/inheritance/reload/source checks, all five original Settings intents, and physical cleanup/owner authority. Do not weaken a storage assertion to make corrected text pass.

## Exact current source closure

Append these four literal entries after all 261 current `desktopProofSupplementarySources` entries and before its existing closing bracket, in this order:

1. `src/features/runtime-provider-management/renderer/hooks/runtimeProviderManagementPresentation.ts`
2. `src/shared/utils/opencodeModelRef.ts`
3. `test/renderer/features/runtime-provider-management/RuntimeProviderManagementPanelView.test.ts`
4. `test/renderer/features/runtime-provider-management/useRuntimeProviderManagement.test.ts`

All four are absent from every current main-roster body. Common becomes 265 unique entries; the main Desktop vector becomes 1,787. Preserve the full current 261-entry prefix and the complete Process/Windows Retry arrays byte-for-byte. Do not transplant the external 257-entry roster. The formatter's sole runtime import is the existing pure `opencodeModelRef.ts`, blob `3da89e8154f8072873dc78035e2ea168bc42ca25`, 108 lines with no imports; capture it without editing it or performing generic dependency expansion. No seventh write path or other source admission is selected.

Inert literal-array expansion gives current main SHA256 `ef73662d6baadbb38ee4c7b382c716c87387aa1353ad24939497685c3ce2ed55` and selected resulting main `4d50aac95c4fc8f2e746f60baa22e598f8366339d70a7a0d09b2071579da40c2`; serialization is newline-joined paths with a final newline. The corresponding common hashes are `4460cc1dbcb1ff3ccdf0ae89d727b3a5158e37afadd1118bfd54268f645fe7de` and `eafffa09aae67652da558043f55c0f33b833123964c95ed9c0711b459deb2820`. Removing the four selected paths recovers the entire old main order. These are prospective path-list calculations, not source afterimages or runtime evidence. Recompute them if an intervening selected commit changes a roster.

## Caps, existing checks and delivery

Current source guard `65775f7889470056ef7cd91ad6c56d9351e6cdfc` and baseline `8f5deeed4e406894e1ee587ed541014bcb7dde77` are unchanged. The existing panel legacy cap is 2,584; literal-only edits retain that exact size. Both test paths remain under the guard's existing test exclusions. Other selected files remain naturally below 800 lines. No cap/baseline edit, new exception, formatting pass, statement packing or unrelated extraction is selected.

Use existing workspace types, typed feature lint, the original complete safe frontend shards containing the two existing renderer cases, and the original resulting-source V2 Settings journey when normal CI reaches them. Current workflow blob `bd50fd9636f7b63bf8501bca0c6c5a296e2e21bb` already supplies these routes and the existing UI/roster/hook-test scoped operands. Preserve the entire workflow and all later selected workflow additions; add no workflow routing or manually dispatched acceptance. Existing deadlines, private-file checks, five Settings intents, source/epoch checks and native/Host cleanup remain mandatory. Resulting-head evidence is required; source inspection does not qualify execution.

Root must read and own prospective R1 and obtain independent prospective R2 before immediate ordinary-CAS documentary publication and complete official readback R2. Only then may separately authorized source preparation create six complete afterimages, exact bindings and a reversible patch. Source R1/R2 must verify exactly three formatter literals, one panel literal, two existing assertion changes, one existing UI predicate and four roster entries, with every surrounding byte and unrelated leaf preserved. Rebind the current publication parent before writing; source publication requires complete official bodies/tree/compare/ref readback and independent actual-source R2.

This selection does not change auth/storage/provider operations, source publication semantics, cancellation, replacement, model authority or physical ownership. It does not select Plan40's unresolved A/B writer contract, relax native-first qualification, or claim W05/W07/P09, genuine providers, packaged/release or full migration completion. No project/compiler/test/VM/native/vendor/GUI execution, CI polling/download/manual dispatch, Git/API mutation, defaults, Ready/merge/release or direct-main action is authorized by preparing these prospective documents.
