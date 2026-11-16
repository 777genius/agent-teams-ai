# 43. Complete Windows environment admission through existing provider construction

**Selected plan; no source implementation.** Base: `a07e2d68ece77d08e152d7b0de1eb4b85d72ca06`. The eight existing production preimages below and the listed test preimages were inspected at e384 and independently confirmed unchanged in the actual a07 tree. Independent compatibility R2 accepted the amended constructor-membership design and the narrow trusted-plugin rule below. Root will publish the plan-only continuation by CAS; primary remains a07 while its original native gates run. Source implementation requires root's subsequent confirmation, and the actual patch will need independent source review.

## Problem and intended behavior

Review thread `PRRT_kwDORVTEtM63SW4a` is still valid: initial Main selection checks image, launcher and broker but accepts the supplied environment without a complete comparison. Published selection checks only credential-directory keys. The original comment asks for the permitted environment from the same provider construction and explicitly warns that raw-profile equality would reject legitimate OpenCode launches.

The correction is a complete-map predicate in existing Main admission. An environment is admitted only when it is an output of one enumerated current constructor for the independently captured original or exact published-source recipe. Every key outside that constructor's existing replacement/removal set keeps its original spelling and exact value; no arbitrary additional key is accepted. An explicitly captured `NODE_OPTIONS` is preserved exactly.

This is constructor-membership validation, **not independent provenance of Host-owned policy values**. P09 blob `3c97be7075f56945c48b8142e486b0a2f118c17e`, 988–1001 keeps logical Runtime/Team policy and its sole command journal in Host. §38 A.2 preserves complete captured spec, valid env/args, staging bounds and deadlines; A.3 keeps the original hash-bound profile/broker/source guards. §45 preserves original intent/capability. Main must not become another policy owner or read Team journals to reconstruct these choices.

## Enumerated current derivations

| Constructor family | Permitted relationship to captured base |
| --- | --- |
| Claude member, metadata/model/auth; Codex management/login/model/catalog | Exact selected environment. The Codex catalog keeps its original member profile, without the app-server token overlay. |
| Codex app-server member | Add/replace only `LEGACY_AGENT_HOST_TEAM_MCP_TOKEN` through the current endpoint producer. |
| OpenCode V1 member | Use the exact current agent prompt/model/permission and MCP/plugin construction. Change its three unconditional environment fields and its two conditional captured-policy fields only. Keep unrelated config fields and agents exact. |
| OpenCode V1 management/model server | Apply current source/default/model-limit transforms, then exact tool-denial/witness and server-auth overlay. This can start from a management row **or an eligible member/template-derived model probe**; preserve its original association. |
| Windows V1 general local-readiness coordination | Use the actual general builder: finite captured `OPENCODE_*` removal set, five sibling namespace paths below one child of captured XDG data root, five fixed flags, closed coordination config, then management witness/auth. Preserve every other captured entry. |
| Pending source version | Keep the existing shared 16-name filter and exact complete encoded-spec digest gate. |

Ordinary Phase-A coordination remains Linux-only. OpenCode V2 is outside this owner. A shared `serve` argument shape is not a new authority discriminator.

**Current MCP preparation is an explicit derivation.** A member/template seed can receive a strict captured MCP overlay from the existing runtime/prepared/lead-inheritance path before its V1 constructor. Reuse `capturedMcpServersSchema` and `openCodeMcpServers`; Main does not select current catalogs. A schema-valid newly chosen external server is legitimate Host policy. Captured-policy names reserve `team`/the existing companion reserved name case-insensitively, so that branch uses literal `team`. Only the no-policy legacy config branch uses the existing bounded hash prefix and first-free suffix algorithm.

Required Team tool names also remain explicit finite Host inputs from the existing actual tool-list producer. Do not create fake Main Team ports or duplicate a name array. Canonical permission reconstruction may use them only under the selected Team server prefix; they cannot change non-Team permission keys or preserved config.

The added MCP policy plugin must be the original explicit private pin or the trusted shipped artifact captured by Main from the original selected Host. For the default only, admit the already trusted canonical `hostEntry` with the exact `dist/cli.js` layout, then capture its fixed sibling `dist/adapters/providers/OpenCodeMcpPolicyPlugin.js` before Host work. Retain that original path/hash once per Host owner and recheck the pinned artifact at every relevant admission. Custom layouts use their independently captured existing private pin; do not search, resolve a generic loader, use Main-relative `import.meta.url`, or trust candidate path/hash values.

Missing default bytes or an unknown entry layout makes only that derived policy-plugin family unavailable. It must not reject unrelated Claude/Codex, ordinary management, exact-base/no-policy V1 or the existing 1.18.35 no-policy path. There is no later default recapture or alternate artifact fallback. This is a small projection in the existing Main capture owner, not a registry. The later exact source A/B fixture review corrected an incomplete earlier wrapper inventory: `tools/owned-process-broker/nativeEmulatedSourceProfile.ts` runs V1 through `TEST-source-host.mjs` and currently relies on the Host's implicit default plugin. That fixture already independently canonicalizes and hashes the exact shipped policy helper as `helpers[2]`, verifies it in its peer wrapper and retains the same SHA in `TEST_PEER_MCP_POLICY_SHA256`. Before the original profile schema/hash is fixed, copy that same existing reference into the existing V1 member `mcpPolicyPlugin` field. Its provider template already clones that member. This makes the existing original pin explicit without granting candidate plugin authority or adding a wrapper resolver. This is the selected layout contract, not a claim about arbitrary Node wrappers.

**Model/default transforms retain their actual sequence.** Reuse `applyOpenCodeRuntimeSource`, `applyLaunchConfiguration`, `withOpenCodeModelLimits` and the guarded saved-model rebase. Initial compilation and a later member/probe selection can both overlay limits; raw-seed matching must not assume only one differing limit leaf. Decode only the finite differing leaves/options and replay current helpers from the independent base. Never use candidate config/provider JSON as that base. General-readiness provider/options remain the current Host-owned Record with the existing exact npm/selected-model checks, not an arbitrary top-level config exception or a new Main provider policy.

## Small source cut

Extract actual side-effect-free assembly from the four existing provider constructors into `packages/legacy-agent-host/src/adapters/providers/nativeLaunchEnvironment.ts`. Existing constructors call those functions. Random values, endpoint creation, directory creation and retained identities, guards, allocation and cleanup stay in their original closures. Reuse existing pure helpers and schemas; no provider-package patch or artifact repack is involved.

Add `src/features/agent-backend/main/infrastructure/matchesWindowsLaunchEnvironment.ts` for bounded dynamic-input decoding and whole-map equality. Main's external imports use only the package public entrypoint, through the existing owned-process export. Keep current feature placement; add no core, owner, registry, protocol or alternate runtime.

Retain the relevant original typed provider projection from the already hash-bound raw profile, with original recipe kind/association. Put complete environment membership **inside the same original image/launcher/broker selection predicate**, so identical images with different valid environments can select their own recipe.

Apply the same rule to the exact retained source revision. Replace the current HOME/XDG-only component only together with the new complete rule; retaining it would still reject legitimate published coordination. Preserve all account/Team/scope/recipe checks.

Use existing prepare/resume verification and immutable encoded-spec continuity. Do not change cwd policy, wire/frame/launch bounds, deadlines, timers, broker/receipt semantics, cleanup or default activation. Compare maps or current canonical encoding; do not compare incidental Object.entries order, normalize values or merge ambient environment. Existing codec refusal of case-fold aliases remains.

## Exact preimages and size envelope

| Existing production path | Exact blob | Current LOC |
| --- | --- | ---: |
| packages/legacy-agent-host/src/adapters/providers/CodexMemberProvider.ts | `2fe449639596cdb07bf5ef39d8040c65d9d6538c` | 294 |
| packages/legacy-agent-host/src/adapters/providers/OpenCodeMemberProvider.ts | `b98f057ce72161d867b99f01dde0f83e3244c3d2` | 584 |
| packages/legacy-agent-host/src/adapters/providers/OpenCodeManagementHost.ts | `cc3f0253c360dd407720e62bc8c71f3e84926296` | 461 |
| packages/legacy-agent-host/src/adapters/providers/OpenCodeCoordinationProbe.ts | `186171f456cc99a18e12f0b87c4bd508936d6243` | 454 |
| packages/legacy-agent-host/src/owned-process/index.ts | `3b37705c8ea34439d7e8a2bc89753912d9c5e120` | 38 |
| src/features/agent-backend/main/infrastructure/CapturedWindowsCustody.ts | `e84ee4b6e2ff4cea7d468c3173bc0851c59cdeae` | 150 |
| src/features/agent-backend/main/infrastructure/CapturedWindowsRuntimeSources.ts | `c841e367d7c10c6dcc4c5abe752daf03aa571928` | 246 |
| src/features/agent-backend/main/infrastructure/capturedWindowsSourceAssociation.ts | `c732bec2232fca83f033ea378dfcd11a2d14b31f` | 76 |

The two new helper files are expected to remain below roughly 350 and 320 lines respectively. **Every new or changed production source file must remain at or below 800 LOC.** No size-budget baseline increase, code compression or architectural split merely to evade that limit is part of this cut.

Planning envelope after the MCP/model review: about 170–230 existing source lines moved and 250–400 net source lines, plus 200–320 test lines. This is an estimate, not a completed patch. The narrow default capture belongs in the listed existing Main capture path. If actual implementation needs another source path, revise the concrete inventory before touching it instead of adding generic exceptions.

## Existing tests and required evidence

| Existing test | Exact preimage | Extension or preservation |
| --- | --- | --- |
| test/features/agent-backend/capturedWindowsSelection.test.ts | `e6379e4ace2cc874f660c6bb1377592bba52ebb9` | Extend the actual Main callback/file fixture. |
| test/features/agent-backend/capturedWindowsSourceHistory.test.ts | `b6ce74003e2dc27a8e4527bd07298fc2bff2a586` | Extend existing real original source/receipt fixtures. |
| test/features/agent-backend/capturedWindowsSourcePending.test.ts | `1ff48096cf52cde91cd82ac55eddf99f4458896e` | Preserve its existing exact full-spec pending gate; add only a concrete missing case if needed. |

Selection positives must come from actual Codex/V1 constructor seams, not from the Main matcher generating its own expected data. Include nonempty captured immutable entries, deliberate captured loader value, Codex token/member versus catalog, V1 member/management, runtime MCP overlays, eligible member-derived probes and the actual general-coordination pure extraction. Use original TEST namespaces/plugin fixtures; no provider or HTTP execution is necessary for this boundary suite.

Plugin cases must prove the actual selected `dist/cli.js` sibling is captured once and rechecked before prepare/resume; changed/missing bytes and a candidate substitute fail that policy derivation. A custom-layout explicit original private pin remains admitted. Unknown custom layout or absent default artifact leaves Claude/Codex, ordinary management, exact-base/no-policy V1 and 1.18.35 no-policy controls unaffected. Keep a custom-wrapper fixture explicit about its pin instead of treating candidate metadata as a new grant.

Negatives: changed/omitted/added immutable environment, arbitrary newly injected loader key, Windows-case alias, unknown native-config field, changed preserved subtree, substituted plugin, and malformed/unmapped MCP shape. A valid new schema-defined external MCP server is not a universal negative. Exercise both prepare and resume and retain current streaming/hash/FD and cwd assertions.

History positives cover retained A and explicitly published B, cold Main, exact model/source overlay order, member/template-derived probes and **published general coordination**. Keep foreign scope/account/Team and changed-receipt refusal. Preserve Pending's complete spec digest and finite grant lifecycle. Existing retained-transport tests already assert original verification/effect/receipt ordering; no new transport framework is needed.

Compatibility R2 accepts this plan; it is not source approval or execution evidence. After root selects and the concrete source child exists, require independent patch review, current canonical package build/type checks, affected original unit suites, lint and source-size guards, then the existing authorized Windows x64/ARM64 finite TEST acceptance and original cleanup receipts on that exact source. Keep actual real Claude/Codex launches disabled, including version calls; existing Draft guard semantics remain. Broaden testing only for a concrete remaining risk.

The existing a07 in-flight receipts are preserved; they cannot be transferred to a new source child. Constructor source review does not qualify native or packaged behavior, and this cut does not resolve separate P09 source-writer semantics.

Source-bound review: the original [review finding](https://github.com/777genius/agent-teams-ai/pull/1192#discussion_r4568683096), all production/test preimages above, the existing runtime MCP capture/schema, source/model transforms and original constructor/test seams were independently checked at `a07e2d68ece77d08e152d7b0de1eb4b85d72ca06`. The selected provider archive was verified as SHA256 `9d66036c17a4c2bf86dde9171d94d3048e5df6f6f1ee17ff05758e3a7cf2be41`. Independent compatibility R2 report SHA256: `32c6b452891f8bd1c84e72d2b3b8649f4b1d7dd90398fd418d7eed62e39d6d4d`. Source review has not executed providers or tests and does not qualify a future source child.

## Existing finite source-profile compatibility

Extend exactly one existing TEST-input path: `tools/owned-process-broker/nativeEmulatedSourceProfile.ts`, original Git blob `4fcd83a62f974f6710ebc641801a13c6748b396c`, 24869 LF bytes, SHA256 `e8fa8caa024892b616f5e5aaf116c93a294ac82f968532ac88d9a749377ad3e2`, 290 physical lines. The original ARM receipt's SHA256 `438a2096d08d618fb77e9e8f79a3a0b1805564811dfbfd570075923a2470977d` refers to the same source checked out as 25159 CRLF bytes, not the Git blob's LF byte sequence. The sole intended input change is `mcpPolicyPlugin: { ...helpers[2]! }` in the existing OpenCode V1 member branch before `runtimeMemberProfileSchema.parse`/profile publication. Reuse the helper reference selected earlier by the original fixture, without a new read, helper, hash, resolver or input action. Keep management unchanged and preserve all original source pins, profile/schema validation, assertions, action counts, deadlines, cleanup and source A/B provenance. The same path is already an operand of the existing CI fast-lint command, so no additional CI operand is required. Independent exact source review is required before publishing this fixture change.

## Existing CI operand coverage

The original Host Team lane already runs complete typed lint for `src/features`, so that scope covers the new Main matcher. Its separate fast-lint command enumerates 108 Host/test/harness files and does not automatically discover the newly extracted Host helper. Extend only `.github/workflows/host-emulated-acceptance.yml`, preimage `bdafbc763a97fee129c0ee576beddf402b4faf4a`, by appending the following five affected paths to that same command:

- `packages/legacy-agent-host/src/adapters/providers/nativeLaunchEnvironment.ts`
- `packages/legacy-agent-host/src/adapters/providers/OpenCodeMemberProvider.ts`
- `packages/legacy-agent-host/src/adapters/providers/OpenCodeManagementHost.ts`
- `packages/legacy-agent-host/src/owned-process/index.ts`
- `test/features/agent-backend/capturedWindowsSourceHistory.test.ts`

The changed Codex/Coordination/Selection paths are already in the original operand list. Append `test/features/agent-backend/capturedWindowsSourcePending.test.ts` only if that planned existing test is actually changed. Preserve every original operand in its original order, all commands, full typechecks/typed lint, steps, selectors, jobs, failure conditions and deadlines. This is one additional validation-only path; the eight existing production paths and two planned pure helpers are unchanged. Independent source R2 must verify the exact operand-only diff before publication. No manual CI action is selected.

The CI YAML already contains 1,351 lines and is outside the repository's production-source file-size guard. The selected operand-only result has 1,356 lines: before Git blob `bdafbc763a97fee129c0ee576beddf402b4faf4a`, after `0107fe66a86e21f00c3a51ecb6ef637be1f0fc9f`, SHA256 `a80b3170e2414616a8024b03c7e7c875894505806f6bfaf493caf09baa697799`. Independent R2 verified the complete before/after bytes and all 108 original operands; only the five listed operands and required terminal continuation change. This clarification preserves the established 800-line production-source limit and every baseline; it creates no code-size exception.

## Incoming CI operand reconciliation

Before the fixture amendment was published, the shared continuation advanced from `5628a6160d900cca41d5818253e67c6e626bf01e` through `0e3cc604d163702dbb6e2047264a04e1eddb835a` to `036d2341a7812492882dc6b738e10e9ecf55cb4c`, tree `4c50c09d9a52398bee6bf26da6e2c2616b96e2cb`. Retain both commits, the complete Plan29 extension and its exact independent evidence file. Their existing workflow change appends three direct-I386 owners (`nativeGate.ts`, `nativeGateDiagnostics.ts`, `nativeGateEvents.test.ts`) to the original fast-lint command. Plan43 is unchanged at that incoming head.

Rebind only this plan's five already selected operands to the actual incoming workflow, rather than restoring its older preimage: before Git blob `94a3d304b8d07213c4b568d95cfe569fc7e82f88`, 105052 bytes / 1354 lines; prospective after `9ee39ebd4ede06e28d08050694f91de67121326e`, 105470 bytes / 1359 lines, SHA256 `c2504b4bcb72d5204e146e48b4eea057dfda2c72f9830af9a8f09ac039292343`. Keep all incoming 111 operands in exact order and append the same five Plan43 operands, for 116 total. All commands, guards, timings and other bytes remain unchanged. The earlier five-operand review applies to its historical preimage only; independent exact review of this combined incoming result remains required before source publication. No extra lint invocation, test or CI action is added.

## Complete source candidate and source-freeze coverage

The exact `bd40bff112f6a8f2732f0b48a19e69ae86407e9b` parent tree `18d3f3810ce07123279e81f278927d0ef7b2a4db` was read without truncation; all twelve existing code/test/fixture/workflow preimages below agree, and both new production helpers are absent. The existing source-freeze roster is a further selected validation-only path, with its exact preimage also verified. No unrelated tree entry changes.

**Complete the existing source freeze.** `desktop-proof-sources.ts` composes explicit source arrays and `desktop-source-freeze.ts` hashes exactly the supplied array before and after the original app flow. The two new helpers are not auto-discovered. Append only their two path strings to `scripts/legacy-agent-host/desktop-proof-supplementary-sources.ts`, preserving the complete existing ordered roster and every assertion/call/action/deadline. Original blob `25964490ee05aa48e1a19c9337a6af4c4ffea544`, 21285 bytes / 327 lines; prospective `0fe5cdf19fdd28b224c505d831bea97d89837d05`, 21454 bytes / 329 lines, SHA256 `2ea994f1c1716d1ec3e8f887a0df27212a90bb57cde6ca26f301439b7085d7a4`. This existing roster file is already in the fast-lint command. No recursive source framework or new proof mode is added. Independent exact two-string review must precede publication.

The concrete cut is fifteen paths: eight existing production files, two pure helpers, two extended existing unit suites, one existing TEST source profile, the existing CI operand list and the existing source-freeze roster. Pending is unchanged. The production patch is 639 added / 153 removed lines (486 net); the shared helper is 178 lines, the Main matcher 371 and the largest changed production file 515. The two suites are 478 / 336 lines, adding 462 net test lines. These measured sizes supersede the earlier estimates; every changed production/test/helper stays below 800, and no size baseline changes. The existing 1359-line workflow remains outside the production-source guard.

The larger test estimate comes from actual constructor captures before native allocation, real private plugin/namespace bytes and real retained source journals. Six Selection and four History cases cover complete-map refusals, same-image recipe selection, policy/default/custom layout controls, model/source transforms and published general coordination, preserving all ten original case instances and all 29 textual original assertions. The long bare-model case found during independent review replays the original qualified choice and, only for that same captured provider prefix, its valid bare representation through the existing mapper; it does not enlarge that mapper's input bound or relax output equality.

| Path | Exact before blob | Prospective after blob | Lines |
| --- | --- | --- | ---: |
| packages/legacy-agent-host/src/adapters/providers/CodexMemberProvider.ts | `2fe449639596cdb07bf5ef39d8040c65d9d6538c` | `167e9748a1ff8f39ee73e4cfaf2e08d7f7a34a51` | 290 |
| packages/legacy-agent-host/src/adapters/providers/OpenCodeMemberProvider.ts | `b98f057ce72161d867b99f01dde0f83e3244c3d2` | `edd129db7f8a145641439d5dbd14f17849174bcb` | 515 |
| packages/legacy-agent-host/src/adapters/providers/OpenCodeManagementHost.ts | `cc3f0253c360dd407720e62bc8c71f3e84926296` | `f0ca15ddc74caa16362444e9de7027bca899861e` | 451 |
| packages/legacy-agent-host/src/adapters/providers/OpenCodeCoordinationProbe.ts | `186171f456cc99a18e12f0b87c4bd508936d6243` | `96a7bec05ae0a2c546ad816689a2ba30ded3980b` | 433 |
| packages/legacy-agent-host/src/owned-process/index.ts | `3b37705c8ea34439d7e8a2bc89753912d9c5e120` | `1447d83a16cf8ab8151c2fb6ac5045c638ec4121` | 55 |
| src/features/agent-backend/main/infrastructure/CapturedWindowsCustody.ts | `e84ee4b6e2ff4cea7d468c3173bc0851c59cdeae` | `438f4a8055df627bc75d29278956917cc60388e2` | 176 |
| src/features/agent-backend/main/infrastructure/CapturedWindowsRuntimeSources.ts | `c841e367d7c10c6dcc4c5abe752daf03aa571928` | `87b49dfe4641f8152bb314ae27befa10b27b2f11` | 254 |
| src/features/agent-backend/main/infrastructure/capturedWindowsSourceAssociation.ts | `c732bec2232fca83f033ea378dfcd11a2d14b31f` | `d4d517d42a5e91ab1853fa93910e3752ba745c0a` | 66 |
| packages/legacy-agent-host/src/adapters/providers/nativeLaunchEnvironment.ts | new | `e838ef93378ccb27237891f1b841b3ca07c71a87` | 178 |
| src/features/agent-backend/main/infrastructure/matchesWindowsLaunchEnvironment.ts | new | `8d3abd63b2098c33694f15e211f03753815aff81` | 371 |
| test/features/agent-backend/capturedWindowsSelection.test.ts | `e6379e4ace2cc874f660c6bb1377592bba52ebb9` | `9a895cb0aa68f194c660b037632d5730d297787d` | 478 |
| test/features/agent-backend/capturedWindowsSourceHistory.test.ts | `b6ce74003e2dc27a8e4527bd07298fc2bff2a586` | `45c2c0738de31a316d532280510aaf3bc25ce2ff` | 336 |
| tools/owned-process-broker/nativeEmulatedSourceProfile.ts | `4fcd83a62f974f6710ebc641801a13c6748b396c` | `afe5134ed023b0732ec195a0f25604f3655b7116` | 291 |
| .github/workflows/host-emulated-acceptance.yml | `94a3d304b8d07213c4b568d95cfe569fc7e82f88` | `9ee39ebd4ede06e28d08050694f91de67121326e` | 1359 |
| scripts/legacy-agent-host/desktop-proof-supplementary-sources.ts | `25964490ee05aa48e1a19c9337a6af4c4ffea544` | `0fe5cdf19fdd28b224c505d831bea97d89837d05` | 329 |

Independent production snapshot3 source R2 is ACCEPT (SHA256 `60b72b345c05523deb36175504a6536f6a87c1b0fd4476aa3268b2447ea31c38`); it verifies all eight original preimages, ten postimages and the eleven-line bounded model-replay correction. Independent exact TEST-profile/workflow union R2 is ACCEPT (SHA256 `0e3b2cc3f5d4d8c7e1f0ebab15315624c3794d063421d8e53cb61c00c969d8bd`), including incoming 111 operands and the five selected additions. The frozen test patch SHA256 is `f428bbf5c8b74302749d30c572017908ece3ba85b5e439840536fcb4ab990680`; independent test-source R2 is ACCEPT (SHA256 `6f70d17c6cf86b9f1e3bf1cf6fd6a4443b0ae85f61c6307e0147133267eaef22`) and final source-roster/full fifteen-path binding R2 is ACCEPT (SHA256 `467050671c3ba54ffdf3d00ec0e5c9ae7e8de4ea563201648ab325e8171b15d8`). All of these are source reviews and inert byte checks, not executed tests/types/lint/native qualification. Preserve current useful running original jobs before any primary advancement; no manual Actions mutation is selected.

The final roster review caught an unpublished placement error: the first inert insertion landed at the end of `desktopProofWindowsRetrySources`, which the general Desktop list does not import. The approved result instead inserts the same two strings once, at the end of `desktopProofSupplementarySources`; Process and WindowsRetry arrays remain byte-identical. Root and independent R2 checked the actual consumers: `desktop-backend-smoke.ts` blob `9c724c3895e467bc1db062e5015ded70c30e65e4` captures/freezes `desktopProofSources`; `desktop-packaged-relaunch-smoke.ts` blob `dd53c5b6c019dbe034dcde5375f03123b9b3e10a` adds its two existing paths to that base; `nativeWindowsAppGate.mjs` blob `40d7c19142de2cafdb0a7b433bbedddc216e99da` combines that base with WindowsRetry for the same before/after check. Thus the two additions cover all three existing consumers without duplicates or another roster. This correction and the complete exact fifteen-path approval precede source publication; no runtime/type/test/CI result is inferred from them.
