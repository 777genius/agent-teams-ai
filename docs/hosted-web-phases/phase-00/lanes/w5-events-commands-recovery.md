# Phase 0 W5: Events, Commands and Recovery

- Packet revision: `phase-00-r2`
- Evidence owner: W5
- Depends on: completed 0A base record and baseline classification

## Mission

Prove snapshot plus replay cannot lose a concurrent mutation and transport retries cannot repeat an
ambiguous external effect.

## Read set

Read the Phase 0 W5, ownership, shared-schema and stop sections. From the master plan read `ADR-27`,
`ADR-33`, `ADR-34`, `Realtime model`, `Reconciliation`, `Renderer state, authority, and migration
invariants` and provider delivery/idempotency journals.

## Writable paths

- `docs/research/hosted-web/phase-0/recovery-events/**`
- `scripts/hosted-web/phase-0/recovery-events/**`
- `test/architecture/hosted-web/phase-0/recovery-events/**`
- worktree-local `.codex-handoff/phase-00-w5.json`

## Evidence

- `P0.W5.EVENT_CURSOR_INVENTORY`
- `P0.W5.SNAPSHOT_HANDOFF_SCHEDULER`
- `P0.W5.COMMAND_CATALOG`
- `P0.W5.EFFECT_RECOVERY_MATRIX`
- `P0.W5.FINGERPRINT_GOLDENS`
- `P0.W5.ESTIMATE`

## Acceptance

Exercise pauses around read, commit, cursor, serialization, listener and replay; reproduce known lost-
event schedules as negative controls; converge with duplicates but no gaps; assign every required
mutation a normalized intent and recovery class; reject key reuse with changed intent; map ambiguous
non-reconcilable effects to `operator_required`; retain versioned fingerprint golden vectors.

Do not introduce event sourcing, claim exactly-once or persist sensitive command bodies.

## Handoff

Return explored schedules, counterexamples, convergence proof, ambiguous effect list, checks and proof
levels in the standard handoff.
