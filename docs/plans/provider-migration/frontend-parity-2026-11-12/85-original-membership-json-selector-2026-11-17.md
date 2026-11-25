# Plan85 — original membership JSON-editor selector

**Prospective bounded correction.** Parent `c3405dd78bfe47708410b5714d2025d2ae7a70d9`, tree `4ff0837019c9b3034625e44672ff3520b955cad9`. Actual Source84 publication review is closed. Source authoring still requires independent documentary review and actual document publication closure.

## Original failure and source finding

Job 133870301040 at original head `cd6258fe557b16793fb28b6391d4601a059c8b53` failed at membership step 30: “UI read timed out: original member JSON editor; no mutation retry”, runner 279 → scrollTo 456 → waitRead 204. Raw SHA256: `5b4be9d82636d75cf0855ab11b8ea99ce2ef0367f6e0be29ad88fe1075a56593`.

The runner asks for button text “Edit as JSON”. Current controls `4f79628eb550fb2522f797437211510951a1581a` filter `textContent.trim()`; the product button is icon-only and exposes that name through `aria-label`. Its tooltip is a sibling. This is a source-proven matcher defect, without claiming the only original failure cause.

## Exactly two writable paths

1. `scripts/legacy-agent-host/desktop-live-membership-ui-smoke.ts`: held preimage Git `65e479949a0905cc309226923d4e79ad0a41f94a`, 47601 B / 585 LF, SHA256 `f8444024e930fe985317bc909c19fbfc81175ae1dce6680c852680f8b5011489`. Change only lines 279–280 to:

```ts
  await ui.scrollTo(create + ' button[aria-label="Edit as JSON"]', 'original member JSON editor');
  await ui.click(create + ' button[aria-label="Edit as JSON"]', 'open original member JSON editor');
```

Keep one scroll/one click, original labels, editor focus/input and all later assertions, budgets and cleanup. No extra toggle, retry, fallback, forced state or business input. Runner remains 585 LF.

2. `scripts/legacy-agent-host/desktop-proof-supplementary-sources.ts`: preimage Git `ef4f3d6334dee7f390b7c8a7f16fd483ba6804e1`, 24116 B / 372 LF, SHA256 `9766df211cb7bf79758e351798b00aa654e3fff8aa3f7e7d583d233744cdbf80`. Append these three existing normative sources once to its common roster, preserving every old entry/order and other arrays:

- `src/renderer/components/team/members/MembersEditorSection.tsx` — `823e3319ccac43fcbd8319b247390293b6aece34`.
- `src/renderer/components/team/members/TeamRosterEditorSection.tsx` — `70201ff571039eed85771a324187793396da542a`.
- `src/features/localization/renderer/locales/en/team.json` — `e2507954e3a109cd1a44e9c199ad7ce5e10b0120`.

Root's Source83 roster check finds these absent; expanded desktop proof provenance becomes 1825→1828. Existing runner, controls and CreateTeamDialog pins remain. The 147 fast operands already cover both editable files and stay exactly unchanged. No workflow or product changes, and no new test cases.

## Guards, limits and review

MembersEditorSection 473/497 requires visible member content, ordinary roster mode, showJsonEditor and closed editor; toggle 209–214 opens the existing editor 598–605. Wrapper defaults showJsonEditor=true and forwards hideMembersContent. Current dialog `eff07b53a39c74ed80c0658c6e4a15de6fb18a0e` supplies hideMembersContent=soloTeam; English locale 2172 defines “Edit as JSON”.

Neither runner 259–280 nor the held openOriginalCreateForm establishes actual soloTeam=false. Preserve that uncertainty and the existing refusal if the control is absent; do not add a default-state dependency or force visibility.

Before publication, join both complete preimages and normative leaves to the actual Source84 parent, verify the three additions remain absent and preserve Source83 roster additions. Do not reuse the pre-83 supplementary body. Review exact forward/inverse patch, unchanged leaves and caps. Existing resulting-head CI must verify the original journey; no runtime PASS is claimed by this draft.
