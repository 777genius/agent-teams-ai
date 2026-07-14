# Phase 1: contracts and conformance

Status: **P1.1D independently accepted, integrated, and pushed; one exact PR #252 five-file
base-conflict resolution lane current under `controller-v17`; HOLD**.

## Accepted provenance

P1.S0, P1.S1, P1.S2, and formal P1.R1 remain accepted and integrated. P1.1D now also has independent
`FORMAL ACCEPT` with P0/P1/P2 `0/0/0` from
`agent-teams-hosted-web-refactor-p1-1d-shadowed-map-review-v17-r4`.

- Strict result SHA-256:
  `be0c9abd679f817c386d1d06d1b738c2a1505bb3c4718279129ab74842c98fa6`
- Reviewed output ID: `f3394026185348c84673d44a9b30a82667c3ff9435b5d4d7609c04785c274f41`
- Accepted integration: `p1-1d-shadowed-map-r4-accepted-integration-v3`
- Accepted/pushed commit: `e7e7e734c82c49105682e7a19bbedafa1f5ddbad`

The accepted commit is the target/base for the current route. No P1.1D rerun, reinterpretation,
mutation, or reintegration is authorized.

## Current route

The route contains exactly these executable packets:

1. [`controller-packet.md`](controller-packet.md)
2. [`lanes/pr252-base-conflict-resolution.md`](lanes/pr252-base-conflict-resolution.md)

The sole node is `PR252-base-conflict-resolution`, packet revision
`phase-01-pr252-base-conflict-resolution-r2`. It is the only replacement for the terminal
`failed_no_output` r1 worker; r1 is not inspected, resumed, or reused.

The PR source is `origin/refactor/team-provisioning-round2-reapply`, pinned to
`7afc908ce92f14b4b0ebd06cc4aa3a4cf33807d0`. Capacity is serial: exactly one `xhigh`/`default`
producer with Fast disabled creates one immutable resolution patch for the exact five lane-owned
conflict paths, then exactly one fresh independent `xhigh`/`default` integration reviewer with Fast
disabled returns `ACCEPT` or `REJECT`.

## Resolution and integration boundary

All five resolved files must be byte-for-byte identical to their audited complete blobs at the pinned
source commit. The producer may not merge, stage, commit, push, or modify a sixth path. The reviewer
has no writer or Git mutation authority.

After reviewer `ACCEPT`, `mark_reviewed` must bind the immutable reviewed output to the exact source
remote, source branch, source commit, and expected target commit. `open_integration_attempt` receives
only `reviewedOutputId`. The runtime recreates the real merge, validates that the conflict set is
exactly the five lane paths, applies only reviewed bytes, reruns all gates, and creates the true merge
with parents
`[e7e7e734c82c49105682e7a19bbedafa1f5ddbad,
7afc908ce92f14b4b0ebd06cc4aa3a4cf33807d0]`.

## Successor boundary and HOLD

The validated true two-parent merge must be pushed before P1.R2, P1.I, P1.F, or Phase 2+ can advance.
The authoritative dependency and ownership projection is [`execution-dag.md`](execution-dag.md).

This docs router keeps `controller-v17`, launches nothing, changes only its exact seven owned docs
paths, and performs no fetch, stage, commit, merge, push, or integration attempt. Current disposition:
`HOLD`.
