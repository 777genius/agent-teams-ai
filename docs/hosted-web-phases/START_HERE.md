# Hosted-web execution: start here

> Current route: the PR #252 five-file base-conflict resolution lane is gated by the
> `canonicalAtProducerAdmission` correction under `controller-v17`. Exactly one `xhigh`/`default`
> producer and one fresh independent `xhigh`/`default` integration reviewer are authorized in
> serial only after that binding is resolved, with Fast disabled. This docs transition launches
> nothing and ends `HOLD`.

This is the canonical entrypoint for every hosted-web controller and worker. Phase 0 is accepted and
frozen. Phase 1 bootstrap, foundations, routes, conformance, formal P1.R1, and P1.1D are accepted and
integrated. P1.1D's independently reviewed product was pushed at
`e7e7e734c82c49105682e7a19bbedafa1f5ddbad`; that commit is historical provenance, not the future
PR #252 target.

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
terminal `failed_no_output` r1 worker, or substitute a moving branch ref for a pinned source commit.

## Binding P1.1D acceptance

The independent reviewer
`agent-teams-hosted-web-refactor-p1-1d-shadowed-map-review-v17-r4` returned `FORMAL ACCEPT` with
P0/P1/P2 `0/0/0`. The strict result SHA-256 is
`be0c9abd679f817c386d1d06d1b738c2a1505bb3c4718279129ab74842c98fa6`; reviewed output ID is
`f3394026185348c84673d44a9b30a82667c3ff9435b5d4d7609c04785c274f41`; accepted integration is
`p1-1d-shadowed-map-r4-accepted-integration-v3`; and its accepted/pushed commit was
`e7e7e734c82c49105682e7a19bbedafa1f5ddbad`.

These facts are immutable accepted historical provenance. They are not a target binding and are not
authority to rerun P1.1D, change its product, or start P1.R2/P1.I/P1.F/Phase 2+.

## Current route and JIT canonical binding

`PR252-base-conflict-resolution` remains the sole executable node. Its packet revision is
`phase-01-pr252-target-binding-correction-r1`. The stable binding
`canonicalAtProducerAdmission` means the exact current canonical commit after this correction router
has been accepted, policy-integrated, and pushed.

No product worker may start before those policy steps finish. Immediately before admitting the sole
producer, the same `controller-v17` resolves `canonicalAtProducerAdmission` exactly once to a full
commit SHA. That one immutable value is bound into `canonicalSha`, `phaseStartSha`, `baseSha`, the
producer materialization `HEAD`, `planBundleCommit`, `expectedTargetCommit`, reviewer
materialization, `mark_reviewed` merge metadata, and the integration target. It is never recomputed
or replaced by a SHA embedded in this pre-integration packet.

The PR source remains `origin/refactor/team-provisioning-round2-reapply`, pinned to
`7afc908ce92f14b4b0ebd06cc4aa3a4cf33807d0`. One producer may create an immutable patch that changes
exactly the five lane-owned conflict paths byte-for-byte to their audited source blobs. The producer
must not merge, stage, commit, or push.

One fresh independent integration reviewer must return explicit `ACCEPT` or `REJECT`. Only after
`ACCEPT` may `mark_reviewed` bind the reviewed output to the unchanged source identity and the
resolved full `canonicalAtProducerAdmission` SHA. `open_integration_attempt` consumes only
`reviewedOutputId`; the runtime chooses no DAG or branch. It only validates that every concrete
target field still equals the current canonical SHA, fails closed on drift, and creates the true
merge with parents `[resolved canonicalAtProducerAdmission,
7afc908ce92f14b4b0ebd06cc4aa3a4cf33807d0]` in that order.

## Authority and HOLD

The same durable `controller-v17` must remain exactly `live=true`. This router changes no product,
test, runtime, orchestration, configuration, package, lockfile, handoff, or research path; launches no
worker; and performs no fetch, stage, commit, merge, push, or integration attempt.

P1.R2, P1.I, P1.F, and Phase 2+ remain blocked until the validated true two-parent PR #252 merge is
pushed. End `HOLD`.
