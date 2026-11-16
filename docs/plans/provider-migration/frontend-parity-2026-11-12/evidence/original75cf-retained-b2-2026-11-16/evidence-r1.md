# Original B2 retained coexistence at 75cf2dcb — source-bound R1

**The original job failed in the donor4a suffix before its Create Team click. The retained V1 / new Host V2 core reached all 29 recorded steps, including both Stop controls and cold history without replay. Full B2 remains FAIL.**

## Original evidence

Run `43959134337`, job `133637933704`, artifact `14278973394`, `linux-x64`, exact source `75cf2dcbfe2b540325ea50a022cb5195306a8c59`. Original ZIP: 481,540 bytes, SHA256 `ad13dbb3f4ce0dc9cd0f2314c5950adb76507125f467116601525a8c4c5fdbef`. Original job log: 254,894 bytes, SHA256 `b00b8b4f138a343cfcaa624f33279f0dd49e081714137f7b295b2270024136b3`. Original receipt: 171,552 bytes, SHA256 `2914bcd4048475717366c34e333e3f7241865085e5fe3df7902e4cbc588ebbca`. Independently verified all 13 member bytes, CRCs, safe paths and absence of symlinks; no binary was executed. `62` inert byte/JSON/source checks and six manual source findings are recorded in `review.json`.

## First failure and subsequent failures

The original error is `UI target read failed: open original creation; facts={"matches":2,...}`, at `desktop-retained-opencode-app.ts:507`, reached from `runDonorHistory` after the coexistence core. The shared UI reader waits 30,000 ms for one exact target; its initial read fails before `mouseMoved` or `mouseClick` for Create Team. Donor steps contain only the existing More and Teams hover/click pairs. Donor native process and model observation lists are empty; one initial donor Electron epoch exists, with no successful normal-Quit/corpus proof.

The ambiguity branch in `desktop-ui-controls.ts:207–218` returns only `unavailableTarget` and `matches`. Its reader fills absent geometry booleans with false at 311–316. Therefore `centerInViewport:false` and `hitPresent:false` do **not** establish offscreen placement or occlusion for this failure. The first cause is two positive-size exact-text matches.

The following V1 and V2 source-selection workflow steps require success and were not entered. Their `always()` validators subsequently report missing `retained-opencode-source-selection.json` and `retained-opencode-v2-source-selection.json`; the final coexistence validator then rejects the existing FAIL receipt. These are derivative failures, not three new runtime defects.

## Source-proven caller defect

At immutable donor `4a0e06277fe216d9f82dbbede362668fe46622ee`, `TeamListView.tsx` renders its header and empty state together. Header `onCreate` and empty-state `onCreateTeam` both call the existing `openTeamsCreationPage()` owner. Both render `Create Team` under the forced English fixture. The Header button belongs to the actions group immediately following the heading/search group; its search input has existing `aria-label="Search teams..."`. The empty-state button has no such heading/search group. Original Button and Input primitives render actual `button` and `input` elements with these props.

The current test uses global `ui.click('button', 'open original creation', 'Create Team')`. The immutable source explains the original two-match observation. Selecting the existing header actions button by that heading/search container is a narrow caller correction; no shared uniqueness relaxation, DOM mutation, new test ID or additional click is needed. Exact prospective selector and preservation obligations are in the separate draft; no candidate source exists yet.

## Preserved native and historical provenance

| Role | Original identities |
|---|---|
| Retained app/stager | App `1d0f97f55de566036c970eab4f36b84620afdb3f`, tree `ec540290c86af9755c94e52ac795aeda8586a98f`, lock SHA256 `1311acf34215a47950dd071a23669a69ed866d4825bcde5d21db41302a71d29d` |
| Retained runtime | `0.0.158`, source `f5c69c2e9024ffc36a5db5eafe30f53539b52f62`, archive SHA256 `4c106fcebab79de525aa7c9bb7636aa91fa43e76b4d567a00f98b2e6650ab29d`, executable SHA256 `b9b4c9f786238922cad49f46e5ac147b4e361b182bd250e5fbb47571571059cd` |
| Original OpenCode V1 | `1.19.4`, executable SHA256 `538fcb1b6408c8d4608822acee19f7ff5b3a3eb3383c0633c4f06170857312a7` |
| New Host V2 | Native `2.1.4`, Bun SHA256 `45598a2814020c231575487a560e47d397d6902355d7e08171a2e56221a6d675`, delivered provider archive SHA256 `9d66036c17a4c2bf86dde9171d94d3048e5df6f6f1ee17ff05758e3a7cf2be41` |
| Donor app/runtime | App `4a0e06277fe216d9f82dbbede362668fe46622ee`, tree `4bb456a5b35b6fca0e795bc8b19a13f5f1f6defd`, runtime `0.0.160`, source `e13edcd3d4ffbecc0272ae30195cc6b15b710ee7`, archive SHA256 `09b174841e74c95337f8b1be986f1501a71582ce190671c548bf4c70ab814e10` |

The historical158 and donor160 input records remain distinct and join their own original preparation receipt. Both custody records are `EXACT_RELEASE_SOURCE_BUILD` from their respective exact runtime commit/tree and retain `publishedRuntimeComplete:false`; identical helper hashes do not merge those source identities. Donor inputs include 22 ordered source/artifact pins plus original Node/Electron/runtime/custody/V1 pins. The original runner verifies canonical paths, full donor/custody HEAD and tree, clean source, selected bytes and COMMIT/VERSION. Those original source checks are evidence of the run; this audit did not independently rehash native binaries absent from the uploaded packet.

## Scoped positive behavior and cleanup limits

The core receipt records the initial native legacy history, retained legacy owner, inputs routed to both original owners, both Stop controls preserving the other owner, and same-profile cold UI/history without replay. There are 12 original model observations, five business markers and zero model failures. `native.ts:331–394` places the corresponding native readiness, custody released/closed, original-process presence/absence, task/message equality and no-replay assertions before donor invocation. Legacy history includes the original OpenCode native response; Claude/Codex history lanes are explicitly skipped.

Top and donor receipts both report `cleanup:true` and empty cleanup failures. The core asserted all original native processes absent before donor entry. The donor failure path still runs captured app cleanup and checks original/native TEST namespace absence; the outer finally closes the model and repeats the relevant original process/namespace checks. This qualifies cleanup of the observed failed attempt. It does not qualify the donor suffix's unexecuted Team creation, native business input, Task/PNG/Review/corpus, Stop, normal Quit, upgrade/cold readback or either following source-selection journey.

The donor's private sentinel log records synthetic Codex metadata and refused app-server attempts. The source constructs those private sentinels and points vendor CLI variables at them; they are not genuine vendor executions. Retained `2.777.777 (Claude Code)` is fork metadata. Vendor-auth and release flags remain false.

## Review boundary

Current prospective source `39a00ee65eb4ecfd5ba42c4c0504db837f6db470` independently returns the same target blob `4f686cdb2c99ef4f04bb060041bf8ccf6f8601db` (727 physical lines). `assertNativeV1Source` blob `78cb6f0026821785b1d0c0c1ad21ddfe76cdaee4` already covers the entire `scripts/legacy-agent-host` directory. Existing strict script typecheck and explicit lint operand already include this helper; no roster/workflow addition is necessary. A future source requires its own actual CI evidence. No source afterimage, project command, provider, compiler, test, GUI, CI observation/action or remote mutation was performed for this R1.
