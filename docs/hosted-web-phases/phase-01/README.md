# Hosted Web Phase 1

Current authority is `phase-01-pr252-task-provenance-remediation-router-r1`; terminal state is
`HOLD`. Accepted Phase 0 and Phase 1 history remains unchanged.

Independent reviewer r4 formally rejected producer r3 at P0/P1/P2 `0/1/0`. Its only finding was a
`TaskBoardCommandFacade.findById` false success: with no destination `reconcile` and no task
`creationCommand`, an unrelated same-ID task with subject `UNRELATED SUBJECT` was returned as
`Executed`. Every other r3 semantic and gate passed.

Useful handoff SHA-256
`f810a0aa191e82316737c5c0069ee6225597d8a477d77b50c57bc3fd931fe579` and rejected five-path diff
SHA-256 `cb534246905f6fd7cc03b0b761018157ed12d204d11819f0978915af7c778491` bind this successor as
review provenance/reference. The full diff is not materialized, replayed, or directly integrated;
the successor is not a clean rewrite.

The active merge source/current real base is
`origin/refactor/team-provisioning-round2-reapply@e9ffa30cc016ad3cb833fcc0a138fa4f026eb850`, proven
by direct `git ls-remote`. GitHub's `d2585e7...` base is stale and 52 commits behind; former source
`7afc908c...` is an ancestor of `e9ffa30c...`, not the current source. Fresh merge-tree proof against
canonical/head `3256ee3b...` preserves the exact five-conflict route.

After the seven-doc router is accepted, integrated, and pushed, one serial producer owns those five
conflict paths and materializes a fresh two-parent merge against `e9ffa30c...`. New semantic edits are
limited to the facade and its E2E test unless owned-path compile coherence is demonstrated. The
producer preserves all passing r3 conflict resolutions, optional reconciliation, and no-provenance
payload/trimmed-subject validation; it terminalizes an unrelated same-ID mismatch with
`TaskBoardCreateDestinationConflictError` and adds the missing never-success regression. The combined
TaskBoard E2E suite contains exactly ten cases.

Producer self-review ends `HOLD`; one fresh independent reviewer follows. Both use `gpt-5.6-sol`,
`xhigh`, and `serviceTier: "fast"`, with no machine `fastMode` property. Only independent `ACCEPT` at
P0/P1/P2 `0/0/0` permits integration. Immediately before that integration, the broker must prove the
remote source head still equals `e9ffa30c...`; drift ends `HOLD`. An unchanged source permits only the
ordered true merge `[stored accepted router target, e9ffa30c...]`, followed by all final-shape gates
and the source-only command-identity test.

The authoritative dependency projection is [`execution-dag.md`](execution-dag.md). P1.R2, P1.I,
P1.F, and Phase 2+ remain blocked pending the validated merge push. This docs router changes exactly
seven documentation paths, launches nothing, performs no Git/lifecycle mutation, and ends `HOLD`.
