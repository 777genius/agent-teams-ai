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

## Consolidation and local execution

- Child #1310 is merged into #982 at `7401a0254699cefdbc7120cba06ee384efd73acb`.
  Its tree `60b7fb12ab45210d71e950a23c10b5c7969d22e4` matches the reviewed
  local tree. The 49 Host/filesystem/HTTP/Attention tests and 19 existing dialog
  tests passed; canonical Host build, touched-file fast lint and format,
  source-size and provisioning architecture guards passed.
- The existing real Electron definition-edit bridge smoke exposed a stale
  esbuild-only renderer setup: the current localization graph requires Vite's
  `import.meta.glob` transform. Use the normal Vite dev server, the production
  dependency target, an owned loopback port and sandbox cache. The original
  assertions and 15-second/25-second deadlines remain. The repaired smoke passed
  with actual production preload, renderer API and exactly nine IPC calls.
  Its Main responses are scripted; it does not qualify vendor execution or all
  Host UI flows. Independent source review and fast lint/format passed.
- Full TypeScript attempts remain incomplete: exit 137 under memory pressure,
  including the final canonical retry's Host prebuild. No compiler diagnostic
  or full typecheck success is claimed. The earlier successful Host build and
  focused tests are separate completed invocations.
- Runtime #233 is merged at `6021bfb3a40cbe7dfb1f322ebd03937a51f030c2`.
  The final test-only stdin change passed 17 affected synthetic cases; the
  preceding exact source passed the complete 145-case restart file locally and
  native custody in CI. Current Windows qualification remains distinct.

## Remaining dependency boundary

The app still consumes runtime 0.0.161. Source draft 459500689 for 0.0.162 is
saved with target `6021bfb3a40cbe7dfb1f322ebd03937a51f030c2`, but the remote
tag and binary release do not exist yet. Creating the immutable tag and starting
release workflows awaits the required owner authorization. After real artifact
qualification and approved publication, update `runtime.lock.json`, the current
stopped producer and its CI assertion together; retain historical donor pins.
The release manifest, archive hashes and support provenance must be actual
verified delivery data. Keep #982 open and unmerged into main throughout.
