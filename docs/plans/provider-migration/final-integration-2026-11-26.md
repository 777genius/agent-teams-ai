# Final Stage 1 integration — 26 November 2026

## Goal and boundary

Complete the existing Host integration and preserve current frontend behavior.
Consolidate reviewed child changes into #982 while leaving #982 unmerged into
main. Keep the existing UI, process ownership, retry and cleanup contracts.
Stage 2, default activation and paid-provider testing are outside this work.

## Plan and review refinements

1. Recover the missing leader-prompt change and retain the current #1310 project
   navigation and provider-request fixes. Review refinement: uncertain replies
   must retain the original prompt even after live props acknowledge the write.
2. Repair confirmed task projection gaps: accept the canonical `reviewed` state
   and preserve the original clarification timestamp in both task read paths.
   Review refinement: never invent a timestamp for a legacy task.
3. Integrate main `054e686fa653a8dd81243d882b441bf7735db0cb`: task owner/search,
   indicators, notification settings and release documentation. Preserve Host
   additions when combining the five overlapping files.
4. Run focused existing dialog, filesystem/HTTP Host and Attention tests, then
   TypeScript 7 and source/architecture guards. Independently review both fixes.
   Record native runtime results separately from finite local checks.
5. Publish the existing child, consolidate it into #982 and verify the merged
   tree. Complete runtime #233 and verified dependency delivery without changing
   provenance or treating queued, skipped or failed checks as successful.

## Scope decision

The earlier checkpoint included broad formatting and module extraction. The
current CI does not require a global production format check for every change;
the notification workflow checks its affected production files separately.
Keep this delivery focused on the confirmed behavior and current-main delta.
Format touched files and preserve the existing source-size ratchet; do not
restore a large cosmetic rewrite merely because it appeared in an older draft.

## Estimate and validation

The new behavior changes fewer than 20 production lines, with focused regressions
and the already reviewed main delta. Complexity: 5/10; expected reliability: 8/10;
confidence before final validation: 8/10. These are planning estimates, not a
completion claim. The PR description records actual commits, test results and
remaining platform evidence.
