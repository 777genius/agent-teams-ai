# Phase 1: contracts and conformance

Status: **P1.1D independently accepted, integrated, and pushed; PR #252 target binding corrected to
one JIT canonical resolution under `controller-v17`; HOLD**.

## Accepted historical provenance

P1.S0, P1.S1, P1.S2, and formal P1.R1 remain accepted and integrated. P1.1D also has independent
`FORMAL ACCEPT` with P0/P1/P2 `0/0/0` from
`agent-teams-hosted-web-refactor-p1-1d-shadowed-map-review-v17-r4`.

- Strict result SHA-256:
  `be0c9abd679f817c386d1d06d1b738c2a1505bb3c4718279129ab74842c98fa6`
- Reviewed output ID: `f3394026185348c84673d44a9b30a82667c3ff9435b5d4d7609c04785c274f41`
- Accepted integration: `p1-1d-shadowed-map-r4-accepted-integration-v3`
- Accepted/pushed P1.1D commit: `e7e7e734c82c49105682e7a19bbedafa1f5ddbad`

That commit is immutable P1.1D provenance only, not the target/base for the current route. No P1.1D
rerun, reinterpretation, mutation, or reintegration is authorized.

## Current route

The route contains exactly these executable packets:

1. [`controller-packet.md`](controller-packet.md)
2. [`lanes/pr252-base-conflict-resolution.md`](lanes/pr252-base-conflict-resolution.md)

The sole node remains `PR252-base-conflict-resolution`. Its packet revision is
`phase-01-pr252-target-binding-correction-r1`, which supersedes the prior packet's self-staling
target binding and is the only replacement for the terminal `failed_no_output` r1 worker. Neither
the worker nor the superseded packet is inspected, resumed, or reused.

The stable binding `canonicalAtProducerAdmission` means the exact current canonical commit after
this correction router has been accepted, policy-integrated, and pushed. Product-worker capacity is
zero until those steps complete. Immediately before the one producer admission, the unchanged
`controller-v17` resolves the binding exactly once to a full SHA. The controller uses that single
value for every canonical, start, base, materialization, review, merge-metadata, and integration
target field; it never guesses or re-resolves the value.

The PR source remains `origin/refactor/team-provisioning-round2-reapply`, pinned to
`7afc908ce92f14b4b0ebd06cc4aa3a4cf33807d0`. Capacity is serial: exactly one `xhigh`/`default`
producer with Fast disabled creates one immutable resolution patch for the exact five lane-owned
conflict paths, then exactly one fresh independent `xhigh`/`default` integration reviewer with Fast
disabled returns `ACCEPT` or `REJECT`.

## Resolution and integration boundary

All five resolved files must be byte-for-byte identical to their unchanged audited complete blobs at
the pinned source commit. The producer may not merge, stage, commit, push, or modify a sixth path. The
reviewer has no writer or Git mutation authority and materializes only against the resolved
`canonicalAtProducerAdmission` SHA.

After reviewer `ACCEPT`, `mark_reviewed` binds the immutable reviewed output to the exact source
remote, source branch, source commit, and the same resolved full SHA as `expectedTargetCommit`.
`open_integration_attempt` receives only `reviewedOutputId`. Runtime chooses no DAG or branch; it
validates every resolved concrete target field against the current canonical SHA and fails closed on
drift. Only then may it recreate the real merge, validate that the conflict set is exactly the five
lane paths, apply only reviewed bytes, rerun all gates, and create the true merge with parents
`[resolved canonicalAtProducerAdmission, 7afc908ce92f14b4b0ebd06cc4aa3a4cf33807d0]`.

## Successor boundary and HOLD

The validated true two-parent merge must be pushed before P1.R2, P1.I, P1.F, or Phase 2+ can advance.
The authoritative dependency and ownership projection is [`execution-dag.md`](execution-dag.md).

This docs router keeps `controller-v17`, launches nothing, changes only its exact seven owned docs
paths, and performs no fetch, stage, commit, merge, push, or integration attempt. Current disposition:
`HOLD`.
