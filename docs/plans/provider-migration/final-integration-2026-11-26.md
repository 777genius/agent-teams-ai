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
   tree. Qualify the selected Host against the existing verified runtime assets;
   keep separate legacy-runtime maintenance outside this acceptance boundary.
   Never treat queued, skipped or failed checks as successful.

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
- A later bounded-memory Host build and 10 supplemental TypeScript projects
  passed. The root graph and Host test graph still terminated without a result.
  Windows Creation CI on child `0043bc8` then identified two TS2532 errors in
  the new prompt assertions; its TypeScript inputs match integration `25322a4`.
  Guard the optional `savedSettings` in both assertions. A missing prompt still
  fails the same exact-value assertion. Independent review, final fast lint,
  format and whitespace checks passed. Subsequent local dialog and canonical
  typecheck attempts were killed before a verdict; the preceding 19-test success
  does not qualify this revised test file.
- Each of the four existing safe offline-frontend shards was attempted once
  with the original exclusions and test deadline. The first completed nine
  files (787 passing tests and one skipped test) before SIGKILL; the other three
  terminated before a file verdict. No complete shard or complete suite passed.
  Official Node 26.12.1, the Node 24.21.0 Host runtime, MCP build and the canonical
  Node SQLite rebuild were prepared and verified; Electron SQLite was unchanged.
- Runtime #233 is merged at `6021bfb3a40cbe7dfb1f322ebd03937a51f030c2`.
  The final test-only stdin change passed 17 affected synthetic cases; the
  preceding exact source passed the complete 145-case restart file locally and
  native custody in CI. Current Windows qualification remains distinct.

## Verified dependency boundary

The existing published runtime 0.0.161 is sufficient for this Host integration.
Keep `runtime.lock.json`, the current stopped-producer version/archive hash and
its CI assertion unchanged. Runtime 0.0.162, its tag/publication and the old
orchestrator CI are not acceptance gates for #982.

The selected Host starts its own entry under pinned Node 24.21.0 through
`CapturedHostClient`. The existing runtime archive supplies verified Bun and
embedded OpenCode 2.1.4 assets; `prepare-opencode-v2-native.ts` explicitly never
executes `cli.js`. `OpenCodeV2EmbeddedChild` imports the verified embedded graph
directly. The Host has its own authless-loopback policy and 1 GiB native-selector
identity bound. The separate old CLI's Windows OpenCode 2.4.2 file-size and
authless-admission fixes do not change these Host dependencies.

The stopped legacy-import proof deliberately captures the original frontend
producer 0.0.161. Retained legacy sources continue to use their original runtime;
updating that separate path is outside this task. The 17 Desktop scenarios and
P7 use their existing pinned provider tuple, not a new orchestrator release.
Final platform acceptance also includes Retained OpenCode V1/Host V2 original
Desktop and Codex login Desktop, with their original schedule/history controls.
Complete one final app source cohort and preserve all original receipt checks.
Keep #982 open and unmerged into main throughout.

## Accepted Create and custom-project navigation

The owner-routing Desktop lane exposed an accepted config-only Team whose saved
custom cwd was missing from the real project catalog. Preserve the accepted
Create command and its outcome while completing the following UI handoff:

- Capture context, epoch, project, tab and form generation before Create awaits.
  A successor editor or a context A-to-B-to-A transition retires that handoff.
- Read the accepted Team through the existing list action. Its optional
  per-invocation witness attests an actual current published read; a joined,
  superseded, failed or unavailable retained row cannot authorize navigation.
- Close the original creation page before capturing the Team navigation.
  Only that exact intended close may survive its synchronous component unmount.
- For a known local per-project Team, register its original saved cwd and read
  the real project catalog again. Keep owner/path/focus checks across every
  continuation. SSH paths do not enter this local registration recovery.
  Registration failure never submits another Create command.

The initial source-equivalent extraction reproduced all three new regressions
under Node 24.22.3 (three failures; the 31 existing navigation cases were filtered
in that focused run). After the executor recovered, the complete two-file store
suite passed all 70 cases with no failures or skips, using the original HappyDOM
configuration and 15-second test deadline. That run used local base `25322a4`
plus the exact reviewed candidate; the two subsequent `8e59609` changes are in
other test/documentation files and do not change this source closure. Earlier
resource-limited invocations ended before assertions and are not test passes.
The Vitest child exited zero and its complete output/receipt were saved before
an outer evidence wrapper hit a separate trailing-token error; no retest was
used to replace that wrapper outcome. Independent review checked the complete
production diff, the publication witness and the unchanged original navigation
test bodies. Installed Prettier checked all six final files successfully after
formatting; the generated JavaScript ASTs remain equal to the tested versions.
Focused fast lint passed with zero errors and the eight unchanged baseline
React hook warnings. The complete package typecheck script was then attempted
on local `8e59609` plus the final candidate using Node 24.22.3. It exited 137
after 131.197 seconds with only `Killed` in the log, before any compiler
diagnostic; its 240-second observation bound was not reached. No full typecheck
pass is claimed for that attempt. A separate strict six-root check then passed
on local `93d9b49` plus the final candidate: all six original ambient declarations
and 4,288 actual transitive files, exit zero in 14.085 seconds. It inherited the
root compiler options and excludes, changing only the root file selection and
using `GOMEMLIMIT=2048MiB` / `GOMAXPROCS=2`. This supplements the source review;
it does not replace the full package gate. One resource-controlled attempt of
the unchanged full eight-project script used the same Go memory/parallelism
settings. It stopped after 14.435 seconds at the owned 1.5 GiB available-memory
floor, with no diagnostics and no completed gate. All 8,765 captured source and
configuration files remained unchanged; a subsequent observation confirmed the
owned process group was empty. The original exit-137 attempt is retained
separately. Full typecheck, Desktop E2E and canonical current-source CI remain
pending.

The Creation harness also records bounded launcher/CDP failure ordering without
changing inputs, timers, original errors or cleanup. Its six new diagnostic
controls failed against the original harness; the rebased harness passed all
42 ownership/schedule controls with zero skips. Focused fast lint passed with
a bounded V8 heap. The upstream template-picker readiness fix remains present.

Runtime follow-up #234 is now merged at
`b47fbce22748602b9002219f8b4c25ae4ba00ea6`. Its fixture grows the same owned
installer-size file and clears the prior tail, preserving every original byte
layout, full hash and the 15-second deadline. This is separate legacy-runtime
maintenance. The unpublished preparation draft targets that exact commit, but
its qualification or publication is not needed for #982. Preserve runtime
0.0.161 and the original stopped-producer pins for this Host integration.
The current app/Host platform gates remain required; #982 stays unmerged.

## Windows TEST admission barrier publication

The genuine Electron Sentry gate on `8e59609` failed in
`debug-service-admission-race` with Win32 error 32 and broker exit 75
(job [139996468470](https://github.com/777genius/agent-teams-ai/actions/runs/45845060824/job/139996468470)).
The last stage label remains `outer-membership` while the TEST admission barrier
waits; that label does not identify a failed Job membership API. The original
Stop assertion failed before cleanup, so the later drained process census is
not a successful Stop result.

The publisher closes the nonce file and atomically renames it into place. The
TEST reader now allows `FILE_SHARE_DELETE` alongside `FILE_SHARE_READ`, keeping
`GENERIC_READ`, the denial of content writers, the exact nonce/read count,
handle closure, original five-second deadline and all ownership checks.
[Microsoft documents](https://devblogs.microsoft.com/oldnewthing/20211022-00/?p=105822)
that the final name becomes visible before the rename's DELETE handle closes.
This fixes a concrete reader/publisher incompatibility consistent with the
observed error; the raw log does not identify the competing kernel handle.
The change is compiled only into the existing TEST debug-service target.
Independent source review passed. Native Windows execution of the candidate
remains a current-source CI requirement; no local native run was performed.

The same barrier correction was independently published in external commit
`93d9b49e445071aba62962e156dbed572afcc649` while this batch was being verified.
Its complete executable source matches the reviewed candidate; only the
explanatory comment differs. This batch is based on that commit and preserves
its header unchanged.
