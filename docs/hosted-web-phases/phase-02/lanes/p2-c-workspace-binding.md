# P2.C: workspace binding

- Packet revision: `phase-02-jit-router-r1`.
- Role: product lane C; one of exactly five parallel product slots.
- Depends on: accepted and activated `P2.IF.INTEGRATION` foundation authority.
- Evidence IDs: `P2.C.WORKSPACE_REGISTRY`, `P2.C.MOUNT_GENERATION`,
  `P2.C.ROOT_ADMISSION`, `P1.NEG.TEST_ROOT_ESCAPE`.
- Result states: `verified | blocked | failed`; terminal state always `HOLD`.

## Mission

Create a bounded `workspace-registry` feature with registrationKey-stable opaque identity,
boot-scoped mount binding and operation-specific authorization. Its only infrastructure is a read-only
startup manifest adapter; it never becomes a global filesystem repository.

## Required reads

After the common mandatory order, read completely and in order:

1. master plan `Phase 2: identity substrate and externally read-only team lifecycle`, task 2 and the
   WorkspaceId/mount-generation exit gates;
2. master-plan `ADR-25`;
3. accepted foundation `src/shared/contracts/hosted/identifiers.ts`;
4. `src/features/recent-projects/contracts/dto.ts`;
5. `src/features/recent-projects/contracts/api.ts`;
6. `src/features/recent-projects/main/infrastructure/identity/RecentProjectIdentityResolver.ts`;
7. `src/main/utils/pathValidation.ts`; and
8. `test/architecture/hosted-web/phase-1/dependencies/feature-dependencies.test.ts`.

## Exact writable paths

1. `src/features/workspace-registry/contracts/workspace-registration.ts`
2. `src/features/workspace-registry/core/domain/WorkspaceRegistration.ts`
3. `src/features/workspace-registry/core/application/AuthorizeWorkspaceOperation.ts`
4. `src/features/workspace-registry/main/infrastructure/ReadOnlyWorkspaceManifestAdapter.ts`
5. `test/features/workspace-registry/core/WorkspaceRegistration.test.ts`
6. `test/features/workspace-registry/core/AuthorizeWorkspaceOperation.test.ts`
7. `test/features/workspace-registry/main/ReadOnlyWorkspaceManifestAdapter.test.ts`
8. `.codex-handoff/phase-02-p2-c.json`

All indexes, barrels, composition, path utilities, shared contracts and sibling paths are read-only.

## Acceptance

- A stable registration key maps to one opaque WorkspaceId across restart; display/root changes cannot
  silently replace identity. Duplicate, disabled, unknown-version or ambiguous registrations fail
  closed.
- `WorkspaceMountBinding` is boot-scoped and mount generation advances on a new binding. Prior-boot or
  stale-generation authorization inputs are rejected.
- Application authorization is operation-specific and returns server-only, non-serializable intent;
  it does not expose a generic filesystem capability or raw host path to transport contracts.
- The manifest adapter reads only an injected, pre-admitted startup source and never writes,
  auto-registers, scans ambient roots or performs composition.
- Tests use only newly created marker-owned temporary project/runtime roots. Root admission rejects
  unmarked, pre-existing, ambient, home, real-project, parent/final-symlink and escaped roots before
  any adapter access; cleanup is narrow and marker-checked. This supplies `P1.NEG.TEST_ROOT_ESCAPE`.
- Core imports no Node, main or transport module. Public barrels and production registration remain
  unverified for serial integration.
- The producer self-reviews the complete diff for DDD invariants, authorization least privilege,
  TOCTOU assumptions, dependency inversion, exact scope and scans.

## Focused checks

```text
pnpm exec vitest run test/features/workspace-registry/core/WorkspaceRegistration.test.ts test/features/workspace-registry/core/AuthorizeWorkspaceOperation.test.ts test/features/workspace-registry/main/ReadOnlyWorkspaceManifestAdapter.test.ts
pnpm lint:fast:files -- src/features/workspace-registry/contracts/workspace-registration.ts src/features/workspace-registry/core/domain/WorkspaceRegistration.ts src/features/workspace-registry/core/application/AuthorizeWorkspaceOperation.ts src/features/workspace-registry/main/infrastructure/ReadOnlyWorkspaceManifestAdapter.ts test/features/workspace-registry/core/WorkspaceRegistration.test.ts test/features/workspace-registry/core/AuthorizeWorkspaceOperation.test.ts test/features/workspace-registry/main/ReadOnlyWorkspaceManifestAdapter.test.ts
pnpm typecheck
pnpm exec prettier --check src/features/workspace-registry/contracts/workspace-registration.ts src/features/workspace-registry/core/domain/WorkspaceRegistration.ts src/features/workspace-registry/core/application/AuthorizeWorkspaceOperation.ts src/features/workspace-registry/main/infrastructure/ReadOnlyWorkspaceManifestAdapter.ts test/features/workspace-registry/core/WorkspaceRegistration.test.ts test/features/workspace-registry/core/AuthorizeWorkspaceOperation.test.ts test/features/workspace-registry/main/ReadOnlyWorkspaceManifestAdapter.test.ts .codex-handoff/phase-02-p2-c.json
git diff --check
```

Prove exact ownership and classified secret/private-path scans across all eight writable paths.

## Stop and handoff

Stop on stale foundation authority, an undeclared export/composition need, a sibling dependency,
unsupported filesystem semantics, unsafe roots, raw-path leakage or authorization broader than one
operation. Do not commit, push, integrate or launch successors.

The packet-standard handoff records the root-admission negative matrix, exact evidence and producer
self-review. On success request only combined `P2.R1.ARCH_SECURITY` after all five producers finish.
End with `terminalState: HOLD`.
