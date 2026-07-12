# Phase 0 current canonical controller indexes

This directory is the controller-owned current-state authority for Phase 0. It resolves
`P0.C1.IDENTITY.001` and `P0.C1.STALE.001` without rewriting historical producer, reviewer, audit,
baseline, or ledger records.

The one true `phaseStartSha` is
`a32f509e6d9bd31ba2135940e336729bf90c3d93`. The integrated canonical predecessor is
`c958c872fa22edf9b2d6a0741d7781b00957903c`. The files in this worktree form a freeze candidate on
that predecessor; they are pending integration and therefore have no freeze commit. A source base,
review base, predecessor, candidate tree, or eventual freeze commit must not be substituted for
another provenance role.

Current authority is split by concern:

- `lane-identity-index.json` records every original and later lane integration commit.
- `review-disposition-index.json` records explicit adopt/narrow decisions for the later W1/W2/W5
  bytes and the current W6 artifact-authority bytes.
- `decision-index.json` records the controller's current decisions and still-current blockers.
- `evidence-index.json` gives every current candidate evidence byte an exact lane, path, SHA-256,
  proof level, byte state, disposition, and true integration commit where one exists.
- `supersession-index.json` identifies historical claims that no longer represent current state.
  Supersession preserves the historical bytes but cannot revive their rejection or hold conclusions
  as current blockers.
- `hash-reconciliation.md` distinguishes the integrated predecessor bytes, the later integration
  commits that introduced them, and the two pack-relative W1 candidate bytes pending integration.
- `acceptance-and-completion.md` records the bounded candidate result and all unproved readiness
  items.
- `handoff-census.json` inventories the six canonical lane handoffs without treating stale registry
  progress as current authority.

The W1 raw bypass projection is intentionally external because it exceeds the evidence budget. Its
checked-in envelope stores only the stable pack-relative name `legacy-bypass-raw.json`, its digest and
record count, and a deterministic repository command. It never records a task-local temporary path.

W2 correction is also explicit: historical files use
`phaseStartSha=c72fd201867b9bcd1ef77d5e0f95ba379adb4fca`. That SHA is a W2 source
base, not the Phase 0 start. The later omission-sensitive W2 bytes are integrated at
`6d54e7c60d29812de5b96e471761486fbbc0842c`; target-image provider execution remains unverified.

Run the repository-portable gate with:

```bash
node docs/research/hosted-web/phase-0/freeze/current-canonical/verify-indexes.mjs
```

The controller environment can additionally re-hash external review records with:

```bash
node docs/research/hosted-web/phase-0/freeze/current-canonical/verify-indexes.mjs --include-controller-external
```

The gate validates all five indexes against `canonical-index.schema.json`, re-hashes repository and
Git-commit bytes, checks candidate-versus-integration provenance, enforces pack-relative W1 raw
evidence, verifies explicit later-byte dispositions, and proves the omission, stale-hash, and
duplicate-ID fixtures fail with their expected diagnostics.
