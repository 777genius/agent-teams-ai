# Hosted Web execution router

> Current route: `phase-01-p1-f-freeze-router-r2`, authored at clean remote-equal canonical
> authority `20706bd067ce5ccbf13697700411904faa2a00c8`. It conditionally authorizes exactly one serial,
> fresh, independent `P1.F` milestone-freeze worker after this seven-path router is independently
> accepted, broker-integrated, pushed, and attested. The route launches nothing and ends `HOLD`.

Always begin with [`START_HERE.md`](START_HERE.md). Machine-readable authority is
[`EXECUTION_INDEX.json`](EXECUTION_INDEX.json). Current execution contracts are
[`controller-packet.md`](phase-01/controller-packet.md) and
[`p1-f-freeze.md`](phase-01/lanes/p1-f-freeze.md). The prior
[`p1-i-integration.md`](phase-01/lanes/p1-i-integration.md) packet is immutable history, not current
execution authority.

## Accepted P1.I and canonical merge

P1.I received independent `ACCEPT` with P0/P1/P2 `0/0/0`. Integration attempt
`agent-teams-hosted-web-refactor-p1-i-integration-apply-v17-r2` integrated exactly five outputs in
`134f64f0c5c7bbbab0552eddf08df1508118f4bb^..134f64f0c5c7bbbab0552eddf08df1508118f4bb`.
Those five paths and their bytes remain frozen.

Canonical `20706bd067ce5ccbf13697700411904faa2a00c8` is clean and remote-equal. It is the accepted ordered
two-parent PR #252 merge: `20706bd067ce5ccbf13697700411904faa2a00c8^1` equals
`134f64f0c5c7bbbab0552eddf08df1508118f4bb`, and its second parent is
`6bf43f140878f8b79f7ee17349bd21b177df901d`. The P1.F worker must prove that the exact five output
bytes at the integration commit and canonical merge are identical. The second-parent-to-merge diff is
accumulated current-base history and must never substitute for the exact P1.I integration range.

Immutable r1 patch `2f7338a1e7b41955d15106f5fb3994b17db6749158bde8134a0a8e23d2081615` was independently
`REJECT`ed for only the incorrect merge proof. This r2 route retains every other useful r1 contract.

## Serial freeze lifecycle

After this router's independent acceptance and exact broker integration/push, root binds and attests
the pushed authority, then admits one independent P1.F worker using `gpt-5.6-sol`, `xhigh`,
`serviceTier: "default"`, with Fast disabled. The worker reads the exact 74-path manifest and writes
only the P1.F handoff and Phase 1 freeze report.

The worker reruns the 60-test Phase 1 suite and focused three-test ratchet suite, classifies typecheck
as seven inherited/zero owned/zero unexpected, requires full lint success and exact-74 Prettier,
reproves exact-54 scratch rollback, validates the true merge and current base, and completes
JSON/hash/link/diff/secret/provider/private-path/text scans. It verifies the exact 14 Phase 1 evidence
IDs, creates only `P1.F.FREEZE` and `P1.F.PHASE_EXIT`, performs complete self-review, and returns
explicit `ACCEPT` or `REJECT` before `HOLD`.

`ACCEPT` requires P0/P1/P2 `0/0/0` and permits only exact-two-path broker integration after root
`mark_reviewed`. A separate Phase 2 JIT router may be authored only after that integration is pushed
and attested. `REJECT` permits only bounded remediation of the same two paths against immutable
findings.

Phase 2+, unrelated nodes, product/test/runtime edits, P1.I repetition, controller replacement, and
successor controllers remain blocked.
