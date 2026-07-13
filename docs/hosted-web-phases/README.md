# Hosted Web execution router

Always begin with [`START_HERE.md`](START_HERE.md). This router selects executable authority; it does
not redefine product architecture or turn a rejected record into acceptance.

## Fixed route

1. Read the baseline in `START_HERE.md`.
2. Confirm the review-only route in [`EXECUTION_INDEX.json`](EXECUTION_INDEX.json).
3. Read the current [`Phase 1 controller packet`](phase-01/controller-packet.md).
4. Read the single assigned
   [`P1.1D independent-review packet`](phase-01/lanes/p1-1d-additive-response-remediation.md).
5. Read only the exact inputs and headings listed by that packet.

On conflict, stop with `packet_conflict`. A packet may narrow authority but may not broaden scope,
weaken a guardrail, modify the candidate, or repair accepted/rejected input in place.

## Binding provenance

The immutable P1.1D remediation product candidate has `baseSha`
`1b37afb02bec25a1f08432d733595b553101ecab`. Its reviewer has `canonicalSha`, `phaseStartSha`,
`planBundleCommit`, and worktree `HEAD` at `bbfd2551baaa904061e705511f07716e0f6db17d`. Its runtime
nine-path handoff carrier is
`1f9c6a2a28e5540c61d1395bc51a34a7c0db31855bae575abc9582f839118b49`; its final eight-path semantic
reconstruction is `fa46617652b072e887563f5a751f7bd0260e0e1d4fb96b628badea91ea7ae9d6`.

The prior independent strict result
`29ad2243be1a1e0c7aa95cb1a32ae32b8f15db8ebe1a260cd41dd85d2c079934` returned binding `REJECT` P1.
Its only finding was review-input provenance: an external instruction incorrectly called transient
interim hash `7672e922` the final handoff hash. The candidate never contained or claimed that hash.
This router records the rejection exactly and does not convert it to `ACCEPT`.

Reviewed-workspace snapshot SHA-256
`521d8bab2ed7bc4334b38a5786dd5685f5e4f033c3962cab566f9ab3b60d0000` is valid only for consuming
the rejection-ledger record. It is not the carrier hash, semantic reconstruction hash, or corrected
fresh-review assertion. Producer and reviewer outputs both have formal rejected integration-ledger
records, and admission reports no blocking output debt.

The previous docs-router transition is immutable rejected reviewed output
`1ad2849056be658ab629b9810914ace7eab3287745ecb39c1d76ac1c124d0eb7`, patch SHA-256
`657c1c5ff6421f6b206ef14509586d09fad72e8c511efe1a6f9bf6b8dce5f577`. This correction reproduces
its useful review-only routing while fixing its two P1 admission defects; it does not alter or
integrate those rejected bytes.

## Current execution

`P1.1D-additive-response-remediation` is the sole current node in review-only mode. Its packet is
[`p1-1d-additive-response-remediation.md`](phase-01/lanes/p1-1d-additive-response-remediation.md),
revision `phase-01-p1-1d-additive-response-review-r2`.

After this exact seven-path router is policy-integrated and the existing durable controller applies
the structured product-to-review scope update while remaining `live=true`, exactly one fresh reviewer
may be admitted through ProjectScopedControl operation `codex_goal_project_refill_worker`. The outer
operation uses `workerRole: reviewer`, reasoning effort `xhigh`, and service tier `default`; its
`serial-builtin` `preStartAdmission` uses the existing internal `worker-launch` format 1 contract with
`reviewKind: review` and the runtime carrier as `inputPatchHash`. That reviewer must be independent of
this router author, every P1.1D producer, and the prior rejected reviewer; inspect the existing
immutable candidate; rerun the bound checks; and return explicit `ACCEPT` or `REJECT`. No
separate reviewer-launch operation or public contract is introduced.

## Blocked successors and HOLD

This correction authorizes no product mutation, product/test/runtime rerun by a producer, producer
retry/refill, integration, commit, push, controller replacement, P1.R2, P1.I, P1.F, Phase 2+, or PR
conflict work in any of the five tracked conflict files. The docs author launches neither reviewer nor controller. Product integration remains
blocked regardless of the prior ledger admission and until a future explicit `ACCEPT` is separately
routed. End this docs transition on `HOLD`.
