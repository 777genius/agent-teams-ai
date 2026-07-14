# Hosted-web execution: start here

> Current route: accepted P1.1D advances only to the exact PR #252 five-file base-conflict
> resolution lane under `controller-v17`. Exactly one `xhigh`/`default` producer and one fresh
> independent `xhigh`/`default` integration reviewer are authorized in serial, with Fast disabled.
> This docs transition launches nothing and ends `HOLD`.

This is the canonical entrypoint for every hosted-web controller and worker. Phase 0 is accepted and
frozen. Phase 1 bootstrap, foundations, routes, conformance, formal P1.R1, and P1.1D are accepted and
integrated. P1.1D's independently reviewed product is pushed at
`e7e7e734c82c49105682e7a19bbedafa1f5ddbad`.

## Deterministic reading order

Read only this bounded sequence before working:

1. `AGENTS.md`.
2. This file.
3. `docs/hosted-web-phases/EVIDENCE_LIFECYCLE.md`.
4. `docs/hosted-web-phases/README.md`, then `docs/hosted-web-phases/EXECUTION_INDEX.json`.
5. `docs/hosted-web-phases/phase-01/controller-packet.md`.
6. The single assigned packet,
   `docs/hosted-web-phases/phase-01/lanes/pr252-base-conflict-resolution.md`.
7. Only the exact mandatory documents and five pinned source/target paths listed by that packet.

Do not recursively explore documentation/evidence directories, use Fast, inspect or reuse the
terminal `failed_no_output` r1 worker, or substitute a moving branch ref for a pinned commit.

## Binding P1.1D acceptance

The independent reviewer
`agent-teams-hosted-web-refactor-p1-1d-shadowed-map-review-v17-r4` returned `FORMAL ACCEPT` with
P0/P1/P2 `0/0/0`. The strict result SHA-256 is
`be0c9abd679f817c386d1d06d1b738c2a1505bb3c4718279129ab74842c98fa6`; reviewed output ID is
`f3394026185348c84673d44a9b30a82667c3ff9435b5d4d7609c04785c274f41`; accepted integration is
`p1-1d-shadowed-map-r4-accepted-integration-v3`; and accepted/pushed commit is
`e7e7e734c82c49105682e7a19bbedafa1f5ddbad`.

These facts are immutable accepted provenance. They are not authority to rerun P1.1D, change its
product, or start P1.R2/P1.I/P1.F/Phase 2+.

## Current route

`PR252-base-conflict-resolution` is the sole executable node. The target is the accepted P1.1D commit.
The PR source is `origin/refactor/team-provisioning-round2-reapply`, pinned to
`7afc908ce92f14b4b0ebd06cc4aa3a4cf33807d0`. One producer may create an immutable patch that changes
exactly the five lane-owned conflict paths byte-for-byte to their audited source blobs. The producer
must not merge, stage, commit, or push.

One fresh independent integration reviewer must return explicit `ACCEPT` or `REJECT`. Only after
`ACCEPT` may `mark_reviewed` bind the reviewed output to the exact source remote/branch/commit and
expected target commit. `open_integration_attempt` consumes only `reviewedOutputId`; the runtime must
create and validate the true merge with parents
`[e7e7e734c82c49105682e7a19bbedafa1f5ddbad,
7afc908ce92f14b4b0ebd06cc4aa3a4cf33807d0]`.

## Authority and HOLD

The same durable `controller-v17` must remain exactly `live=true`. This router changes no product,
test, runtime, orchestration, configuration, package, lockfile, handoff, or research path; launches no
worker; and performs no fetch, stage, commit, merge, push, or integration attempt.

P1.R2, P1.I, P1.F, and Phase 2+ remain blocked until the validated true two-parent PR #252 merge is
pushed. End `HOLD`.
