# Start here: PR #252 live-head sync

- Revision: `pr252-live-head-sync-router-v2`
- Current node: `PR252.LATEST_BASE_SYNC`
- Current blocker: reviewed live-head/latest-base sync only
- Terminal state: `HOLD`

This router contains no author-time PR head or base SHA. At each atomic prepare/start, the broker
resolves and records `attempt.canonicalHeadSha` and resolves the live base once into
`attempt.resolvedBaseSha`. The canonical head is immutable for that attempt and is its
materialization source, ordered first parent, and expected old PR head. The resolved base is its
ordered second parent. Later head or base drift invalidates only that attempt.

## Mandatory read order

Every actor reads these items completely and in this order:

1. repository [AGENTS.md](../../AGENTS.md);
2. this file;
3. [EVIDENCE_LIFECYCLE.md](EVIDENCE_LIFECYCLE.md);
4. [hosted-web packet README](README.md);
5. [EXECUTION_INDEX.json](EXECUTION_INDEX.json);
6. [Phase 1 navigation record](phase-01/README.md);
7. [controller packet](phase-01/controller-packet.md);
8. [execution DAG](phase-01/execution-dag.md);
9. [live-head conflict lane](phase-01/lanes/pr252-base-conflict-resolution.md);
10. repository [CLAUDE.md](../../CLAUDE.md);
11. [critical guardrails](../../AGENT_CRITICAL_GUARDRAILS.md);
12. [feature architecture standard](../FEATURE_ARCHITECTURE_STANDARD.md);
13. [packet standard](PACKET_STANDARD.md);
14. [orchestration responsibility boundary](ORCHESTRATION_GUARDS.md);
15. the immutable `pr252.latest-base-binding/v1` attempt contract; and
16. the attempt's exact conflict paths and focused tests.

Stop on any revision, repository, PR, attempt, head, base, parent-order, conflict-path, scope, or
dependency mismatch. Return `HOLD`; do not repair authority informally.

## Route

`ProjectScopedControl` admits at most one attempt. The broker performs the atomic live-head/base
binding before worker start. The producer edits only actual conflict paths, preserves both parents'
behavior, runs focused tests and every mechanical gate, self-reviews, and ends `HOLD`. The controller
reruns the mechanical gates directly. Exactly one fresh independent combined
integration/architecture/security semantic reviewer may follow.

Only `ACCEPT` with P0/P1/P2 `0/0/0` permits the broker to construct the exact reviewed tree as a
true two-parent merge, push with expected-old-head protection, and prove GitHub reports the pushed
head/base pair non-conflicting. Every actor ends `HOLD`; launch no successor.

## Safety

Use no real projects, agent-team launch/provisioning, product terminal or smoke flow, provider/auth
flow, raw lifecycle operation, other repository, broad docs edit, dependency update, or Fast mode.
Runtime primitives do not choose the DAG. Git commit and tree objects are primary provenance; do not
create repository handoff manifests or manifest-hash ledgers.
