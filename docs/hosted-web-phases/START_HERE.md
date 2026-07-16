# Start here: PR #252 latest-base sync

- Revision: `pr252-latest-base-sync-router-v1`
- Router/canonical head: `81e79295e199bad0e6bf426537564ea7bc67dfcd`, active authority
- Historical product-wave provenance: `eee2389f7ee9300df93ef02d92e9ae114949aff4`, accepted,
  integrated, and an ancestor of the active router
- Current blocker: latest-base sync only
- Terminal state: `HOLD`

The Phase 2 milestone and next phase remain blocked until a reviewed true two-parent sync merge is
pushed and GitHub proves PR #252 non-conflicting for the same attempt-bound head/base pair. Earlier
Phase 2 candidate/product-launch wording and every stale PR #252 source pin are superseded.

## Mandatory read order

Every PR #252 latest-base-sync actor reads these items completely and in this order:

1. repository [AGENTS.md](../../AGENTS.md);
2. this file;
3. [EVIDENCE_LIFECYCLE.md](EVIDENCE_LIFECYCLE.md);
4. [hosted-web packet README](README.md);
5. [EXECUTION_INDEX.json](EXECUTION_INDEX.json);
6. [Phase 1 navigation record](phase-01/README.md);
7. [controller packet](phase-01/controller-packet.md);
8. [execution DAG](phase-01/execution-dag.md);
9. [latest-base conflict lane](phase-01/lanes/pr252-base-conflict-resolution.md);
10. repository [CLAUDE.md](../../CLAUDE.md);
11. [critical guardrails](../../AGENT_CRITICAL_GUARDRAILS.md);
12. [feature architecture standard](../FEATURE_ARCHITECTURE_STANDARD.md);
13. [packet standard](PACKET_STANDARD.md);
14. [orchestration responsibility boundary](ORCHESTRATION_GUARDS.md);
15. the immutable `pr252.latest-base-binding/v1` pre-start contract; and
16. the exact attempt-bound conflict paths and their nearest focused tests.

Stop on any revision, authority, attempt ID, full SHA, conflict-path, parent-order, scope, or
dependency mismatch. Return `HOLD`; do not repair authority informally.

## Admission rule

The router author launches nothing. After these exact seven paths become active packet authority,
`ProjectScopedControl` may atomically prepare/start one product attempt. During that single
transition it resolves the live PR base once, records the exact full commit, materializes the product
worker from `81e79295e199bad0e6bf426537564ea7bc67dfcd`, derives the actual conflict set, and binds the
canonical head and same base as ordered first and second parents.

The producer edits only actual conflict paths, preserves both parent behaviors, runs focused tests and
all mechanical gates, self-reviews, and ends `HOLD`. The controller reruns the complete mechanical
gate set directly. There is no mechanical-review worker. Exactly one fresh independent combined
integration/architecture/security semantic reviewer may follow.

Only that review's `ACCEPT` with P0/P1/P2 `0/0/0` permits broker construction, promotion, push,
and GitHub conflict proof of the exact ordered two-parent merge. The broker uses canonical head
`81e79295e199bad0e6bf426537564ea7bc67dfcd` as the expected old PR head and the merge's first
parent. A live-base mismatch at any later gate invalidates only the attempt; the same stable packet
admits a new atomic attempt after the old one is terminal.

## Safety and provenance

Use no real projects, agent-team launch/provisioning, product terminal, smoke flow, provider/auth
flow, raw lifecycle operation, other repository, broad docs edit, or Fast mode. Runtime primitives do
not choose the DAG.

The merge commit SHA and its ordered parents are primary provenance. Runtime-owned attempt and review
records may bind the attempt ID, tree SHA, commands, and findings, but no repository handoff manifest
or hash-of-manifest ledger is created. All actors and this router end `HOLD`; launch no successor.
