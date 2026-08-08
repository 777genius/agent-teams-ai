# Phase 0 accepted canonical freeze

This directory is the controller-owned current-state authority for Phase 0. It resolves
`P0.C1.IDENTITY.001` and `P0.C1.STALE.001` without rewriting historical producer, reviewer, audit,
baseline, or ledger records.

The one true `phaseStartSha` is `a32f509e6d9bd31ba2135940e336729bf90c3d93`. Phase 0 is accepted and
frozen at exact candidate `f4fa24aac9615a4ce10632965a2244a2e11a273e`. Its accepted supporting
authorities are orchestration `1587615c751c3cb12b5078ab4b7264b6e9fd42ad`, bounded navigation
`f32be6a6fcb2da7a47ef3553476430ef8052e19a`, and estimate reconciliation
`f4fa24aac9615a4ce10632965a2244a2e11a273e`. A lane source base, review base, phase start, evidence
integration commit, or freeze commit must not be substituted for another provenance role.

Current authority is split by concern:

- `lane-identity-index.json` records every original and later lane integration commit.
- `review-disposition-index.json` records lane dispositions plus exact hashes and commits for the
  accepted target-image, final-gate, orchestration, navigation, and estimate authorities.
- `decision-index.json` records the controller's frozen decisions and the S0-only Phase 1 transition.
- `evidence-index.json` gives every current evidence byte an exact lane, path, SHA-256, proof level,
  byte state, disposition, and true integration commit.
- `supersession-index.json` identifies historical claims that no longer represent current state.
  Supersession preserves the historical bytes but cannot revive their rejection or hold conclusions.
- `hash-reconciliation.md` distinguishes exact evidence-byte commits from the accepted freeze.
- `acceptance-and-completion.md` records completion, removed blockers, and implementation risks.
- `handoff-census.json` inventories the six canonical lane handoffs without treating stale registry
  progress as current authority.

The W1 raw bypass projection is intentionally external because it exceeds the evidence budget. Its
checked-in envelope stores only the stable pack-relative name `legacy-bypass-raw.json`, its digest and
record count, and a deterministic repository command. The corrected bytes are integrated at
`a6bd7a39aebb4d822f57707c96c5e071b2aecb2b`; no task-local path is recorded.

W2 correction is also explicit: historical files use
`phaseStartSha=c72fd201867b9bcd1ef77d5e0f95ba379adb4fca`. That SHA is a W2 source
base, not the Phase 0 start. The later omission-sensitive W2 bytes are integrated at
`6d54e7c60d29812de5b96e471761486fbbc0842c`. Target-image provider execution remains unverified as a
later implementation risk, not a Phase 0 research blocker.

Run the repository-portable gate with:

```bash
node docs/research/hosted-web/phase-0/freeze/current-canonical/verify-indexes.mjs
```

The controller environment can additionally re-hash external review records with:

```bash
node docs/research/hosted-web/phase-0/freeze/current-canonical/verify-indexes.mjs --include-controller-external
```

The gate validates all five indexes against `canonical-index.schema.json`, re-hashes repository and
Git-commit bytes, checks the exact accepted authorities and freeze provenance, enforces pack-relative
W1 raw evidence, verifies explicit later-byte dispositions, checks the S0-only router, and proves the
omission, stale-hash, and duplicate-ID fixtures fail with their expected diagnostics.
