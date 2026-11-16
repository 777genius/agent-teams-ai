# Plan70 exact-source R1

Status: **FROZEN_SOURCE_ONLY**, ready for independent actual-source R2. Root selected the exact prospective plan in `f8d3b9d2fb07ec4cb26f28bb76d9fc15fa3b49ab` (tree `360c8a92c25e65959cf1b53e00587a1911c225c8`). This packet changes exactly the two selected existing TEST paths. No project, compiler, linter, test, provider, native process, GUI or CI execution was performed.

## Bound source and preservation

| Path | Before Git blob | After Git blob | Source delta |
| --- | --- | --- | --- |
| `scripts/legacy-agent-host/desktop-ui-controls.ts` | `1c11809c6458f829bd9bb6995aea2ad60b85511e` | `e05bb6778fe2618f94dd4310fe6dad3c10a83ae0` | +38 / −1 lines; 548 → 585 |
| `scripts/legacy-agent-host/desktop-team-ui-smoke.test.ts` | `a67601fe1a6785b233aef6cacf494661100df472` | `3eb5191149ed77e27365af1193ece1b9a437f23d` | +204 lines; original 162,195 bytes remain an exact prefix |

Both complete preimages were freshly fetched through the official connector at the selected immutable commit and decoded as their exact canonical LF bytes. `official-preimages.json` retains those responses. The complete patch independently reconstructs both postimages and both preimages in reverse. `preservation-proof.json` records 44 inert byte/source checks, not runtime tests. There are three patch hunks and no workflow, source-roster, other helper or production UI changes. The existing large test-suite baseline is retained; the source helper remains naturally below 800 lines.

## Two selected corrections

The added calculation executes only when the original nearest scrollport has an empty vertical viewport intersection and the original target has nonzero dimensions. It walks that target's original ancestor chain. Each candidate is intersected with the viewport and every clipping ancestor on the relevant axes; intervening non-scrollable clipping cannot completely exclude the scrollport being exposed. If a middle scrollport is itself offscreen, that middle port becomes the next exposure goal. The returned wheel direction therefore follows the scrollport, including when it is above the viewport, rather than following target content clipped by that scrollport.

The single exposed-center hit must be the candidate itself or its descendant. Starting at the hit itself, its nearest original vertical scroll owner must equal the candidate. A foreign overlay, different nested owner, missing hit, empty exposed area, incompatible horizontal position or exhausted directional scroll range refuses the read. A valid fallback returns only `visible:false` through the original read; it never marks the target ready. All geometry calculation uses local values inside the same existing DOM evaluation. There is no JS scrolling, DOM assignment, focus effect, extra CDP read or probe input.

The entire old positive-viewport branch, including the original optional target-center hit and default disabled-control behavior, is byte-identical. Its existing wheel dispatch, ±600 clamp, default 12 / explicit 1..32 bound, final visibility read and 100 ms cadence are also byte-identical. The full `waitRead` implementation, 30-second deadline and exception behavior are unchanged.

The only removed guard is the outer `scrollTo` assertion immediately before `waitRead`; its retained inner assertion follows only synchronous argument and deadline work and still precedes every DOM read. All other controls and guards are byte-identical. This packet does not add or claim a new post-evaluate pre-wheel guard. A new loop iteration after a wheel/await still invokes the retained guard before another read.

## Existing-suite behavioral cases

The append uses the existing `createDesktopUiControls` and `runInNewContext` seam. Its small finite DOM objects expose real geometry, parent relationships and computed overflow. Each test executes the actual generated expression; no helper result is stubbed. Successful scene geometry changes occur only after the recorded original wheel. Exact CDP commands reject clicks or other input methods.

| Case | Non-vacuous source assertion |
| --- | --- |
| Already visible inner target | Exactly one guard/read; no hit test, input or step; unchanged visible result. |
| Inner below viewport | Outer self-hit receives +600, then the original inner branch receives +270; visibility remains false until the target is inside the inner port. |
| Inner above viewport | A non-scrolling outer descendant resolves to its original owner. The first delta is −600 despite target content being below; original inner deltas are then +600 and +270. |
| Multiple offscreen ports | First +500 exposes the middle port; incorrectly aiming at the inner port would clamp to +600. The next wheel belongs to the middle, followed by the original inner wheel. |
| Multiple clipping ancestors | The new point is exactly (500, 325), requiring both near and far clipping limits on both axes. The old inner branch adds no hit test. |
| Twelve refusal variants | Missing/duplicate/wrong-text/zero-size targets, no original outer owner, inner or outer fixed clipping, horizontal exclusion, foreign overlay, nested foreign owner, missing hit and exhausted directional range produce no wheel. The fake Date expires the original deadline after the actual refused read. |
| Existing explicit budget | A one-wheel budget still permits its final read but refuses a second wheel with the original timeout message. |
| Ownership changes after wheel | The next guard throws the exact original Error before another evaluate or input; the trace has one guard per actual read and preserves the cross-await check. |

These are source-reviewed additions, not executed passes. All original cases, imports, assertions, fixture bodies and positive-path hit-count expectations remain byte-identical.

## Remaining acceptance

The original Resume75cf receipt remains INCOMPLETE before model selection/Launch. Its retained facts demonstrate the empty-viewport source gap but do not preserve every historical selector count and ancestor rectangle, so this packet makes no exclusive historical-cause claim. It also does not qualify the unrelated PNG CDP timeout, active/pending Quit, missing-model membership result or packaged ARM Retry failure. The redundant adjacent guard's removal carries no timing success claim. Independent exact-source R2 and the resulting source's original canonical CI/E2E remain required before acceptance.
