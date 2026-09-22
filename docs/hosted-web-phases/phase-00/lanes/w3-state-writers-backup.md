# Phase 0 W3: State, External Writers and Backup

- Packet revision: `phase-00-r2`
- Evidence owner: W3
- Depends on: completed 0A base record and baseline classification

## Mission

Catalog durable authority and prove the minimum safe SQLite backup primitive without pretending that
provider-owned JSON files are transactional.

## Read set

Read the Phase 0 W3, ownership, schema and stop sections. From the master plan read `Data ownership
catalog required before writes`, `Mutation commit protocol`, `ADR-23`, `ADR-24`, `ADR-29`, `ADR-32`
and `External-writer observation algorithm`.

## Writable paths

- `docs/research/hosted-web/phase-0/state-writers/**`
- `scripts/hosted-web/phase-0/state-writers/**`
- `test/architecture/hosted-web/phase-0/state-writers/**`
- worktree-local `.codex-handoff/phase-00-w3.json`

## Evidence

- `P0.W3.STATE_FAMILY_CATALOG`
- `P0.W3.WRITER_COORDINATION`
- `P0.W3.SCHEMA_UNKNOWN_FIELDS`
- `P0.W3.BACKUP_BEHAVIOR`
- `P0.W3.SQLITE_ONLINE_BACKUP_SPIKE`
- `P0.W3.ESTIMATE`

## Acceptance

Every state family names its authority, writers, schema, atomicity, corruption policy and backup role;
each mutation gets an honest coordination class; a negative fixture disproves app-only locking against
an external writer; SQLite backup runs under WAL, reopens independently and fails safely on BUSY or
corruption instead of raw-copying DB/WAL/SHM.

Use only temporary marker-owned fixtures. Do not read or write user `~/.claude` state.

## Handoff

Return state-family counts, unresolved writer identities, backup fault results, proof levels, exact
checks and ADR recommendations through `.codex-handoff/phase-00-w3.json`.
