# Phase 1 execution DAG and ownership

Status: current revision is `phase-01-p1-i-format-remediation-router-r1`; terminal state is `HOLD`.

## Current DAG

```text
clean remote-equal canonical b482e816a...
  + accepted lint remediation / existing 69 P1.I inputs
  + terminal P1.I BLOCKED/HOLD; 13 gates pass, exact-74 format fails on one Markdown
                                           |
                                           v
                     seven-path format-remediation router candidate
                                           |
                                           v
                independent router review -> broker integration + push
                                           |
                                           v
                      root exact pushed-authority attestation
                                           |
                                           v
                   exactly one P1.I.FORMAT.REMEDIATION producer
                     gpt-5.6-sol / xhigh / default; Fast prohibited
                     exact Markdown + handoff ownership
                                           |
                                           v
                pinned Prettier writes only routes-ratchets.md
                exact formatter derivation + semantic-token equality
                hashes + exact-two Prettier + diff/scope/scans + self-review
                                           |
                                           v
                   strict result + immutable two-path output
                                           |
                                           v
                                          HOLD
                                           |
                                           v
                    exactly one fresh independent format reviewer
                         read-only, same default-only profile
                                           |
                      ACCEPT --------------+-------------- REJECT
                         |                                  |
                         v                                  v
                   root mark_reviewed             HOLD; no integration;
                         |                         bounded same-two remediation
                         v
              broker integrates + pushes exact two paths
                         |
                         v
        root attests exact new authority + exact two paths + clean remote
                         |
                         v
                     exact 69-input Prettier passes
                         |
                         v
              fresh P1.I.INTEGRATION producer launches directly
              existing 69 inputs -> five new outputs -> all 14 gates
              including exact 74-path Prettier over inputs + outputs
                         |
                         v
              fresh P1.I independent review/integration lifecycle
                         |
                         v
                        HOLD
                         |
                         -X-> blocked five-output attempt is never integrated
                         -X-> P1.F requires a later reviewed router
                         -X-> Phase 2+ / unrelated nodes / successor controllers
```

All workers and reviews are serial. Root is the sole orchestrator. `controller-v17` remains `HOLD`
and observation-only and creates no DAG edge.

## Exact current ownership

The format-remediation producer writes exactly:

1. `docs/research/hosted-web/phase-1/reviews/routes-ratchets.md`
2. `.codex-handoff/phase-01-p1-i-format-remediation.json`

The first file changes only by repository-pinned Prettier formatting. The second records authority,
before/after hashes, exact formatter derivation, semantic-token equivalence, checks,
classifications, self-review, next action, and `HOLD`. A third path, semantic edit, broad cleanup,
generic formatting write, generated repository file, dependency change, registry change, stage,
commit, push, integration, lifecycle action, or runtime action is not a DAG edge.

## Rejected attempt boundary

Patch `d94f8dfa6548427e007402e8771c469c8e661cd64de3a8728dec042a509aebbe` and manifest
`1b88a6e8e53199f0b1905d4f4c194525bcb86db185f0e4748acf60f69bb78f94` belong only to the audited
terminal `BLOCKED`/`HOLD` attempt. They are not a salvage carrier. No DAG edge materializes, applies,
copies, repairs, reviews for acceptance, or integrates that patch or any of its five outputs.

## Transition policy

The format reviewer returns explicit `ACCEPT` or `REJECT`. `ACCEPT` requires zero P0/P1/P2 findings
and complete proof that the exact two-path candidate is pinned-Prettier-derived, semantic-token
equivalent, correctly hashed, and exact-two formatted. Only after root `mark_reviewed` may the broker
integrate and push those paths. `REJECT` cannot be converted into integration authority and cannot
widen remediation.

The fresh downstream P1.I producer owns exactly the existing five outputs and later receives one fresh
independent milestone review. This router pre-authorizes that producer only after accepted formatting
is integrated and a fresh exact 69-input Prettier check passes; no intervening router is required.
The producer consumes the existing 69 inputs, creates five new outputs, and reruns all 14 gates,
including exact 74-path Prettier, without using rejected bytes. P1.F and all later or unrelated work
remain blocked.
