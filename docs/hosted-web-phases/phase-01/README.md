# Hosted Web Phase 1 navigation record

Phase 1 is complete. This directory remains the navigation boundary for the current PR #252 sync
gate; it does not reopen a Phase 1 product node.

Current packet authority is `pr252-live-head-sync-router-v2`. It supersedes every durable PR head or
base pin, fixed conflict list, old-job continuation, and dirty-worktree reuse contract.

## Current route

Read the [controller packet](controller-packet.md), [execution DAG](execution-dag.md), and
[conflict-resolution lane](lanes/pr252-base-conflict-resolution.md).

At atomic prepare/start, the broker records the current PR head as
`attempt.canonicalHeadSha` and resolves the current base once as `attempt.resolvedBaseSha`. The
first value is the attempt's immutable materialization source, ordered first parent, and expected old
head; the second is its immutable ordered second parent.

One producer resolves only the actual conflict paths and preserves both parent behaviors. After
focused tests, mechanical gates, self-review, direct controller rerun, and one independent combined
semantic review, exact `ACCEPT` with P0/P1/P2 `0/0/0` permits the broker to construct and push the
true two-parent merge and prove the exact GitHub head/base pair non-conflicting.

Any later head or base drift invalidates only the attempt. The same router may admit a fresh atomic
attempt after the old one is terminal. The router author launches no worker or successor and ends
`HOLD`.
