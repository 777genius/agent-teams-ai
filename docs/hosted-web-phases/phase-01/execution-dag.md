# Phase 1 execution DAG and ownership

Status: P1.S0, P1.S1, P1.S2, P1.R1, and P1.1D are accepted and integrated. P1.1D is pushed at
`e7e7e734c82c49105682e7a19bbedafa1f5ddbad`. The sole current serial edge is the exact PR #252
five-file base-conflict resolution lane under the unchanged `controller-v17`. End `HOLD`.

## Current DAG

```text
P1.S0 accepted
  -> P1.S1 accepted + integrated
       -> P1.S2 routes + conformance accepted
            -> P1.R1 ACCEPT
                 -> P1.1D remediation
                      -> independent FORMAL ACCEPT P0/P1/P2=0
                           -> accepted integration pushed at e7e7e734
                                -> PR #252 exact five-file producer (one; xhigh/default; no Fast)
                                     -> immutable resolution output
                                          -> independent integration review (one; xhigh/default)
                                               -> explicit ACCEPT or REJECT
                                                    -> runtime true two-parent merge + push
                                                         -X-> P1.R2 -> P1.I -> P1.F -> Phase 2+
```

The earlier r1 worker on the current edge is terminal `failed_no_output`; r2 is its only authorized
replacement. r1 has no reusable output or authority and is never inspected or resumed.

## Binding accepted input and merge pins

P1.1D's accepted review was performed by
`agent-teams-hosted-web-refactor-p1-1d-shadowed-map-review-v17-r4`. The strict result SHA-256 is
`be0c9abd679f817c386d1d06d1b738c2a1505bb3c4718279129ab74842c98fa6`; reviewed output ID is
`f3394026185348c84673d44a9b30a82667c3ff9435b5d4d7609c04785c274f41`; accepted integration is
`p1-1d-shadowed-map-r4-accepted-integration-v3`; and the accepted/pushed target commit is
`e7e7e734c82c49105682e7a19bbedafa1f5ddbad`.

The PR source is `origin/refactor/team-provisioning-round2-reapply`, pinned to
`7afc908ce92f14b4b0ebd06cc4aa3a4cf33807d0`. A moving branch head is not an admissible substitute.

## Current lane registry

| Node                             | Mission                                                                     | Capacity                                    | Packet / revision                                                                        |
| -------------------------------- | --------------------------------------------------------------------------- | ------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `PR252-base-conflict-resolution` | Resolve exactly five PR #252 conflicts byte-for-byte to pinned source blobs | one producer, then one independent reviewer | `lanes/pr252-base-conflict-resolution.md` / `phase-01-pr252-base-conflict-resolution-r2` |

Both workers use `xhigh` reasoning and `default` service tier with Fast disabled. The producer owns
only the five conflict paths and produces an immutable runtime-captured patch. The reviewer owns no
repository path. Neither worker may merge, stage, commit, or push.

## Exact conflict scope

| Path                                                                          | Required final blob OID                    |
| ----------------------------------------------------------------------------- | ------------------------------------------ |
| `src/features/task-board-commands/core/application/TaskBoardCommandFacade.ts` | `f5515ddac4cd7bee957a75bc06aad78309ad3a74` |
| `src/main/services/team/TeamDataService.ts`                                   | `a8fea50ddbd71563f2ab7853978d6420eed6c441` |
| `src/renderer/components/team/TeamDetailView.tsx`                             | `5cbaef7f23046dab598a1c2878811adbfd62ea4c` |
| `test/features/task-board-commands/TaskBoardCommands.e2e.test.ts`             | `0c0a717fea61031c3c24a4ef787c0acd9bd80ad5` |
| `test/main/services/team/TeamDataService.test.ts`                             | `c281cac6493e07abf1ddd201255539e902122af2` |

The producer diff, runtime-recreated merge conflict set, reviewed output, and final merge resolution
set must all equal this exact five-path set. An extra or missing path fails closed.

## Review and integration edges

The independent reviewer reruns both focused test files, the inherited typecheck-baseline
classification, exact five-file `lint:fast:files`, Prettier, diff, blob, secret/private-path, binary,
ownership, provenance, and no-stage checks. Only a complete `ACCEPT` with P0/P1/P2 `0/0/0` permits
`mark_reviewed`.

`mark_reviewed` binds the immutable reviewed output to:

```json
{
  "sourceRemote": "origin",
  "sourceBranch": "refactor/team-provisioning-round2-reapply",
  "sourceCommit": "7afc908ce92f14b4b0ebd06cc4aa3a4cf33807d0",
  "expectedTargetCommit": "e7e7e734c82c49105682e7a19bbedafa1f5ddbad"
}
```

`open_integration_attempt` consumes only `reviewedOutputId`. Runtime creates the true merge and
requires final parents, in order,
`[e7e7e734c82c49105682e7a19bbedafa1f5ddbad,
7afc908ce92f14b4b0ebd06cc4aa3a4cf33807d0]`. A patch-only, squash, synthetic one-parent, reversed,
or moving-head result is rejected.

## Blocked successor

P1.R2, P1.I, P1.F, and Phase 2+ remain blocked through review and integration and until the validated
two-parent merge is pushed. This docs author launches no worker/controller/integration attempt and
performs no fetch, stage, commit, merge, or push. Terminal state: `HOLD`.
