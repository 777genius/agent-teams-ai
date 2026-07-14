# Hosted-web execution: start here

> Current route: `phase-01-pr252-task-provenance-remediation-router-r1` consumes the independent r4
> `FORMAL REJECT` of producer r3 and conditionally authorizes one hash-bound, true-merge remediation
> producer followed by one fresh independent reviewer. This seven-document router launches nothing
> and ends `HOLD`.

Phase 0 and accepted Phase 1 history remain frozen. The only current executable node is
`PR252-task-provenance-remediation`. Root stays orchestrator; `controller-v17` stays exactly live and
is neither replaced nor restarted.

## Deterministic reading order

1. `AGENTS.md`
2. This file
3. `docs/hosted-web-phases/EVIDENCE_LIFECYCLE.md`
4. `docs/hosted-web-phases/README.md`
5. `docs/hosted-web-phases/EXECUTION_INDEX.json`
6. `docs/hosted-web-phases/phase-01/controller-packet.md`
7. `docs/hosted-web-phases/phase-01/lanes/pr252-base-conflict-resolution.md`
8. `CLAUDE.md`
9. `AGENT_CRITICAL_GUARDRAILS.md`
10. `docs/hosted-web-phases/PACKET_STANDARD.md`
11. Only the five producer-owned product/test paths listed in the lane packet

Do not recursively inspect rejected job state, fetch, launch an app/runtime/team, access a real
project, or substitute a moving ref for a stored immutable target.

## Rejection consumed without replaying its candidate

Reviewer r4 returned `FORMAL REJECT`, P0/P1/P2 `0/1/0`, for producer r3. The sole P1 demonstrated
that, without destination `reconcile` or task `creationCommand`, a `findById` fallback returned an
unrelated task with the requested ID, subject `UNRELATED SUBJECT`, and outcome `Executed`. Every
other semantic requirement and check passed.

The successor is bound to useful-handoff SHA-256
`f810a0aa191e82316737c5c0069ee6225597d8a477d77b50c57bc3fd931fe579` and rejected full-diff
SHA-256 `cb534246905f6fd7cc03b0b761018157ed12d204d11819f0978915af7c778491`. Both are review
provenance/reference. The rejected full diff is not applied, materialized, or integrated, and this
remediation is not a clean rewrite.

## Corrected current-base authority

- Canonical/head snapshot: `3256ee3b5b8e81b144aa0a14eac1bca080c9b779`.
- Pinned current real base and merge source:
  `origin/refactor/team-provisioning-round2-reapply@e9ffa30cc016ad3cb833fcc0a138fa4f026eb850`.
- Direct remote proof: `git ls-remote origin
refs/heads/refactor/team-provisioning-round2-reapply` returned that exact `e9ffa30c...` commit.
- GitHub PR `baseOid` `d2585e7634800eb795644c4b6d0e8baf5f81c98f` is stale. It is 52 commits behind
  `e9ffa30c...`.
- Former source `7afc908ce92f14b4b0ebd06cc4aa3a4cf33807d0` is also an ancestor of
  `e9ffa30c...`; it is provenance only and is not the active merge source.
- Fresh `merge-tree(3256ee3b..., e9ffa30c...)` proves exactly the same five conflict paths recorded
  in the lane packet.

The standalone-normal-push interpretation is superseded. The conflict route remains current.

## Hash-bound true-merge remediation

After this router receives independent `ACCEPT`, is integrated, and is pushed,
`ProjectScopedControl` resolves that pushed target once. It admits exactly one serial producer using
`codex_goal_project_refill_worker`. The producer owns all five merge-conflict paths, while new
remediation semantics are limited to `TaskBoardCommandFacade.ts` and its E2E test unless demonstrated
compile coherence requires an owned-path exception.

The producer starts from a fresh two-parent merge of the stored target with pinned source
`e9ffa30c...`. It preserves the accepted r3 conflict resolutions, keeps destination reconciliation
optional, and restores target-safe payload/trimmed-subject validation without requiring provenance.
A found same-ID task is success only when the fallback validation matches; otherwise it throws and
terminally classifies `TaskBoardCreateDestinationConflictError`. Add one exact `UNRELATED SUBJECT`
regression and prove it can never report `Executed`, `Retried`, `Reconciled`, `Replayed`, or any other
success.

The producer self-reviews, emits one immutable output, and ends `HOLD`. Then
`ProjectScopedControl` admits exactly one fresh independent reviewer through
`codex_goal_project_prepare_verifier`. Both launches use `gpt-5.6-sol`, `xhigh`, and
`serviceTier: "fast"`. Machine request envelopes contain no `fastMode` field. Only independent
`ACCEPT` with P0/P1/P2 `0/0/0` permits ordered broker integration.

Immediately before integration, the broker must rerun the exact `git ls-remote` query and require
the remote branch head still equals `e9ffa30c...`. A moved head ends `HOLD` and requires review of a
new pinned base. If unchanged, the broker creates the true merge with ordered parents `[stored
accepted router target, e9ffa30c...]`, materializes source non-conflicts, applies the accepted
five-path resolution, reruns every gate, runs the final source-only command-identity test, creates a
conventional merge commit, and pushes.

## Authority and HOLD

All inherited focused checks, native exact seven-diagnostic TypeScript baseline, self-review,
independent review, exact five-path scope, empty index, conflict, secret/provider, private-path, and
textual/non-binary gates remain required. P1.R2, P1.I, P1.F, and Phase 2+ remain blocked until the
validated ordered merge is pushed. This router changes exactly seven docs, performs no lifecycle or
Git mutation, and ends `HOLD`.
