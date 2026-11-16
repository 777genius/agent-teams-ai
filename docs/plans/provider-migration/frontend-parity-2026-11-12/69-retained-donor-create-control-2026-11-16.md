# B2 retained donor: select the existing Team header Create control

## 1. Original failure and scope

This prospective correction addresses one test caller in the existing retained V1 / Host V2 Desktop journey. It does not change product behavior or select a new acceptance route. The original [job 133637933704](https://github.com/777genius/agent-teams-ai/actions/runs/43959134337/job/133637933704), run `43959134337`, used source `75cf2dcbfe2b540325ea50a022cb5195306a8c59` on `linux-x64` and ended FAIL. Artifact `14278973394` is 481,540 bytes, SHA256 `ad13dbb3f4ce0dc9cd0f2314c5950adb76507125f467116601525a8c4c5fdbef`; original receipt SHA256 is `2914bcd4048475717366c34e333e3f7241865085e5fe3df7902e4cbc588ebbca`.

The core reached all 29 recorded steps: original legacy history, both actual owners, both original Stop controls preserving the other owner, and same-profile cold history without replay. Top and donor cleanup are true, with no cleanup failures. The subsequent donor4a journey stopped at `open original creation`: the global exact-text `Create Team` target had two positive-size matches. The initial target read failed before its hover or click. Only the More and Teams hover/click pairs were recorded in that donor epoch. No donor native input, Task/PNG/Review corpus, normal-Quit result, upgrade/cold readback, or later V1/V2 source-selection journey is qualified.

The shared reader's ambiguity branch returns only `matches`; its parser supplies false for missing geometry fields. Therefore the accompanying `centerInViewport:false` and `hitPresent:false` do not prove an offscreen or occluded target. The later missing source-selection receipts and aggregate FAIL assertion are consequences of the earlier failed step. The selected repair must address the proven ambiguity, not add a wait, scroll, click retry or layout change.

## 2. Existing owner and control identity

The immutable donor is app `4a0e06277fe216d9f82dbbede362668fe46622ee`, tree `4bb456a5b35b6fca0e795bc8b19a13f5f1f6defd`. Its [TeamListView](https://github.com/777genius/agent-teams-ai/blob/4a0e06277fe216d9f82dbbede362668fe46622ee/src/renderer/components/team/TeamListView.tsx) renders Header and EmptyState together for an empty list; Header `onCreate` and EmptyState `onCreateTeam` both invoke the existing `openTeamsCreationPage()` owner. Their exact blobs are `a83b4c18acccd53e9df45e346af813737f925a94`, `11680dec43cd0050f24a2abc868eae0575e03f66`, and `7cd0020110a081447f7eb816728f3a33c77d03c7` respectively.

The existing Header contains a direct `h2` and descendant search input in one group. The next sibling is the Header actions group; its direct Create button invokes that same original owner. The input already has `aria-label="Search teams..."` under the fixture's captured English locale. The EmptyState button is outside this structure. Donor locale blob `7635f35d831e58846d51d6959e372faa9c92b9bc` supplies both `Search teams...` and `Create Team`; original Input/Button blobs `7c6a2f65edee407a06aef45e4f3eb9dd01c2b363` / `a460eed1cbaf3ec1771951fb1073393fdde86401` render the actual input/button elements. No new product marker or generic selector utility is needed.

## 3. Exact one-path source cut

Change only the selector argument of the existing donor-branch call labeled `open original creation` in [scripts/legacy-agent-host/desktop-retained-opencode-app.ts](https://github.com/777genius/agent-teams-ai/blob/0e84576f2cf1be94b464e673713fcd74d7ff33fc/scripts/legacy-agent-host/desktop-retained-opencode-app.ts). The preimage at source `0e84576f2cf1be94b464e673713fcd74d7ff33fc` is blob `4f686cdb2c99ef4f04bb060041bf8ccf6f8601db`, SHA256 `11e064039a9ff28261a2daf41c247d0f6a947e192af03541fc0974d49a0e15ef`, 49,147 bytes / 727 natural lines. The same blob produced the original failure. Recheck this leaf against the actual publication parent; preserve all unrelated work.

Replace that call's first argument, currently `'button'`, with:

```ts
'div:has(> h2):has(input[aria-label="Search teams..."]) + div > button'
```

Keep the original label `open original creation`, exact target text `Create Team`, call position and following `create-team-page` proof unchanged. This is one selector-literal replacement in one existing TEST file; no new helper, branch, fallback, action or import. Natural source length remains 727 lines, below the existing 800-line limit. The shared UI reader still requires exactly one positive-size exact-text match, the original hit test and stable target, then one physical click. A changed or duplicated Header still fails closed. Do not use a first/nth/index match or permit more than one target.

## 4. Preservation and input closure

Preserve the complete original 29-step coexistence prefix and every existing donor Task/PNG/Review/history/Stop/Quit/upgrade/cold suffix action and assertion. Preserve the original 900,000 ms test budget, 30,000 ms target-read budget, all existing per-action/native cleanup budgets, source checks, action ordering, original-process identities and no-replay requirements. Do not change `desktop-ui-controls.ts`, any product component, workflow routing, runtime recipe, pin, archive, custody helper, timeout, diagnostic parser or final qualification predicate.

The historical retained role stays app/stager `1d0f97f55de566036c970eab4f36b84620afdb3f` with runtime `0.0.158`, source `f5c69c2e9024ffc36a5db5eafe30f53539b52f62`, archive SHA256 `4c106fcebab79de525aa7c9bb7636aa91fa43e76b4d567a00f98b2e6650ab29d`. The separate donor4a role stays runtime `0.0.160`, source `e13edcd3d4ffbecc0272ae30195cc6b15b710ee7`, archive SHA256 `09b174841e74c95337f8b1be986f1501a71582ce190671c548bf4c70ab814e10`. Original OpenCode V1 remains `1.19.4`; Host V2 remains native `2.1.4` and the delivered c930 archive SHA256 `9d66036c17a4c2bf86dde9171d94d3048e5df6f6f1ee17ff05758e3a7cf2be41`. Their source-built custody records retain their own exact source identities and `publishedRuntimeComplete:false`. No pin substitution or stronger release claim is permitted.

Existing `assertNativeV1Source` blob `78cb6f0026821785b1d0c0c1ad21ddfe76cdaee4` already covers the entire `scripts/legacy-agent-host` directory. The normal B2 runner invokes that source guard, verifies the complete immutable donor tree and its original 22 selected inputs, and sets English configuration before this journey. Existing general CI already runs `typecheck:legacy-host-scripts` and lists this exact helper in its scoped fast-lint operands. Consequently this cut needs no source-roster, compiler, lint, workflow or artifact-list edit. Keep private metadata sentinels, the genuine Claude/Codex execution prohibition, the captured OpenCode inputs and local model endpoint unchanged.

## 5. Review and actual acceptance

Before publication, retain exact before/after bytes and a single-hunk forward/inverse patch. Verify that only this one selector literal differs and the full surrounding file is otherwise byte-identical; source R2 must confirm the two original controls, their shared owner, Header structure, existing source closure and preservation of all budgets/actions. No new mirror-of-implementation unit test or local project/provider execution is selected for this small harness correction.

The resulting source must pass the existing strict script compiler/lint gates and the original normal B2 journey with its unchanged receipt validators. A successful target read alone is insufficient: final coexistence and donor status, all requested native actions, old/new input identities, no replay, original cleanup and the following source-selection receipts remain required by the existing lane. The prior 75cf core positives apply only to that original head. This draft and its source review do not establish a future source PASS; original normal CI evidence must supply it. No manual rerun, workflow activation, vendor invocation or source afterimage is part of this prospective document.
