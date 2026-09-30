# P2.D: roster identity

- Packet revision: `phase-02-jit-router-r1`.
- Role: product lane D; one of exactly five parallel product slots.
- Depends on: accepted and activated `P2.IF.INTEGRATION` foundation authority.
- Evidence IDs: `P2.D.IDENTITY_FILE`, `P2.D.DIRECTORY_LIFECYCLE`,
  `P2.D.BACKUP_COMPATIBILITY`, `P1.NEG.TEST_ROOT_ESCAPE`.
- Result states: `verified | blocked | failed`; terminal state always `HOLD`.

## Mission

Implement narrow ports and uncomposed infrastructure for a write-once `team.identity.json`,
identity-aware directory lifecycle and legacy backup compatibility. Prove the prepare/publish/commit
and cleanup invariants without wiring existing create/delete/backup call sites or consuming sibling
lane implementations.

## Required reads

After the common mandatory order, read completely and in order:

1. master plan `Phase 2: identity substrate and externally read-only team lifecycle`, tasks 3 and 4
   and their identity publication/deletion/backup exit gates;
2. master-plan `ADR-6`, `ADR-25`, `ADR-28` and `ADR-29` identity-relevant rules;
3. accepted foundation `src/shared/contracts/hosted/identifiers.ts`;
4. `src/main/services/team/TeamBackupService.ts`;
5. `src/main/services/team/TeamConfigReader.ts`;
6. `src/main/services/team/TeamDataService.ts`;
7. `src/main/utils/atomicWrite.ts`;
8. `src/main/utils/pathValidation.ts`; and
9. `test/main/services/team/TeamBackupService.test.ts`.

## Exact writable paths

1. `src/features/team-lifecycle/core/application/ports/TeamIdentityPersistence.ts`
2. `src/features/team-lifecycle/main/infrastructure/TeamIdentityFileStore.ts`
3. `src/features/team-lifecycle/main/infrastructure/TeamDirectoryLifecycleAdapter.ts`
4. `src/features/team-lifecycle/main/infrastructure/TeamIdentityBackupCompatibility.ts`
5. `test/features/team-lifecycle/main/TeamDirectoryIdentity.test.ts`
6. `test/architecture/hosted-web/phase-2/team-directory-identity-boundaries.test.ts`
7. `.codex-handoff/phase-02-p2-d.json`

Existing team services, backup services, indexes, composition and sibling paths are read-only. Their
later wiring is serial integration work.

## Acceptance

- The application port describes prepare, publish evidence, commit, tombstone and mismatch outcomes
  using canonical IDs and value-only records; it imports no infrastructure.
- `TeamIdentityFileStore` validates an admitted root, publishes exclusively and write-once, fsyncs the
  file and parent as supported, and never rewrites an existing identity. File/intent/checksum mismatch,
  missing-after-commit, corrupt/future identity and duplicate ID block read/write capability.
- The directory adapter preserves the anchor for committed draft/team failure, removes only
  attempt-owned artifacts, durably tombstones before permanent removal, rejects same-key resurrection
  and requires explicit delete semantics. Generic recursive root removal is not exposed.
- Backup compatibility explicitly includes canonical identity in async and shutdown/sync inventories,
  keeps legacy identity evidence distinct and labels the result `legacy_unverified`; it does not claim
  full recovery.
- All filesystem proofs use fresh marker-owned temporary project/runtime roots. Unmarked,
  pre-existing, ambient, home, real-project and symlink-escaped roots fail before access; cleanup is
  narrow and marker-checked. Architecture negatives reject bypass deletion. This supplies
  `P1.NEG.TEST_ROOT_ESCAPE` independently of lane C.
- The adapter depends only on its own application port and the integrated identity kernel, not P2.B or
  P2.C source. Actual storage/registry binding and legacy call-site routing remain unverified for
  integration.
- The producer self-reviews crash boundaries, containment assumptions, identity immutability,
  dependency direction, exact scope and scans.

## Focused checks

```text
pnpm exec vitest run test/features/team-lifecycle/main/TeamDirectoryIdentity.test.ts test/architecture/hosted-web/phase-2/team-directory-identity-boundaries.test.ts
pnpm lint:fast:files -- src/features/team-lifecycle/core/application/ports/TeamIdentityPersistence.ts src/features/team-lifecycle/main/infrastructure/TeamIdentityFileStore.ts src/features/team-lifecycle/main/infrastructure/TeamDirectoryLifecycleAdapter.ts src/features/team-lifecycle/main/infrastructure/TeamIdentityBackupCompatibility.ts test/features/team-lifecycle/main/TeamDirectoryIdentity.test.ts test/architecture/hosted-web/phase-2/team-directory-identity-boundaries.test.ts
pnpm typecheck
pnpm exec prettier --check src/features/team-lifecycle/core/application/ports/TeamIdentityPersistence.ts src/features/team-lifecycle/main/infrastructure/TeamIdentityFileStore.ts src/features/team-lifecycle/main/infrastructure/TeamDirectoryLifecycleAdapter.ts src/features/team-lifecycle/main/infrastructure/TeamIdentityBackupCompatibility.ts test/features/team-lifecycle/main/TeamDirectoryIdentity.test.ts test/architecture/hosted-web/phase-2/team-directory-identity-boundaries.test.ts .codex-handoff/phase-02-p2-d.json
git diff --check
```

Prove exact ownership and classified secret/private-path scans across all seven writable paths.

## Stop and handoff

Stop on stale foundation authority, unsafe root admission, unsupported durability, undeclared legacy
edits, sibling coupling, automatic identity replacement, generic deletion or a claim of verified
backup recovery. Do not commit, push, integrate or launch successors.

The packet-standard handoff records the crash/root negative matrix, exact evidence and producer
self-review. On success request only combined `P2.R1.ARCH_SECURITY` after all five producers finish.
End with `terminalState: HOLD`.
