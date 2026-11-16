# Plan70 actual-source R2

Status: ACCEPT_SOURCE_ONLY. No blocking finding.

Selected parent f8d3b9d2fb07ec4cb26f28bb76d9fc15fa3b49ab and exact plan SHA256 69396e4ccb4d167d333cf64c7d22033b3a6d2224346fcd7ec6b9162bc22a1208 are bound to the frozen manifest 13d7df5a and patch 92707c18. Official selected-parent preimages decode to the exact before bytes.

The two accepted postimages are controls e05bb6778fe2618f94dd4310fe6dad3c10a83ae0, 585 lines, and suite 3eb5191149ed77e27365af1193ece1b9a437f23d, 2893 lines. Independent parsing of all three patch hunks reproduces both complete postimages and both preimages in reverse. Removing only the new 38-line calculation and restoring the one outer guard recovers the entire original controls file byte-for-byte. All 162,195 original suite bytes remain an exact prefix.

## Source findings

The fallback runs only when the nearest scrollport has an empty vertical viewport intersection and the target has nonzero dimensions. It visits the original ancestor chain. The candidate is clipped by the viewport and every clipping ancestor on each relevant axis; a fixed intermediate clip cannot synthesize visibility. If an intervening scrolling port is also unexposed, that port becomes the next reveal target.

The one exposed-center hit can be the candidate or its descendant. Owner resolution starts at the hit itself and must reach that exact candidate, so self-hits work and a different nested scroll owner is refused. Horizontal exclusion, absent/foreign hits and exhausted directional capacity refuse without input. The delta follows the scrollport being exposed, with the original ±600 clamp. A fallback result is always visible:false.

The full old positive-viewport branch, optional center-hit behavior, disabled default behavior, full waitRead, wheel loop, 12/default and 1..32 bounds, final visibility read and 100ms cadence are unchanged. Only the adjacent outer guard is removed; the later per-read guard remains before every original read/retry and every next wheel iteration. No new post-evaluate pre-wheel guard is claimed.

## Regression review

All existing imports, fixtures, cases and assertions are byte-identical. The appended tests use actual createDesktopUiControls and runInNewContext, not a fake helper result. Successful geometry changes follow recorded wheel commands. Exact self/descendant hit routing, above/below movement, a 500px intermediate-port exposure, two-axis/all-ancestor clipping, twelve refusal variants, final-read budget and exact next-read authority Error are covered by source assertions.

No tests were executed. The helper remains naturally below 800 lines and the existing large suite is extended only by the selected append. No workflow, roster, production UI, timer or provider behavior changed.

The original failed evidence remains failed. This review establishes neither an exclusive historical cause nor a Windows 10-second success guarantee. Canonical resulting-source CI and original E2E remain required.
