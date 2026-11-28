# Shared non-key expansion budget: one selector-boundary regression supplement

Status: source/test proposal only. Current production baseline is 0b9477b0afcc0d626cf77851acd35466ce7d4daa. Its implementation supersedes the earlier coordination normalizer proposal; do not implement a competing production change. Execution was unavailable during source review and was restored on 2026-11-28. The production implementation is also present in current source ed6af11110f95d448486934cf451e0f730b2ccd3. No build, RED/GREEN, strict type, lint, hook or runtime result is claimed.

## 1. Reviewed current implementation and exact scope

The current source adds shadowOpenCodeSelectedModelEnvironment and shares one 512 KiB expanded-string budget across each existing selectOpenCodeV2ProviderConfiguration call. The original strict schemas/model mapper, selected-key branch, final 256 KiB JSON check and catalog accumulation remain unchanged. Root and coordination independently source-reviewed the implementation.

For a configuration accepted by the original normalization, let S be the sum of UTF8 byte lengths of final retained string values and J its complete JSON byte length. After the shadow's checked omissions, only the id/modelID and npm/package equality pairs can duplicate a surviving string. Thus pre-normalization expanded string content T <= 2*S <= 2*J. Provider npm's aisdk: prefix adds output bytes; it does not create a larger discarded input. Generated defaults and literal variant IDs also add output. J <= 256 KiB therefore implies T <= 512 KiB.

Here “accepted” means the complete public selector, including its existing final UTF-8 byte check. It does not mean only the embedded-profile schema's separate UTF-16 code-unit check. The actual historical [dadfe selector](https://github.com/777genius/agent-teams-ai/blob/dadfe7440f237d47e4acd6b66d8f4cc236fe2f75/packages/legacy-agent-host/src/composition/openCodeSelectedProviderConfiguration.ts#L278), blob b545b84211d448749a6de96e0ba32a3664d0c452, already checks `Buffer.byteLength(JSON.stringify(configuration)) > 256 * 1024` before returning. The unchanged [captured-configuration adapter](https://github.com/777genius/agent-teams-ai/blob/dadfe7440f237d47e4acd6b66d8f4cc236fe2f75/packages/legacy-agent-host/src/adapters/providers/OpenCodeV2CapturedConfiguration.ts#L67), blob b7f8c661c3cbe06d6fa8c13dc8aab3835e5f5bc8, repeats a byte check after combining baseline and overlay. Three retained 70,000-character strings of three-byte BMP characters therefore already exceed the original selector's byte limit; standalone schema acceptance does not make them an originally accepted selection. The existing alias-boundary regression includes both ASCII and three-byte `漢`, exact 256 KiB acceptance, and refusal one byte beyond that boundary. No new byte limit or change to the embedded-profile schema is proposed by this supplement.

Pinned Zod 4.6.7 confirms the shadow's scope: record and catchall JSON omit `__proto__`; strict object schemas still reject that unknown key. The shadow validates original references in omitted values without joining them. Catchall uses an own declared-key Set, so constructor/toString/valueOf remain ordinary retained JSON keys. This is not a global CPU/latency/RSS claim or a proof for arbitrary effectful environment getters; production captures use the existing original parsed/cloned input. Validation-only traversal still scans original occurrences.

Read exact sources:

- src/composition/openCodeSelectedProviderConfiguration.ts, 0582b6483c465280b368c91807d4270a18712881.
- src/composition/openCodeSelectedModelEnvironment.ts, 01758245c67c12765e221b506ae07d62ae0bb4ab.
- tests/opencode-v2-model-environment.test.ts, 81daf65ae5e70f85203554b5944f8792a1b3781c.
- src/adapters/providers/OpenCodeV2CapturedConfiguration.ts, b7f8c661c3cbe06d6fa8c13dc8aab3835e5f5bc8.
  All repository paths above are under packages/legacy-agent-host.
  Pinned upstream core/schemas.ts blob 2991ecb2730a204b46ae870c1f5271fa568ac6ff; classic/schemas.ts blob 34aca446ff37cf45c8527a68f7b49b28452e46bb, tag v4.6.7.

No counterexample to the 512 KiB accepted-input bound or shadow field coverage was found in this review. Actual implementation/runtime qualification remains open.

## 2. Concrete missing regression

The existing first test proves early refusal inside one oversized string. It does not distinguish a truly shared budget from an accidental fresh budget for every string, the provider subtree, or each nested model subtree.

Add ONE focused test with three finite input vectors. The original twelve test bodies remain byte-identical.

The negative vector contains nine separately legal 65,536-byte strings:

- one provider.options.baseURL replacement;
- four model.settings.custom array entries;
- four model.body.nested array entries;
- then one small model.body.late replacement observed by a separate getter.

Use one exactly 64 KiB provider string beginning with https://example.test/ and one reusable existing 64 KiB model chunk. The raw configuration contains only short tokens and has no selected API key, model alias, provider npm or other string value that changes the nine-chunk arithmetic. Object keys do not consume this expanded-value budget.

At the actual public selector, the ninth chunk exceeds 512 KiB. Assert providerReads=1, modelReads=8 and laterReads=0, the existing configuration-invalid error, and exact unchanged input bytes. Do not assert that the final 256 KiB guard caused the refusal: that guard already rejected the old fully expanded result.

Two positive vectors contain two and three total chunks (provider plus one/two model chunks). Assert the exact complete output, a final JSON size <= 256 KiB, one later getter read, exact expected chunk-read counts and unchanged input. The three-chunk positive spans both nested model trees.

These are selector-boundary acceptance/budget controls. A deliberately long baseURL string is not a claim about the independent delivery/readiness URL schema, successful network use, native qualification or performance.

## 3. Expected discriminating outcomes

Current 0b947 source should accept both fitting controls and refuse the negative before reading the late value. These are static expectations, not executed outcomes.

For the historical unbounded baseline use dadfe7440f237d47e4acd6b66d8f4cc236fe2f75, not 87d0. Dad includes the independently verified removal of the unused 141-character adapter helper that caused TS6133. The selected configuration production source is otherwise the actual previous unbounded version, blob b545b84211d448749a6de96e0ba32a3664d0c452. Build it normally and run this new test against its actual compiled selector. It should read the late value and then fail the getter assertion; both positive vectors should remain accepted.

An isolated diagnostic mutation resetting the budget per string or between provider/model/nested subtrees must likewise read the late value or otherwise fail the exact controls. For a provider/model reset specifically, the eight model chunks fit its wrongly renewed 512 KiB allowance; reading the late value then proves the reset. Any such mutation must be in an explicitly recorded disposable source checkpoint, never a hidden harness, the shared checkout or a published change. Restore the actual current source and verify its source identity before GREEN. If the mutation cannot be performed with that scope, record it unrun rather than claiming sensitivity.

No large stress input is needed: the intentional old negative expansion is 576 KiB plus one small sentinel. Getter instrumentation observes actual public-selector behavior, not a copied budget helper.

## 4. Manifest and execution gates

Only ONE existing test file is proposed for modification:
packages/legacy-agent-host/tests/opencode-v2-model-environment.test.ts.

Append the one reviewed test; retain all twelve current tests and their assertions unchanged. No production module, configuration, cap, timing, key precedence, catalog policy, source owner, KDF or public API change.

After normal plan/source review and publication, use the repository's pinned Node 24.21.0, normal Host build, strict scoped test compilation and changed-file formatting/lint. Record the finite historical/mutation RED controls, then the complete resulting thirteen-case file on the actual current production source. No assertion or inherited strict-option weakening. Reuse the existing broader configuration/bounded-environment cohorts when qualifying the parallel production implementation; this supplement does not invent a new full-suite requirement.

Root owns execution and publication under the existing user authorization and normal local hooks. This test-only correction does not change production source. No manual CI dispatch, rerun or cancellation is part of this plan.
