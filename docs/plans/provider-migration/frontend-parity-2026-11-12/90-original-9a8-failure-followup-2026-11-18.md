# Frontend parity: original refusals and verified follow-ups — 2026-11-18

This report accompanies Draft PR1192 on `fix/frontend-parity-completion-20261113`. [STATUS.md](STATUS.md) remains the single living plan. The fixed PR target is `8d46f13fe87b4a25156b6be8331119eb8d0f790e`. This source composition is based on `c8ab4139c4f3e0f763effffdd44d6412188ba388`, tree `63b10cff826df66f65a917a3cd2e458931983069`.

The composition contains **22 source/test/config postimages**, the public ReviewFlow HTTP-entrypoint README, and evidence. All existing-path preimages were compared with that immutable parent; every postimage SHA1 and SHA256 matched. The six external paths changed between `19b5` and `e114`, and the subsequent `2f33` STATUS/two TEST-file changes, and the subsequent c8 STATUS/readProfile changes are preserved and do not overlap these 22 source paths. The ordinary finite peer, earlier lint corrections and the snapshot `as const` fix were already delivered externally and are not duplicated.

## Changes and their purpose

| Observed boundary | Correction | Preserved behavior |
| --- | --- | --- |
| Native readiness diagnostics | Retain the latest validated private tuple when the public digest and final readiness bit agree. | Conflicting final readiness remains sticky unknown; tuple shape, boolean-chain, byte/capacity and exit-ledger checks remain. This mismatch is not asserted to cause the Windows ARM deadline failure. |
| Finite legacy provider metadata | Complete six required raw-status fields in the retained peer, support both existing summary argument orders and provide its advertised finite model with a fresh 60-second catalog. | Malformed flags, missing fields/catalogs, unsupported models and expired facts still refuse; the exact 9,191-byte PONG/bootstrap/conversation/Stop suffix is unchanged. |
| Main retained import | Supply matched Main descriptor and Host creation-context authority in a small helper before the existing publication. | Opaque runtime/template recipes, admission guards and owner identity remain. The separate retained-original Desktop refusal is not assigned the same cause. |
| Cross-Team trusted input | Passively reacquire the target geometry within the original deadline before issuing the original trusted input. | Owner/effect predicates, deadline and actual transport are unchanged. No atomicity between the last observation and transport is claimed. |
| HTTP collection/store cycle | Add a public HTTP-only ReviewFlow entrypoint and import it instead of the renderer barrel. | The unchanged factory keeps desktop-only refusal behavior; UI and store modules are absent from the new entrypoint. |
| Import policy | Permit only the exact public HTTP root in resolved feature and full/fast global ESLint rules. | Private descendants remain denied; unrelated restrictions are preserved. |
| Trusted ReviewFlow tests | Match the actual FromUser service calls and cover real-controller trusted context and retry feedback preservation. | Existing argument assertions remain; old untrusted primitives must not be invoked. |
| Strict Kanban state | Read the requested state through the existing strict reader before effective ReviewFlow policy resolution. | Both existing reads and default/team policy remain. Corrupt JSON/schema returns the closed safety refusal before status publication. No atomicity is added or claimed. |
| Image-only attachment test | Match the current capability-level PDF refusal in the existing unsupported-file fixture. | The fixture, `ok:false`, error code and production capability/MIME checks are unchanged; no text-to-PDF conversion is inferred. |
| ReviewFlow TypeScript | Regenerate the one missing `reviewFlow.unavailable` declaration and keep the adversarial shared mutable handle outside the readonly snapshot type. | Both UI callers, locales, production readonly contract and original-handle assertions remain unchanged. |

The finite metadata change preserves all 9,191 bytes of the original PONG/bootstrap/conversation/Stop suffix. The supplementary proof roster adds only the authority helper and public HTTP index: 1,880 → 1,882 unique paths, with the previous order retained. Main/UI/supplementary roster sizes are794/41/388 physical lines.

## Executed bounded verification

| Scope | Result | Exact qualification |
| --- | --- | --- |
| Cross-Team helper/deadline | 52/52 PASS | Mocked CDP and VM with exact helper/test postimages. |
| Complete finite provider metadata | 5/5 PASS | Exact 26d source plus retained/test overlays; finite Node peers only. |
| Five frontend/IPC refusal files | 374 PASS | 77 in 4 files plus 297in the IPC file across separate runs on exact88 source with HTTP overlays. |
| Six original199 collection failures | 113/113 PASS | Exact 047 source plus candidate overlay;6 distinct files. |
| Six original88 collection failures | 67/67 PASS | Exact 047 source plus candidate overlay;6 other files. |
| Three original19 collection failures | 57/57 PASS | Exact 19 source plus 17 candidate overlays; session detail/tab UI/session store. |
| Trusted controller cases | 2 PASS, 31 filtered skips | Selected real-controller cases. |
| TeamDataService cases | 3 PASS, 167 filtered skips | The three original failed cases. |
| Runtime diagnostic ledger | 2/2 PASS | Actual projection publisher plus VM receiver; no owner launch. |
| Retained import authority | 2 PASS, 18 filtered skips | Actual Main capture and Host metadata composition; no owner start. |
| Attachment capability suite | 15/15 PASS, 0 skip | Exact 19 Host source aliases; the same fixture and refusal contract. |
| Kanban controller regression | 1 FAIL → 1 PASS, 148 filtered skips | Same selected callback before/after the production change. |
| Original native-member persistence case | 1 FAIL → 1 PASS, 9 filtered skips | Same byte-identical original test; no status publication and corrupt bytes remain asserted. |
| ReviewFlow Host suite | 10/10 PASS, 0 skip | Actual existing test file with shared mutable fixture handle. |
| Translation typing | TS 7.0.2 exit 0 | Actual translation hook/augmentation and both missing-key calls; translation-only project. |
| Full/fast boundary matrix | 90/90 PASS | 45 unchanged cases against each actual resolved config; baseline 82/90. |
| Actual fast lint, 4 files | exit 0 | Both config files and HTTP caller/index; full configured rules. |

The frontend/IPC rows total **611 passed tests in 20 distinct files across separate scoped runs**. Attachment 15, Kanban 2 and ReviewFlow 10 remain separate scopes. Name-filtered skips are not whole-suite passes. The finite witness retains recorded input identities and the source/dependency scope of each result.

Initial archive/dependency collection refusals remain in the finite witness. Exact tracked resources and the already prepared Host dist/dependency links were restored inside the isolated allowed workspace without installing or rebuilding dependencies or weakening a guard. The copied Host closure is not a rebuilt exact-parent native artifact. The first ledger runner failed its input inventory before Node; the corrected inventory names the actually imported `TeamHost.js`, and its lost original stderr is not reconstructed.

The initial combined fast lint retained 261 errors: 260 CommonJS/Vitest undefined-global reports from a controller test outside the normal app `src/` lint gate, plus one real global HTTP entrypoint restriction. The latter is fixed and separately verified. The later 17-file combined lint ended with SIGKILL (-9), no stdout/stderr and no reported file result: **INCOMPLETE**. A combined ReviewFlow test+translation TypeScript project also timed out after 45 seconds without diagnostics: **INCOMPLETE**. Neither attempt was repeated as a broad local gate. Full application types/lint and native/Desktop acceptance still require their own completed current-tree results.

## Source-size policy

The actual exported repository classifier, physical-line counter and evaluator checked the complete e114+22 production composition: **5,161 production paths, 141 frozen legacy exceptions, 800-line limit,zero violations**. The comparison includes external e114 production deltas and the new Kanban 220-line postimage. The generated declaration is excluded by the existing explicit generated-file policy; that policy was not changed. `httpClient.ts` remains 1,864 lines and the full ESLint config 1,168 lines, so neither frozen cap grows. This is an actual policy evaluation over immutable records, not a fabricated Git-checkout CLI pass. The subsequent `2f33 + 22` adoption has exactly the same complete 5,161 production blob tuples; the unchanged classifier excludes all three intervening external paths. This equality transfers only the source-size result, with no test/native result inferred. The subsequent c8 composition was separately evaluated by the same actual classifier/counter/evaluator: 5,161 production paths, 141 frozen exceptions and zero violations. Its only external production change replaces two profile-schema import targets in the same 9-line file; all 22 candidate pre/post bindings remain unchanged.

## Original19 CI findings retained

The remaining 15 original `pull_request`, attempt1 workflows at `19b5bf34d6875ac005e580db9f4c7097a9223f10` reached terminal cancelled states. The 14 previously closed skipped workflows remain retired. Workflow cancellation does not erase results of steps that actually ran:

| Actual job | Result | Scope |
| --- | --- | --- |
| 135034145802, Host frontend shard 4 | FAILURE | 544 files passed, 5 failed, 2 skipped; 6,726 tests passed, 2 failed, 7 skipped. Three collection refusals are covered by 57 local passes; the two executed failures are the attachment and Kanban cases above. |
| 135034134686, Windows Teams | FAILURE | Application typecheck stopped before Electron on two missing translation-key errors and one readonly test assignment. The generated declaration and fixture repair address these exact diagnostics. |
| 135034140873, Windows Stage1 static | SUCCESS | Original Host build/TESTtypes, SPI, generation-policy and static preflight steps completed. This does not qualify cancelled native platform jobs. |

The two failed job logs were captured once before workflow completion and were not fetched again during terminal collection. The static job log and one frontend artifact's metadata were retained at terminal collection; that artifact's bytes were not acquired. All listed 19 workflow/job/log/artifact endpoints are retired. The separate 199 edited-event Windows ledger failure retains its own identity; its PostHog import-cycle case is included in the 297/297 IPC result, without a separate PostHog patch.

The subsequent e114 cohort also closed: 14 skipped workflows and 15 cancelled workflows. Two native jobs began preparatory work but were cancelled before native assertions; the other listed jobs had empty steps. Their original logs/artifact metadata were captured once and retired, without acquiring artifact bytes or inferring cancellation cause. These results do not qualify the 2f33 adoption.

## Final source inventory

| Path | Postimage blob | Physical lines |
| --- | --- | ---: |
| `tools/owned-process-broker/nativeEmulatedSourceProfile.ts` | `a8f9591cbec7a8b36bc8e4e12549415f6b45c4ef` | 401 |
| `packages/legacy-agent-host/tests/runtime-team-host.test.ts` | `6ba2a053de06b1b6f1068cebd56582f0d71c1e43` | 4719 |
| `test/main/services/runtime/AnthropicModelCatalogPicker.safe-e2e.test.ts` | `7a484b411fb0912dae6c129c522eb6c2e239f9c6` | 563 |
| `tools/owned-process-broker/fixtures/retainedLegacyBootstrapPeer.mjs` | `e9718755874f15e6e34a68d0c6d023a607f0f232` | 235 |
| `scripts/legacy-agent-host/desktop-retained-opencode-authority.ts` | `a70c1bc6443f34f4f20bab7864af662ec65e9a6a` | 51 |
| `scripts/legacy-agent-host/desktop-retained-opencode-coexistence.native.ts` | `cbb8fa9df92c73f6aba8ecc34147ec26cd12ce19` | 782 |
| `test/features/agent-backend/desktopBackendFeature.test.ts` | `5ddbca20786812c1506a8d04fe281668dda770ca` | 1388 |
| `scripts/legacy-agent-host/desktop-proof-supplementary-sources.ts` | `20ff0af5b1d83a4ee48b53e8ac5def8da69f88e5` | 388 |
| `scripts/legacy-agent-host/desktop-ui-controls.ts` | `a58d5e94ede5e1385c33646f5ecb8e3ebe01ad68` | 782 |
| `scripts/legacy-agent-host/desktop-ui-controls-deadline.test.ts` | `ec92f7de267420694aa9e0b66b54f3854bba1621` | 911 |
| `src/renderer/api/httpClient.ts` | `d8dd28286d22799642ca35c9806c542ab3ff9822` | 1864 |
| `src/features/review-flow/renderer/http/index.ts` | `124519eda6a605c262593fed10e949fcf5fcd0fb` | 5 |
| `eslint.review-flow-boundaries.mts` | `9b29411a63d3f6114dab09197d7a6b112ca6b5fb` | 158 |
| `test/main/services/team/TeamDataService.test.ts` | `60becfc73eb68c1a661125f77e1d81319ff153bd` | 8918 |
| `agent-teams-controller/test/reviewFlow.test.js` | `c4f61aeedbfe790e4e036ee645774449ddf8e7e1` | 743 |
| `eslint.config.js` | `72ebcd803dd7a3365285f3beb4a06f8fe428bf5e` | 1168 |
| `eslint.fast.config.js` | `417c9b2de448d3c03f971224887e49499c2f2c2d` | 258 |
| `src/features/agent-attachments/core/domain/validation.test.ts` | `66de3a34ef3cdfb46ac14889162131c8fbc34dd5` | 313 |
| `agent-teams-controller/src/internal/kanban.js` | `cd3fd1f6ab9564cc4bd244e1ce0d58c7e6b013a6` | 220 |
| `agent-teams-controller/test/controller.test.js` | `36b6bdfc132020f3e14b84d609ba2a9339df0f32` | 5186 |
| `src/features/localization/renderer/resources.d.ts` | `66c6b12b4c338f8825ffd831839b0ea79a907ed7` | 7172 |
| `test/features/agent-backend/hostReviewFlow.test.ts` | `74e80e374efe9271bc48f97b9825fc4b508358ae` | 128 |
| `src/features/review-flow/README.md` | `0c12798ff5d72b3565807e132a2511cba72d8b5b` | 17 |

## Evidence and remaining acceptance

- [Source composition manifest](evidence/parity-followup-source-manifest-20261118.json) records exact pre/post bindings, preserved external changes and independent reviews.
- [Finite execution witness](evidence/parity-followup-finite-checks-20261118.json) retains completed results, initial refusals and incomplete broad attempts.
- [Evidence index](evidence/head9a8-followups-20261118.json) links tracked snapshot parts, original refusal receipts, independent reviews and recovered historical records.

Historical record coverage is explicit in the recovery index. The previous store-only 110-snapshot draft and complete historical frontend roster/terminal index were not recovered; this report does not claim they are included. Only fetched, hash-verified immutable records are represented as recovered snapshots, and no missing logs, roster entries or observations are reconstructed.

Current full Host/GUI E2E and platform acceptance remain open. Darwin P09 protection failures, Windows ARM completion, startup/readiness, final integration cleanup require their original gates; bounded source tests do not replace them. The external STATUS now records a complete M1 native media/cold-readback/restore/cleanup result on 2f33; that exact-source journal is preserved, without representing a new c8/native execution here. The P09 protected-writer/original-path contract is unchanged. Existing failures and UNKNOWN results are not converted to success, and no deadline, mutation oracle, ownership rule or cleanup predicate is relaxed.

Publication uses the current verified remote parent and an expected-head non-force ref update immediately after commit creation. The resulting original CI cohort is observed separately. There is no manual rerun/cancel/dispatch, real Claude/Codex invocation, merge, release, default activation or Stage2 change. PR1192 remains Draft against its fixed base.
