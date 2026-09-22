# SQLite Online Backup Spike

Evidence ID: `P0.W3.SQLITE_ONLINE_BACKUP_SPIKE`

## Environment

- Linux `6.8.0-124-generic`, x86_64
- Node `v24.16.0`, module ABI `137`
- `better-sqlite3` `12.11.1`
- Temporary marker-owned fixtures only; no user `CLAUDE_ROOT` access

This is a Phase 0 feasibility spike. It deliberately does not modify the internal-storage worker or
production backup behavior.

## Primitive

`sqlite-online-backup-spike.mjs` accepts an already-open source connection, first requires source
`integrity_check=ok`, then awaits `Database#backup(destination, { progress })`. Its progress callback
enforces a deadline and bounded pages per iteration. Completion is not accepted until a new read-only
connection independently opens the destination and returns `integrity_check=ok`.

On `SQLITE_BUSY` or `SQLITE_LOCKED`, the primitive returns typed `backup_busy`, removes any partial
destination and propagates failure. Corruption fails before publication. Deadline abort behaves the same
way. There is no `copyFile`, database-byte read/write, `wal_checkpoint`, or `VACUUM INTO` fallback.

## Exact checks

```text
node scripts/hosted-web/phase-0/state-writers/sqlite-online-backup-spike.mjs
node scripts/hosted-web/phase-0/state-writers/external-writer-negative-fixture.mjs
node scripts/hosted-web/phase-0/state-writers/verify-evidence.mjs
node --test test/architecture/hosted-web/phase-0/state-writers/state-writers.test.mjs
```

The test suite proves:

- the source has `journal_mode=wal` and a live `-wal` sidecar when backup begins;
- the destination reopens independently with 2,000 fixture rows and passes integrity checking;
- injected `SQLITE_BUSY` produces `backup_busy` and leaves no DB/WAL/SHM destination;
- a corrupt SQLite file produces `source_corrupt` before destination publication;
- an injected expired clock produces `backup_deadline` and removes partial output;
- source scanning rejects a raw-copy/checkpoint fallback;
- both executable fixtures are temporary-root-only and clean themselves.

The deterministic BUSY case is injected at the `Database#backup` adapter boundary. A portable real-lock
BUSY is timing- and SQLite-build-dependent because the Online Backup API can proceed through ordinary WAL
writes. Phase 1 still needs integration faults in the final worker and final container. The production
worker entry currently posts `core.handle()` synchronously; returning a Promise would put a Promise on the
wire. Phase 1 must introduce a typed async operation and await it before processing/posting the response.
