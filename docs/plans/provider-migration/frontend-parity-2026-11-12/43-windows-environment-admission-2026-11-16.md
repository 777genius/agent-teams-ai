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

Missing default bytes or an unknown entry layout makes only that derived policy-plugin family unavailable. It must not reject unrelated Claude/Codex, ordinary management, exact-base/no-policy V1 or the existing 1.18.35 no-policy path. There is no later default recapture or alternate artifact fallback. This is a small projection in the existing Main capture owner, not a registry. The bounded contrary-case review found no promised or covered implicit-plugin custom wrapper: the concrete P09 wrapper is Claude, transport wrappers have no V1 MCP, and the actual V1 captured-policy fixture pins its copied plugin explicitly. This is the selected layout contract, not a claim about arbitrary Node wrappers.

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

## Existing CI operand coverage

The original Host Team lane already runs complete typed lint for `src/features`, so that scope covers the new Main matcher. Its separate fast-lint command enumerates 108 Host/test/harness files and does not automatically discover the newly extracted Host helper. Extend only `.github/workflows/host-emulated-acceptance.yml`, preimage `bdafbc763a97fee129c0ee576beddf402b4faf4a`, by appending the following five affected paths to that same command:

- `packages/legacy-agent-host/src/adapters/providers/nativeLaunchEnvironment.ts`
- `packages/legacy-agent-host/src/adapters/providers/OpenCodeMemberProvider.ts`
- `packages/legacy-agent-host/src/adapters/providers/OpenCodeManagementHost.ts`
- `packages/legacy-agent-host/src/owned-process/index.ts`
- `test/features/agent-backend/capturedWindowsSourceHistory.test.ts`

The changed Codex/Coordination/Selection paths are already in the original operand list. Append `test/features/agent-backend/capturedWindowsSourcePending.test.ts` only if that planned existing test is actually changed. Preserve every original operand in its original order, all commands, full typechecks/typed lint, steps, selectors, jobs, failure conditions and deadlines. This is one additional validation-only path; the eight existing production paths and two planned pure helpers are unchanged. Independent source R2 must verify the exact operand-only diff before publication. No manual CI action is selected.

The CI YAML already contains 1,351 lines and is outside the repository's production-source file-size guard. The selected operand-only result has 1,356 lines: before Git blob `bdafbc763a97fee129c0ee576beddf402b4faf4a`, after `0107fe66a86e21f00c3a51ecb6ef637be1f0fc9f`, SHA256 `a80b3170e2414616a8024b03c7e7c875894505806f6bfaf493caf09baa697799`. Independent R2 verified the complete before/after bytes and all 108 original operands; only the five listed operands and required terminal continuation change. This clarification preserves the established 800-line production-source limit and every baseline; it creates no code-size exception.
