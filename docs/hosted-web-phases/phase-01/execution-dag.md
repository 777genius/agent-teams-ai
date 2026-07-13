# Phase 1 execution DAG and ownership

Status: P1.S0, P1.S1, P1.S2, and P1.R1 are accepted and integrated. The immutable P1.1D remediation
candidate is complete. Its first independent review returned binding `REJECT` P1 because the external
review input mislabeled one transient interim hash. A single corrected fresh review is the sole current
serial activity. Later nodes and product integration are blocked.

## Current DAG

```text
P1.S0 accepted
  -> P1.S1 accepted + integrated
       -> P1.S2 routes + conformance accepted
            -> P1.R1 ACCEPT
                 -> P1.1D remediation router at bbfd2551b
                      -> immutable nine-path candidate
                           -> prior independent review REJECT (binding; stale external hash assertion)
                                -> corrected fresh independent review (current; one xhigh/default slot)
                                     -> explicit ACCEPT or REJECT required
                                          -X-> product integration
                                          -X-> P1.R2 -> P1.I -> P1.F -> Phase 2+
```

The immutable product candidate `baseSha` is
`1b37afb02bec25a1f08432d733595b553101ecab`. Reviewer `canonicalSha`, `phaseStartSha`,
`planBundleCommit`, and worktree `HEAD` are
`bbfd2551baaa904061e705511f07716e0f6db17d`. The latter is the review source/start identity, not the
product base.

The prior `REJECT` is not reinterpreted. The fresh reviewer receives corrected role labels for:

- nine-path runtime handoff carrier
  `1f9c6a2a28e5540c61d1395bc51a34a7c0db31855bae575abc9582f839118b49`;
- eight-path semantic reconstruction
  `fa46617652b072e887563f5a751f7bd0260e0e1d4fb96b628badea91ea7ae9d6`; and
- rejection-ledger-only reviewed snapshot
  `521d8bab2ed7bc4334b38a5786dd5685f5e4f033c3962cab566f9ab3b60d0000`.

Prior strict result SHA-256
`29ad2243be1a1e0c7aa95cb1a32ae32b8f15db8ebe1a260cd41dd85d2c079934` records the binding rejection.
Transient `7672e922` is not an immutable-candidate hash and never appeared in or was claimed by the
final candidate.

The predecessor review-input router remains immutable rejected reviewed output
`1ad2849056be658ab629b9810914ace7eab3287745ecb39c1d76ac1c124d0eb7`, patch SHA-256
`657c1c5ff6421f6b206ef14509586d09fad72e8c511efe1a6f9bf6b8dce5f577`. This corrected transition
does not modify or integrate it.

## Current lane registry

| Node                                  | Current mission                                                   | Dependency                                                | Packet / revision                                                                             |
| ------------------------------------- | ----------------------------------------------------------------- | --------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `P1.1D-additive-response-remediation` | Review the existing immutable candidate with corrected provenance | correction router integrated; same controller `live=true` | `lanes/p1-1d-additive-response-remediation.md` / `phase-01-p1-1d-additive-response-review-r2` |

Capacity is zero before both admission gates. Afterward capacity is exactly one fresh independent
reviewer through `codex_goal_project_refill_worker`, with outer `workerRole: reviewer`, `xhigh`
reasoning, `default` service tier, and the existing serial-builtin internal `worker-launch` format 1
contract. `reviewKind` is `review`; `inputPatchHash` is the nine-path runtime carrier. There is no
separate reviewer-launch operation, product producer, retry, refill, integration, or later-node
capacity.

## Immutable candidate scope

Product paths:

- `src/features/team-lifecycle/contracts/team-lifecycle-read.ts`
- `src/features/team-lifecycle/contracts/index.ts`
- `src/features/team-lifecycle/core/application/ListTeamLifecycle.ts`
- `src/features/team-lifecycle/core/application/index.ts`
- `src/features/team-lifecycle/index.ts`

Test paths:

- `test/features/team-lifecycle/core/ListTeamLifecycle.test.ts`
- `test/architecture/hosted-web/phase-1/team-lifecycle/team-lifecycle-read-contract.test.ts`
- `test/architecture/hosted-web/phase-1/team-lifecycle/team-lifecycle-read-boundaries.test.ts`

Handoff path:

- `.codex-handoff/phase-01-p1-1d.json`

The five product, three test, and one handoff paths form the exact immutable nine-path review input.
The fresh reviewer has no writer authority over them or any repository path. Both earlier outputs have
formal rejected integration-ledger records, and admission reports no blocking output debt.

## Gates and blocked successor

The reviewer independently reruns the original and additive-response checks, validates the carrier
and semantic hashes by their exact roles, confirms the candidate does not contain or claim
`7672e922`, and returns explicit `ACCEPT` or `REJECT`. The ledger snapshot hash is used only to consume
the prior rejection record, not to reconstruct or identify the candidate.

The durable controller remains the same and applies only the structured producer-to-review scope
update. The docs author launches nothing. Product integration, commit, push, P1.R2, P1.I, P1.F,
Phase 2+, and all five PR conflict files remain blocked. Current terminal state: `HOLD`.
