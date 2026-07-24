# P2.F0: identity foundation

- Packet revision: `phase-02-jit-router-r1`.
- Role: short serial product producer; one product slot.
- Depends on: independently accepted and broker-integrated Phase 2 router authority.
- Evidence IDs: `P2.F0.CANONICAL_IDENTITY`, `P2.F0.IDENTITY_COMPATIBILITY`.
- Result states: `verified | blocked | failed`; terminal state always `HOLD`.

## Mission

Make the existing hosted identifier kernel production-capable for opaque canonical `TeamId` and
`WorkspaceId` values without deriving either identity from a display name, legacy directory key or
path. Preserve Phase 1 compatibility and keep the change small enough for a single architecture and
security review before serial foundation integration.

## Required reads

After the common mandatory order in [START_HERE.md](../../START_HERE.md), read completely and in order:

1. master plan `Phase 2: identity substrate and externally read-only team lifecycle`, task 2 and its
   identity exit gates in `docs/hosted-web-e2e-completion-plan.md`;
2. `src/shared/contracts/hosted/identifiers.ts`;
3. `src/shared/contracts/hosted/index.ts`;
4. `src/features/team-lifecycle/contracts/team-lifecycle-read.ts`;
5. `test/architecture/hosted-web/phase-1/contracts/identifiers.test.ts`; and
6. `test/architecture/hosted-web/phase-1/team-lifecycle/team-lifecycle-read-contract.test.ts`.

## Exact writable paths

1. `src/shared/contracts/hosted/identifiers.ts`
2. `src/shared/contracts/hosted/index.ts`
3. `test/architecture/hosted-web/phase-1/contracts/identifiers.test.ts`
4. `test/architecture/hosted-web/phase-2/identity/canonical-identifiers.test.ts`
5. `.codex-handoff/phase-02-p2-f0.json`

All other paths are read-only. This serial node may update the shared hosted-contract barrel only for
its identity exports; parallel lanes may not. No production persistence, filesystem or composition is
owned here.

## Acceptance

- Canonical TeamId and WorkspaceId types and parsers are opaque, kind-separated and bounded.
- Valid IDs survive parse/serialize/reparse byte-for-byte; invalid, cross-kind, whitespace-bearing,
  name-like and path-like values fail closed.
- No API derives canonical identity from `teamName`, display name, legacy key, project path or root.
- The Phase 1 synthetic parser remains only as an explicit compatibility surface if required to keep
  frozen Phase 1 callers green; new Phase 2 code consumes the canonical parsers.
- The shared kernel contains values and validation only: no filesystem, clock, random generator,
  repository, transport, Electron or main-process dependency.
- Existing Phase 1 contract tests remain green. Restart/rename stability remains unverified until the
  storage and registry lanes prove persistence.
- The producer rereads and self-reviews the complete diff for Clean Architecture, DDD, SOLID, safe
  errors and exact scope. A separate per-lane reviewer is not requested.

## Focused checks

```text
pnpm exec vitest run test/architecture/hosted-web/phase-1/contracts/identifiers.test.ts test/architecture/hosted-web/phase-2/identity/canonical-identifiers.test.ts
pnpm lint:fast:files -- src/shared/contracts/hosted/identifiers.ts src/shared/contracts/hosted/index.ts test/architecture/hosted-web/phase-1/contracts/identifiers.test.ts test/architecture/hosted-web/phase-2/identity/canonical-identifiers.test.ts
pnpm typecheck
pnpm exec prettier --check src/shared/contracts/hosted/identifiers.ts src/shared/contracts/hosted/index.ts test/architecture/hosted-web/phase-1/contracts/identifiers.test.ts test/architecture/hosted-web/phase-2/identity/canonical-identifiers.test.ts .codex-handoff/phase-02-p2-f0.json
git diff --check
```

Also prove the exact ownership diff and run classified secret and private-path scans across the five
writable paths.

## Stop and handoff

Stop on stale router authority, an undeclared path, a need for persistence/composition, compatibility
breakage, identity derivation from mutable legacy data, or any unsafe test root. Do not commit, push,
integrate or launch successors.

Write the packet-standard handoff with exact base/revision, changed paths, commands/exit codes,
evidence, proof levels, self-review, findings, blockers and unverified claims. On success the only
requested action is `P2.R0.ARCH_SECURITY`; do not claim its acceptance. End with
`terminalState: HOLD`.
