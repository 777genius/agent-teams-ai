# Phase 1 execution DAG and ownership

Status: current revision is `phase-01-p1-i-lint-remediation-router-r1`; terminal state is `HOLD`.

## Current DAG

```text
P1.R2 ACCEPT 0/0/0 -> accepted P1.I router -> canonical 0d7f904ab...
                                           |
                                           v
                      seven-path lint-remediation router candidate
                                           |
                                           v
                independent router review -> broker integration + push
                                           |
                                           v
                      root exact pushed-authority attestation
                                           |
                                           v
                   exactly one P1.I.LINT.REMEDIATION producer
                     gpt-5.6-sol / xhigh / default; Fast prohibited
                     exact source + test + handoff ownership
                                           |
                                           v
               remove only redundant assertion + focused diagnosticId test
               focused Vitest + full lint zero + typecheck 7/0/0
               Prettier + diff/scope/scans + self-review
                                           |
                                           v
                 strict producer result + immutable three-path output
                                           |
                                           v
                                          HOLD
                                           |
                                           v
                   exactly one fresh independent remediation reviewer
                         read-only, same default-only profile
                                           |
                      ACCEPT --------------+-------------- REJECT
                         |                                  |
                         v                                  v
                   root mark_reviewed             HOLD; no integration;
                         |                         bounded remediation only
                         v
             broker integrates + pushes exact three paths
                         |
                         v
        root attests exact new authority + exact three paths + clean remote
                         |
                         v
                fresh full pnpm lint at zero errors
                         |
                         v
          existing P1.I.INTEGRATION producer launches directly
          69 immutable inputs -> 13 files / 60 tests -> five outputs
                         |
                         v
             existing P1.I independent review/integration lifecycle
                         |
                         v
                        HOLD
                         |
                         -X-> P1.F requires a later reviewed router
                         -X-> Phase 2+ / unrelated nodes / successor controllers
```

All workers and reviews are serial. Root is the sole orchestrator. `controller-v17` remains `HOLD`
and observation-only and creates no DAG edge.

## Exact current ownership

The remediation producer writes exactly:

1. `src/shared/contracts/hosted/app-error.ts`
2. `test/architecture/hosted-web/phase-1/contracts/app-error.test.ts`
3. `.codex-handoff/phase-01-p1-i-lint-remediation.json`

The first file changes only by deleting the redundant assertion. The second adds only the focused
regression. The third records authority, checks, hashes, classifications, self-review, next action,
and `HOLD`. A fourth path, broad cleanup, formatting write, generated file, dependency change,
registry change, stage, commit, push, integration, or runtime action is not a DAG edge.

## Transition policy

The remediation reviewer returns explicit `ACCEPT` or `REJECT`. `ACCEPT` requires zero P0/P1/P2
findings and complete proof that the exact three-path candidate passes full lint at zero. Only after
root `mark_reviewed` may the broker integrate and push those paths. `REJECT` cannot be converted into
integration authority and cannot widen remediation.

The downstream P1.I producer retains its five-output ownership and its later independent milestone
review. This router pre-authorizes that launch only after accepted remediation is integrated and a
fresh post-integration full lint passes at zero; no intervening router is required. P1.F and all later
or unrelated work remain blocked.
