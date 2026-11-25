# 70. Correct the newly reachable outer-scroll direction

## Exact source boundary

Select only `scripts/legacy-agent-host/desktop-ui-controls.ts` and its existing `desktop-team-ui-smoke.test.ts` on actual `20441967f35c93a5b3ef368ac8d3d0c5ee8eef65`, tree `efd8410417d865adb4ae9b635955273776b6bb0a`. Actual Plan69 byte/tree R2 (`24d63170805927214d42a226d15cdad4aeaf4bfe7c0de0d19961e99d979b7bdc`) closed publication of the reviewed six files. A separate constructive source review then found a direction defect in the new offscreen fallback. Keep primary75 unchanged until this two-path correction closes its source and actual-source gates.

Current controls are blob `ba3fca51b23f523f1c13b6261e70521cc480ee54`, 32248 bytes / 577 physical lines. Current test is blob `1335bed86be957c49f9231be75dc8747b9b60d24`, 167176 bytes / 2775 lines. These full preimages are bound to the actual tree. All other Plan69 changes and Plans63/64/65/68 remain exact.

The new fallback selects an outer wheel surface while the nearest inner scrollport has no viewport intersection. Its delta still uses the target content center. With viewport and outer rectangle [0,681], inner rectangle [-800,-420], and a clipped target at y936 with height58, the current target-center delta is +600 although the inner scrollport needs an upward wheel. Using the inner center -610 yields -600 after the existing clamp. This is a source-constructible counterexample, not a claim that the archived Darwin Resume failure exercised an above-viewport case. The recorded original failure remains unchanged.

## Two-path correction only

Within the existing scroll expression, choose the vertical point used for delta as follows: if the original nearest clip has no vertical viewport intersection (`bottom <= top`), use the center of its original rectangle `p`; otherwise use the existing target center `r.y + r.height / 2`. Keep the existing [-600,600] clamp and subtraction of the actual wheel-dispatch y. A local scalar may make this distinction explicit; do not add a function, module or API.

The nearest clip must remain the sole target-visibility authority. Keep the current ancestor walk, document-element fallback, wheel coordinates, target dimension checks, optional center hit and unique selector/exact-text checks unchanged. The ordinary intersecting-clip branch must compute exactly its previous delta. The existing below-viewport test continues to yield +600 for its first outer wheel. This selection fixes direction only; it does not add a universal clipping/overlay/scroll-boundary routing algorithm or claim such coverage.

Preserve both current owned-renderer guard sites, unchanged waitRead, the entire Plan65 one-hover/one-click settling, 30-second read bound, 100-ms cadence, default12/integer1..32 wheel limit and final no-extra-wheel read. The separate adjacent-guard proposal remains unselected; it must not enter this correction. No Windows native census observation, phase deadline, product/provider budget or cleanup contract changes.

## Meaningful regression in the existing seam

Parameterize only Plan69's new 48-line actual-expression nested-scroll test with below/above finite DOM snapshots. Keep its below data and semantic assertions: initial inner top800, initial target y936/h58, first outer wheel at512/340.5 with delta+600, second inner wheel at600/290 with delta239, and visibility false,false,true. Add the above initial inner top-800 case with the same target content y936/h58 and expected first delta-600. Both must execute the real generated expression with the existing `runInNewContext` and fake CDP, retain the second inner wheel, original selector and wheel-only/no-click checks.

Only the fixture data/name and selected initial-top/first-delta operands may be parameterized. Do not copy the implementation, add timers/frameworks or weaken any assertion. The DOM snapshots change in response to recorded wheels as in the current test; they are finite layout states, not a claim to simulate real browser scrolling distances or timing. Current Plan69 source would send +600 in the new above case, failing the exact wheel assertion promptly. Neither test execution nor browser success is claimed by this source reasoning.

All tests outside the existing Plan69 case remain byte-identical. The complete pre-Plan69 suite is still preserved. No literal selector/class mirror test or unrelated test cleanup is selected.

## Closure and delivery

Both paths already belong to the unchanged1783 source vector and136 fast-lint operands. Existing original safe smoke suite and strict host-script/workspace checks remain the validation routes; no workflow, package, roster, matrix or command is added. Controls stay naturally below800 lines, and the existing test file grows only for the two-case table/loop.

Require prospective R1/R2 and exact ordinary immediate-CAS documentary publication/readback R2 before authoring these two afterimages. Then require complete before/after, strict forward/inverse patch and full-tree preservation plus source R1/R2, ordinary immediate-CAS source publication and actual-source R2. Only after the new direction boundary is closed and a fresh sole CI guard confirms no useful original execution would be lost may primary fast-forward to the reviewed union.

No original result becomes PASS by this correction. Resulting-head original tests/types/lint and affected Desktop journeys remain required. No local project/VM/test/native execution, manual Actions, CI-only commit, external whole-chain adoption, W01/genuineM16 qualification, P09 owner choice, producer archive adoption, Ready/merge/release/default activation is selected.
