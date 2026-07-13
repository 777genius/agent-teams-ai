# Phase 1: contracts and conformance

Status: **one fresh P1.1D independent reviewer after correction-router integration and the existing
durable controller's structured review-scope update**. P1.R2 and every later node remain blocked.

## Provenance

P1.S0, P1.S1, P1.S2, and formal P1.R1 remain accepted and integrated as previously recorded. The
current immutable P1.1D remediation product candidate has `baseSha`
`1b37afb02bec25a1f08432d733595b553101ecab`. The reviewer has `canonicalSha`, `phaseStartSha`,
`planBundleCommit`, and worktree `HEAD` `bbfd2551baaa904061e705511f07716e0f6db17d`.

The candidate's runtime nine-path handoff carrier SHA-256 is
`1f9c6a2a28e5540c61d1395bc51a34a7c0db31855bae575abc9582f839118b49`. Its final eight-path semantic
reconstruction SHA-256 is `fa46617652b072e887563f5a751f7bd0260e0e1d4fb96b628badea91ea7ae9d6`.
These hashes name different layers and are not interchangeable.

The prior independent strict result SHA-256
`29ad2243be1a1e0c7aa95cb1a32ae32b8f15db8ebe1a260cd41dd85d2c079934` is binding `REJECT` P1. The
sole finding was that an external review instruction mislabeled transient interim hash `7672e922` as
the final handoff hash. The final candidate did not contain or claim `7672e922`; nevertheless, the
review disposition remains `REJECT`, not `ACCEPT`.

Reviewed-workspace snapshot SHA-256
`521d8bab2ed7bc4334b38a5786dd5685f5e4f033c3962cab566f9ab3b60d0000` is used only to consume the
prior rejection-ledger record and never as candidate identity. Formal rejected integration-ledger
records exist for both producer and reviewer output, with no blocking output debt reported by
admission.

The predecessor docs-router output is immutable rejected evidence: reviewed output
`1ad2849056be658ab629b9810914ace7eab3287745ecb39c1d76ac1c124d0eb7`, patch SHA-256
`657c1c5ff6421f6b206ef14509586d09fad72e8c511efe1a6f9bf6b8dce5f577`. This revision preserves its
review-only transition without altering or integrating those bytes and corrects only product-base
provenance and reviewer admission shape.

## Current route

The route contains exactly these executable packets:

1. [`controller-packet.md`](controller-packet.md)
2. [`lanes/p1-1d-additive-response-remediation.md`](lanes/p1-1d-additive-response-remediation.md)

The node remains `P1.1D-additive-response-remediation`, but its only current mode is review-only under
revision `phase-01-p1-1d-additive-response-review-r2`. There is one reviewer slot and no producer,
retry, refill, integration, or later-node slot.

## Review launch boundary

This seven-path docs-only transition launches no reviewer or controller. After policy integration,
the same durable controller must atomically replace its completed producer scope with the current
review-only revision while remaining `live=true`. It must not be replaced or restarted merely for this
transition.

Only then may ProjectScopedControl operation `codex_goal_project_refill_worker` admit one new isolated
reviewer that is independent of the router author, all P1.1D producers, and the prior rejected
reviewer. The operation binds outer `workerRole: reviewer`, reasoning effort `xhigh`, service tier
`default`, and `serial-builtin` `preStartAdmission`. The internal contract remains
`kind: worker-launch`, `format: 1`, `reviewKind: review`, with the runtime nine-path carrier as
`inputPatchHash`. The `521d8bab...` snapshot remains ledger-consumption-only, and `7672e922` remains a
stale external assertion only. There is no separate reviewer-launch tool or public contract.

## Review and successor boundary

The fresh reviewer must rerun every bound semantic, architecture, quality, provenance, ownership,
hash, and safety check and return explicit `ACCEPT` or `REJECT` with P0/P1/P2 findings. Missing,
blocked, or ambiguous output is not acceptance.

No product change or producer rerun is permitted. No result from this docs router authorizes product
integration, commit, push, P1.R2, P1.I, P1.F, Phase 2+, or work in any of the five PR conflict files. Product integration stays
blocked pending a separately routed explicit `ACCEPT`. The authoritative dependency and ownership
projection is [`execution-dag.md`](execution-dag.md). Current disposition: `HOLD`.
