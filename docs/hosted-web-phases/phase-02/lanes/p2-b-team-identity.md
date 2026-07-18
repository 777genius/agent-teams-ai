# P2.B: team identity

- Packet revision: `phase-02-jit-router-r1`.
- Role: product lane B; one of exactly five parallel product slots.
- Depends on: accepted and activated `P2.IF.INTEGRATION` foundation authority.
- Evidence IDs: `P2.B.IDENTITY_RECORDS`, `P2.B.IDENTITY_TOMBSTONES`,
  `P2.B.ADOPTION_INTENTS`.
- Result states: `verified | blocked | failed`; terminal state always `HOLD`.

## Mission

Implement the isolated internal-storage contract, SQLite schema fragment and worker operations for
canonical team identity records, immutable legacy-key reservations/tombstones and prepared/committed
adoption intents. Registration into the shared worker protocol and composition is later serial
integration work.

## Required reads

After the common mandatory order, read completely and in order:

1. master plan `Phase 2: identity substrate and externally read-only team lifecycle`, tasks 2 and 4;
2. accepted foundation `src/shared/contracts/hosted/identifiers.ts`;
3. `src/features/internal-storage/contracts/internalStorageContracts.ts`;
4. `src/features/internal-storage/main/infrastructure/worker/internalStorageSchema.ts`;
5. `src/features/internal-storage/main/infrastructure/worker/internalStorageMigrations.ts`;
6. `src/features/internal-storage/main/infrastructure/worker/internalStorageWorkerProtocol.ts`;
7. `src/features/internal-storage/main/infrastructure/worker/InternalStorageWorkerCore.ts`; and
8. `test/features/internal-storage/InternalStorageWorkerCore.test.ts`.

## Exact writable paths

1. `src/features/internal-storage/contracts/teamIdentityStorageContracts.ts`
2. `src/features/internal-storage/main/infrastructure/worker/teamIdentityStorageSchema.ts`
3. `src/features/internal-storage/main/infrastructure/worker/teamIdentityStorageOps.ts`
4. `test/features/internal-storage/TeamIdentityStorage.test.ts`
5. `.codex-handoff/phase-02-p2-b.json`

Shared schema, migration, protocol, worker-core, composition and index files are read-only and reserved
to `P2.I.INTEGRATION`.

## Acceptance

- The contract represents canonical TeamId, legacy-key reservation, tombstone, directory fingerprint,
  workspace binding generation and adoption states without exposing raw database rows to core.
- SQLite constraints make TeamId and active legacy-key ownership unique and prevent tombstoned key
  reuse. Prepare/commit transitions are idempotent and distinguish retry, mismatch and tampering.
- Unknown schema/state, checksum disagreement, duplicate identity and illegal transition fail closed;
  no name-based replacement or last-write-wins repair exists.
- There is no critical JSON fallback, filesystem identity file publication, workspace authorization,
  transport or composition in this lane.
- Tests use an isolated test database under a fresh marker-owned temporary runtime root and perform
  marker-checked cleanup. Unmarked, pre-existing, ambient or symlink-escaped roots are rejected before
  access.
- Shared worker registration and durable restart proof remain unverified until integration imports
  this fragment. The producer self-reviews exact scope, SQL constraints, transition invariants,
  dependency direction and scan classifications.

## Focused checks

```text
pnpm exec vitest run test/features/internal-storage/TeamIdentityStorage.test.ts
pnpm lint:fast:files -- src/features/internal-storage/contracts/teamIdentityStorageContracts.ts src/features/internal-storage/main/infrastructure/worker/teamIdentityStorageSchema.ts src/features/internal-storage/main/infrastructure/worker/teamIdentityStorageOps.ts test/features/internal-storage/TeamIdentityStorage.test.ts
pnpm typecheck
pnpm exec prettier --check src/features/internal-storage/contracts/teamIdentityStorageContracts.ts src/features/internal-storage/main/infrastructure/worker/teamIdentityStorageSchema.ts src/features/internal-storage/main/infrastructure/worker/teamIdentityStorageOps.ts test/features/internal-storage/TeamIdentityStorage.test.ts .codex-handoff/phase-02-p2-b.json
git diff --check
```

Prove exact ownership plus classified secret/private-path scans across all five writable paths.

## Stop and handoff

Stop on stale foundation authority, shared-file pressure, a sibling dependency, unsafe root admission,
ambiguous recovery, destructive repair or a need for worker/composition registration. Do not commit,
push, integrate or launch successors.

The packet-standard handoff records exact schema/transition tests and self-review. On success request
only combined `P2.R1.ARCH_SECURITY` after all five producers finish. End with
`terminalState: HOLD`.
