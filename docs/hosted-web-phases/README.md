# Hosted-web execution packets

Current authority is the [PR #252 live-head sync controller packet](phase-01/controller-packet.md),
revision `pr252-live-head-sync-router-v2`. Start with [START_HERE.md](START_HERE.md) and use
[EXECUTION_INDEX.json](EXECUTION_INDEX.json) as the machine-readable source of truth.

## Live-head attempt binding

The packet never pins an observed PR head or base SHA. During each atomic prepare/start, the broker:

1. resolves the live PR head into immutable `attempt.canonicalHeadSha`;
2. resolves the live PR base once into immutable `attempt.resolvedBaseSha`;
3. materializes from `attempt.canonicalHeadSha`; and
4. binds ordered parents
   `[attempt.canonicalHeadSha, attempt.resolvedBaseSha]` and expected old head
   `attempt.canonicalHeadSha`.

A later head or base mismatch invalidates only the bound attempt. Once it is terminal, the same
stable packet may admit a fresh atomic attempt; no docs revision or source-pin update is needed.

## Bounded route

One producer may resolve only the actual attempt-bound conflict paths. It preserves both parent
behaviors, runs focused tests and every mechanical gate, self-reviews, and ends `HOLD`. The
controller directly reruns all mechanical checks. One fresh independent reviewer then makes the
combined integration, architecture, security, and semantic decision.

Only `ACCEPT` with P0/P1/P2 `0/0/0` permits a true two-parent merge of the exact reviewed tree. The
broker rechecks the bound head/base, pushes with `attempt.canonicalHeadSha` as expected old head, and
proves the remote and GitHub head/base state matches the attempt and is non-conflicting.

The runtime owns execution primitives only. `ProjectScopedControl` owns admission, dependencies,
checks, review policy, drift invalidation, promotion authorization, and gate release. All actors end
`HOLD`; no successor is launched.
