# P2.A: workspace identity

- Packet revision: `phase-02-jit-router-r1`.
- Role: product lane A; one of exactly five parallel product slots.
- Depends on: accepted and activated `P2.IF.INTEGRATION` foundation authority.
- Evidence IDs: `P2.A.RUNTIME_CONTEXT`, `P2.A.GLOBAL_PATH_RATCHET`.
- Result states: `verified | blocked | failed`; terminal state always `HOLD`.

## Mission

Define an immutable, value-only `RuntimeInstanceContext` and its domain validation so later composition
can inject deployment/boot/root references instead of adding mutable path globals. This lane defines
the boundary; it does not wire application composition or read the filesystem.

## Required reads

After the common mandatory order, read completely and in order:

1. master plan `Phase 2: identity substrate and externally read-only team lifecycle`, task 1;
2. accepted foundation `src/shared/contracts/hosted/identifiers.ts`;
3. `src/main/utils/pathDecoder.ts`;
4. `src/main/services/infrastructure/ConfigManager.ts`;
5. `src/features/recent-projects/main/infrastructure/identity/RecentProjectIdentityResolver.ts`; and
6. `test/architecture/hosted-web/phase-1/dependencies/feature-dependencies.test.ts`.

## Exact writable paths

1. `src/features/runtime-instance-context/contracts/runtime-instance-context.ts`
2. `src/features/runtime-instance-context/core/domain/RuntimeInstanceContext.ts`
3. `test/features/runtime-instance-context/RuntimeInstanceContext.test.ts`
4. `test/architecture/hosted-web/phase-2/runtime-instance-context-boundaries.test.ts`
5. `.codex-handoff/phase-02-p2-a.json`

Every barrel, `index.ts`, composition file, legacy path utility and sibling-lane path is read-only.

## Acceptance

- Context creation validates canonical deployment/boot identity and opaque root references, returns a
  deeply immutable value and rejects missing, cross-kind, mutable or unknown input.
- Contracts are value-only and browser-safe; the domain has no Node, Electron, transport, process,
  provider, filesystem or mutable-global dependency.
- The context exposes no operation authorization, process launch or orchestration policy. It is input
  to later ports, not a service locator.
- An architecture negative test rejects core imports of main/path/filesystem modules and mutable
  exported state.
- No existing global is migrated or newly read by product composition in this lane; actual composition
  adoption remains unverified for serial integration.
- The producer self-reviews the whole diff for dependency direction, immutability, interface
  segregation, exact scope and no sibling dependency.

## Focused checks

```text
pnpm exec vitest run test/features/runtime-instance-context/RuntimeInstanceContext.test.ts test/architecture/hosted-web/phase-2/runtime-instance-context-boundaries.test.ts
pnpm lint:fast:files -- src/features/runtime-instance-context/contracts/runtime-instance-context.ts src/features/runtime-instance-context/core/domain/RuntimeInstanceContext.ts test/features/runtime-instance-context/RuntimeInstanceContext.test.ts test/architecture/hosted-web/phase-2/runtime-instance-context-boundaries.test.ts
pnpm typecheck
pnpm exec prettier --check src/features/runtime-instance-context/contracts/runtime-instance-context.ts src/features/runtime-instance-context/core/domain/RuntimeInstanceContext.ts test/features/runtime-instance-context/RuntimeInstanceContext.test.ts test/architecture/hosted-web/phase-2/runtime-instance-context-boundaries.test.ts .codex-handoff/phase-02-p2-a.json
git diff --check
```

Prove exact ownership and classified secret/private-path scans across all five writable paths.

## Stop and handoff

Stop on stale foundation authority, ownership overlap, a required barrel/composition edit, a need for
another lane's output, a mutable global or any launch/runtime side effect. Do not commit, push,
integrate or launch successors.

The packet-standard handoff records exact evidence and the producer self-review. On success request
only combined `P2.R1.ARCH_SECURITY` after all five producers finish. Never claim sibling completion,
review or integration. End with `terminalState: HOLD`.
