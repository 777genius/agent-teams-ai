# Phase 1 execution DAG and ownership

Status: producer r3 has independent r4 `FORMAL REJECT`, P0/P1/P2 `0/1/0`. Current revision is
`phase-01-pr252-task-provenance-remediation-router-r2`; end `HOLD`.

## Current DAG

```text
accepted Phase 1 product baseline at 3256ee3b...
  -> direct remote base proof e9ffa30c... + exact five-conflict merge-tree proof
       -> r3 useful output -> r4 FORMAL REJECT 0/1/0
            -> capture rejected ReviewedWorkerOutput 1796cc59... for exact r3 job/workspace
                 -> accepted/pushed predecessor router f5e3ce825...
                      -> current r2 seven-doc correction review -> integration + push
                           -> store pushed r2 commit once
                                -> revalidate decision/job/task/workspace/HEAD/patch/five paths/index
                                     -> exactly one SAME-JOB codex_goal_project_start
                                          -> preserve patch; P1 fix + exact tenth test only
                                               -> r3 self-review + immutable output + HOLD
                                                    -> one fresh independent reviewer
                                                         -> ACCEPT only at 0/0/0
                                                              -> re-run exact ls-remote source pin
                                                                   -> unchanged: ordered broker true merge
                                                                        -> all final gates + source-only test + push
                                                                             -X-> P1.R2 -> P1.I -> P1.F -> Phase 2+
                                                                   -> moved: HOLD + new-base review

stale identities (provenance only):
d2585e7... -> 7afc908... -> e9ffa30c... (active pinned source)
```

Root remains orchestrator. `controller-v17` remains exactly live; replacement and restart are not
edges. This docs router launches no edge.

## Proven identities

| Record                    | Identity                                                           | Authority                                 |
| ------------------------- | ------------------------------------------------------------------ | ----------------------------------------- |
| R3 workspace base/HEAD    | `3256ee3b5b8e81b144aa0a14eac1bca080c9b779`                         | preserved target-side merge baseline      |
| Accepted predecessor      | `f5e3ce8257d05c6ff2a5c19e944d75999868550d`                         | immutable pushed router r1                |
| Current real base/source  | `e9ffa30cc016ad3cb833fcc0a138fa4f026eb850`                         | pinned second parent; direct remote proof |
| Stale GitHub `baseOid`    | `d2585e7634800eb795644c4b6d0e8baf5f81c98f`                         | ancestor by 52 commits; no routing power  |
| Former source             | `7afc908ce92f14b4b0ebd06cc4aa3a4cf33807d0`                         | ancestor of current source; provenance    |
| Rejected reviewed output  | `1796cc59fb1a6c291c54a589ef8a0e10d694b8c61128a5486e5307831afaee9b` | same-job continuation admission           |
| Existing r3 patch         | `f810a0aa191e82316737c5c0069ee6225597d8a477d77b50c57bc3fd931fe579` | preserved reviewed-dirty snapshot         |
| Rejected r3 full diff     | `cb534246905f6fd7cc03b0b761018157ed12d204d11819f0978915af7c778491` | review reference; never materialized      |
| Fresh merge-tree conflict | exact five paths                                                   | active conflict-route proof               |

## Capacity, scope, and transition

Exactly one continuation of existing r3, then one fresh reviewer, is permitted. The continuation
uses existing `codex_goal_project_start` with `reviewedOutputId=1796cc59...`, `forceStart=true`,
`confirmStart=true`, and `dependencyBootstrap=install`. It reuses r3's `gpt-5.6-sol`/`xhigh`/fast
profile. Reviewer envelopes contain no `fastMode`. The reviewed dirty scope is exactly:

1. `src/features/task-board-commands/core/application/TaskBoardCommandFacade.ts`
2. `src/main/services/team/TeamDataService.ts`
3. `src/renderer/components/team/TeamDetailView.tsx`
4. `test/features/task-board-commands/TaskBoardCommands.e2e.test.ts`
5. `test/main/services/team/TeamDataService.test.ts`

Only paths 1 and 4 may receive new bytes: the P1 subject-safety fix and exact tenth E2E regression.
The existing patch in all five paths is preserved; paths 2, 3, and 5 do not change during the
continuation. The workspace remains at `HEAD=3256ee3b...`, reads r2 authority with
`git show <storedRouterCommit>:<path>`, and keeps an empty index. Reviewer owns no path and accepts
only at P0/P1/P2 `0/0/0`.

New jobs, tasks, worktrees, or duplicate starts and any fetch, checkout, reset, rebase, clean rewrite,
rejected-patch replay, or staging are not DAG edges.

The continued worker and reviewer rerun inherited focused tests, the exact native seven-diagnostic TypeScript
baseline, five-path lint and Prettier, index/diff checks, and exact ownership, conflict, secret,
private-path, and binary scans. Broker integration first revalidates the pinned remote head, then
creates the ordered true merge, materializes source non-conflicts, applies the accepted five-path
output, reruns every gate, runs the source-only command-identity test, conventionally commits, and
pushes.

P1.R2, P1.I, P1.F, and Phase 2+ remain blocked until the validated true merge is pushed. Terminal
state: `HOLD`.
