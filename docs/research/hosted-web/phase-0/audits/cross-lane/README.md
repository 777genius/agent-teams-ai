# Phase 0 cross-lane contract and integration-prep audit

## Disposition

Hold all producer adoption. The registry shows all six producer jobs and all three reciprocal review
jobs as done, but every reciprocal pair rejected both producer outputs pending correction. No producer
pair is ready for integration and no file is immediately adoptable.

The machine-readable authority for this audit is `ordered-manifest.json`. It records 24 reciprocal
review findings: 3 critical, 14 high, 5 medium and 2 low. It also records nine individual evidence
files that reviewers approved or accepted as useful. Those files remain held because their producer
pairs are rejected and the packet requires correction/review reconciliation before adoption.

## Review-approved file order

| Order | Lane | Evidence                           | File                                                     | Current adoption state       |
| ----: | ---- | ---------------------------------- | -------------------------------------------------------- | ---------------------------- |
|     1 | W1   | `P0.W1.SELECTION_INVARIANTS`       | `parity-renderer/selection-reconciliation-invariants.md` | Held; W1/W2 pair rejected    |
|     2 | W2   | `P0.W2.EXECUTION_TOPOLOGY`         | `provider-runtime/execution-topology.json`               | Held; W1/W2 pair rejected    |
|     3 | W3   | `P0.W3.STATE_FAMILY_CATALOG`       | `state-writers/state-family-catalog.json`                | Held; W3/W5 pair rejected    |
|     4 | W3   | `P0.W3.WRITER_COORDINATION`        | `state-writers/writer-coordination.json`                 | Held; W3/W5 pair rejected    |
|     5 | W3   | `P0.W3.SCHEMA_UNKNOWN_FIELDS`      | `state-writers/schema-unknown-fields.json`               | Held; W3/W5 pair rejected    |
|     6 | W3   | `P0.W3.SQLITE_ONLINE_BACKUP_SPIKE` | `state-writers/sqlite-online-backup-results.json`        | Held; W3/W5 pair rejected    |
|     7 | W3   | `P0.W3.ESTIMATE`                   | `state-writers/estimate-input.json`                      | Held for W3/W5 deduplication |
|     8 | W5   | `P0.W5.EVENT_CURSOR_INVENTORY`     | `recovery-events/event-cursor-inventory.json`            | Held; W3/W5 pair rejected    |
|     9 | W5   | `P0.W5.ESTIMATE`                   | `recovery-events/estimate-input.json`                    | Held for W3/W5 deduplication |

W4/W6 received no file-level approval. Review approval here means only that the named evidence is
useful at its declared proof level; it is not authorization to cherry-pick a file out of a rejected
pair. Exact source hashes are in the manifest.

## Integration blockers

1. W6 restart restores mutation admission after logout/revocation (`R46-01`).
2. W5's crash schedules and retry classes contradict W3 writer truth (`RW35-002`, `RW35-003`).
3. W1 manufactures source-line-dependent JSX actions and conflicts with W2/canonical ownership
   (`R12-W1-001`, `R12-W1-002`, `R12-X-001`).
4. W4 process signaling/cleanup and W6 reset fencing are unsafe (`R46-02` through `R46-04`).
5. W4/W6 have no shared final artifact/topology contract (`R46-06`, `R46-07`).
6. W2 environment completeness, schemas and provider matrix are insufficient (`R12-W2-001`,
   `R12-W2-002`, `R12-W2-004`).
7. W3 legacy backup behavior and W5 fingerprints/mutation census are incomplete (`RW35-001`,
   `RW35-004`, `RW35-005`).
8. The estimate cannot be frozen: W1 arithmetic is wrong, W2 bucket IDs are non-canonical, W3/W5
   overlap, and W2/W4 overlap is unresolved.
9. W1's 48,661-line output violates evidence/adoption budgets without compact/hash treatment or an
   explicit split approval.

## Controller-state drift

The integration worktree remains at `a32f509e6d9bd31ba2135940e336729bf90c3d93`, but its checked-in
`base.json` and `lane-ledger.json` still contain `phaseStartSha: null`; the lane ledger still reports
the bootstrap epoch, six unstarted slots, null job/worktree IDs and null handoff hashes. The project
registry, by contrast, shows all six producers and all three review jobs done. The integration owner
must reconcile those controller-owned records from registry evidence before opening an adoption
attempt. This audit did not modify integration or any other worktree.

## Ordered next actions

1. Integration owner reconciles the base/lane ledger with the registry and immutable handoff hashes.
2. W1/W2 owners correct all R12 findings, compact W1 evidence and repeat reciprocal review.
3. W3/W5 owners correct all RW35 findings, bind recovery to writer coordination, deduplicate the
   recovery estimate and repeat reciprocal review.
4. W4/W6 owners correct all R46 findings, agree one artifact/topology manifest and repeat review.
5. Only then open the policy integration attempt and adopt the final reviewed files in packet order,
   splitting adoptions above 1,500 lines.
6. Target-host probes, decision/estimate freeze and broad Phase 0 gates remain later controller-owned
   work. This audit ran none of them and performed no Phase 1 work.
