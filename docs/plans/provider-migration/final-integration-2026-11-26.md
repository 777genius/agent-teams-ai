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

## Consolidated E2E corrections after `5bf15be`

The stack is consolidated into #982; the current open-PR inventory contains no
remaining child of `feat/provider-migration-stage-1`. The integration head before
this batch is `5bf15beb1a667683bc7110bea2cbcda09648cbd8`, against main
`054e686fa653a8dd81243d882b441bf7735db0cb`. #982 stays open, unmerged and without
auto-merge. This batch keeps all runtime lock, stopped-producer and immutable
donor inputs unchanged.

The following corrections address observed failures, with one combined source
update rather than one branch or CI cycle per scenario:

| Observed failure | Correction and preserved boundary |
| --- | --- |
| Mixed/native Create inspected the logical definition after a project launch | Resolve the exact logical-to-project execution relation from the captured registry and owner. Keep config-only checks on the logical definition; route native identities, notices, groups, restarts, history and cold readback to the exact execution. Reject another project, captured handle, changed binding or linked source. |
| Global provider-default proof expected a project grant | Assert the neutral global grant and preserve the separate project override and source bytes. |
| Claude/Codex native gates compared the current Host to an obsolete entry hash | Verify the current pinned Host manifest, archive and installed entry. Immutable donor and native-provider pins remain separate and unchanged. |
| Stopped legacy producer silently selected the new per-project default | Select Shared across projects through the existing Create control. Require the resulting shared metadata and absence of a project alias before retaining the original legacy corpus. The original native team-name, Stop and cleanup proofs remain. |
| Task title tooltip covered the original Complete action | Align a prominent card's tooltip to its start; keep the original clickability assertion and existing compact-card alignment. |
| A captured OpenCode model disappeared despite a successful native catalog read | Retain the scoped catalog row when the app-local provider inventory belongs to a different profile. This affects display only; authentication, capability and launch-readiness checks are unchanged. |
| Expanding a saved Claude model row silently selected Default | Pass the existing saved-selection preservation contract through Launch's lead/member rows. An unavailable explicit model remains visible and held; a deliberate user Default selection still works. Create retains its previous normalization behavior. |
| The native Review fixture advertised Opus while its saved and wire contract requires Sonnet | Scope the existing TEST custom-model option to Sonnet for Review only, preserving Opus in the other modes. The actual native catalog and launch readiness remain authoritative. |
| Standalone notification setup read configuration before TEST path overrides | Defer the backend value import until those original overrides are applied. The same eight endpoint/vault assertions pass locally. |
| Legacy V2 installation selected an oversized newer CLI | Capture the installer target in Main. Use the bundled qualification for legacy acquisition/update discovery and the Host qualification for captured Host acquisition. Preserve the existing byte bounds, no-downgrade checks and shared install exclusion. Report an existing oversized legacy selection truthfully. No orchestrator release is needed. |
| Canonical validation reported TS2532 in two prompt regressions | Assert the single API call before taking its non-null tuple; retain the same exact prompt assertions. The complete existing file passes all 19 cases. |

Local Node 24.21.0 and the pinned pnpm 11.22.0 were used with a frozen lockfile.
The Host/MCP builds, Host test type project, Desktop Host script type project,
source-size ratchet and provisioning architecture guard pass. Focused regression
results include 25 mixed fixture cases, nine project-selection cases, nine
captured-default cases, four receipt cases, 24 Kanban card cases and the original
shared-history integration. Installer/IPC policy passes 208 cases and the captured
Main/Host publication/status suite passes 24. The scoped model visibility suite
passes 106 renderer cases; real saved-model picker/roster coverage passes 13,
with the original Host launch CAS regression also passing. The native Review
fixture suite passes ten cases, including real private-profile preparation
without starting Host or a vendor executable. Both model-display regressions
first failed against the preceding implementation. These are finite/local
proofs, not native Desktop acceptance. The complete canonical typecheck was
attempted normally and twice with bounded Go memory/parallelism; all ended with
exit 137 and no compiler diagnostic. Its full gate remains pending in CI.

On the preceding published head, 26 of 32 workflows succeeded; the notification,
packaged Anthropic endpoint and V2 cold Dashboard workflows failed, and three
workflows were still queued or running. Native owned-process gates and Host
process fixtures succeeded on all their required platforms. The canonical
Desktop matrix and Host emulated acceptance still require a final source cohort;
successes from preceding commits do not qualify this batch.

Retained failures remain explicit: the Anthropic endpoint scenario now captures
bounded read-only form/card identities and redacted renderer exceptions to
distinguish reset from publication failure. The V2 Review failure on source
`0043bc8` consumed a probe with expiry `1795723930677`; the original Runtime
model-readiness refusal was recorded at `1795723930711`. This is an expired
original proof, not permission to extend its lifetime or allocate anyway. No
readiness deadline, retry, native assertion or cleanup gate is weakened.

The later saved-import artifact `15153379851` retained a passing UI proof and
ordinary app exit zero, but cleanup correctly remained incomplete: build-service
PID 9609 (esbuild, originally parent 9521) survived the original three-second
observation. Host PID 10836 was absent. No native Host leak is inferred from the
build-service PID, no further signal is authorized by that old group, and no
cleanup deadline or success criterion is changed. The next source cohort must
complete both the UI flow and its original empty-process census.

## Post-publication frontend route audit

The consolidated corrections were published as
`565824e1e6beb52d18a60115174d316d20308457`, tree
`f788a73b3ba8615084ceb9f8c70f54b3cb3fb935`. The published tree exactly matches the
locally reviewed tree. #982 remains open, unmerged and without auto-merge. Its
32 natural workflows were queued at the latest observation; the canonical plan
had no allocated runner. No manual rerun or change to a gate was made.

Comparing the actual frontend callers with the Host adapter found four further
missing routes. Existing draft deletion, legacy secondary-lane actions and raw
Claude logs were checked against their real UI gates rather than being counted
as missing Host behavior merely because a legacy method exists.

| User-visible route | Completed implementation and boundary |
| --- | --- |
| Copy launch diagnostics | Read the exact Host launch and Runtime observations, preserving launch/roster/member generation/attempt, project family, scope and mutation fences. The bundle explicitly identifies Host evidence, marks partial observations and redacts private values; it does not invent legacy artifact paths or classifications. The existing legacy copy format is preserved. |
| Member activity metadata after message refresh | Read the latest 200 logical messages through the original signed Host pages, retaining the 100-record page cap, fragment assembly and one feed revision. Reuse the existing pure legacy projection and authored timestamps. Message counts and termination signals are message facts, not native readiness authority. |
| Group delivery confirmation | Project a minimal original delivery identity from authorized completed command lookup. Read only that member/generation/input and recheck the original command and owner. Native acceptance or its terminal observation confirms delivery, not successful task execution. Pending or unknown delivery remains explicit under the original UI observation budget; there is no resend, legacy ledger fabrication or cross-principal adoption. Host-local commands without an actual delivery ID remain without native delivery. |
| Live tools on the team graph | Reuse the existing approval activity observer and its single timer. Project recorded Host observation times and actual tool/result events into the ordinary store and graph. Check the captured physical team, launch, roster, member generation, attempt and exact active input; reset uncertain activity on gaps, context changes and unavailable observations. Undated retained events do not acquire invented times. |

Independent source review found no remaining blocking findings in these four
routes. Completed local proofs include 32 launch-diagnostics API/UI cases,
27 member-activity/transport/legacy cases, and 54 combined original-receipt,
Host delivery API and group-notice cases. The unchanged Host mutation and task
submission recovery suites each passed another 22 cases. The new tool activity
suite passes all 14 cases through the real API, store and graph; the existing
approval UI suite passes ten cases. The final approval-read suite passes six
cases, including three injected graph-observation failures that preserve an
independently observed pending approval without relaxing its response gate.
Each regression verifies that its injected failure was actually reached. The
unchanged Runtime activity facade suite passes all 12 cases, including the
NDJSON-to-production-facade route after canonical Team input.

The original tests, timeouts and native checks remain intact. Shared-memory
pressure killed local workers before a verdict and briefly disconnected the
executor. The worktree survived restoration. The final six approval-read and
12 Runtime-facade cases then passed together with the same assertions and
timeouts, using the pinned Node executable and a bounded V8 heap. Neither a
killed worker nor previous-head CI is counted as final acceptance. Current-source
canonical validation, native Desktop and Host emulated acceptance remain
required before this integration is declared complete. Runtime 0.0.162 and
merging #982 into main remain outside the task.

The normal `pnpm typecheck` was attempted once more after the environment
restored its available memory. Its Host and task-ledger prebuilds passed, but
the root compiler was killed with exit 137 before any TypeScript diagnostic;
this is not a successful typecheck. No scope or compiler checks were removed.
Formatting and the unchanged 800-line guard required extracting the existing
Host team-view projection into its own module. Both function bodies were
compared exactly with the original; only the exported name and import changed.
All three adjusted frozen legacy caps are lower than their values in the parent
commit.

The existing `test/features/agent-backend/tsconfig.json` project found three
type errors at the message-receipt union boundary. The delivery reader now
explicitly rejects the group-product discriminant before reading a message
receipt, without a cast or relaxed identity check. Independent review passed;
the unchanged feature TypeScript project then passed with zero diagnostics.
The final Host delivery API suite passed all 28 cases, including two new
wrong-receipt cases, after the earlier combined 54-case delivery run. Final
fast lint, formatting, whitespace, source-size and provisioning-architecture
checks passed. The focused typecheck is not a substitute for canonical CI.
