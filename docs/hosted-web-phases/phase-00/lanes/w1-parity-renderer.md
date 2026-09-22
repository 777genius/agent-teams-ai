# Phase 0 W1: Parity and Renderer Reachability

- Packet revision: `phase-00-r2`
- Evidence owner: W1
- Depends on: completed 0A base record and baseline classification
- Result states: `verified | characterized | blocked | failed`

## Mission

Produce the exact API/action ledger that prevents method-name parity and hidden Electron-only effects.

## Read set

Read the Phase 0 packet sections `Ownership rules`, `W1`, `Worker prompt contract`, `Shared evidence
schemas` and `Stop and fail-closed conditions`. From the master plan read only `Capability-segregated
renderer API`, `ADR-19`, `ADR-20`, `Capability and parity matrix`, `Renderer state, authority, and
migration invariants` and referenced source/tests.

## Writable paths

- `docs/research/hosted-web/phase-0/parity-renderer/**`
- `scripts/hosted-web/phase-0/parity-renderer/**`
- `test/architecture/hosted-web/phase-0/parity-renderer/**`
- worktree-local `.codex-handoff/phase-00-w1.json`

Do not edit production source, shared architecture docs, package files or another lane.

## Evidence

- `P0.W1.API_PARITY_LEDGER`: `api-parity-ledger.json`
- `P0.W1.RENDERER_ACTIONS`: `renderer-action-inventory.json`
- `P0.W1.LEGACY_BYPASSES`: `legacy-bypass-inventory.json`
- `P0.W1.SELECTION_INVARIANTS`: `selection-reconciliation-invariants.md`
- `P0.W1.SCANNER`: deterministic scanner plus positive and negative fixture tests
- `P0.W1.ESTIMATE`: `estimate-input.json`

## Acceptance

Counts come from the pinned AST; every visible control maps to one action or deliberate absence before
mount; dynamic dispatch is annotated and fixture-backed; hidden Electron/global-client/fabricated-success
paths are listed; selection, snapshot, tombstone, pagination and event/poll races are explicit; removing
or duplicating a required action makes the scanner test fail.

Do not migrate renderer code or create client facets in Phase 0.

## Handoff

Run targeted scanner tests, lint changed TypeScript files and `git diff --check`. Return the standard
handoff with ledger counts, unexplained dynamic sites, proof levels and estimate buckets.
