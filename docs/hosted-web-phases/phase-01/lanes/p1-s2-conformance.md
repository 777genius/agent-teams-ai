# P1.S2 conformance lane

## Authority and provenance

- Phase/node: `phase-01` / `P1.1C`
- Packet revision: `phase-01-s2-conformance-r1`
- Base SHA: `041b5c7c2d3225b7dc2eca9e9b7b71aa33217060`
- Depends on: independently accepted and integrated `P1.1A`
- Evidence owner: `P1.1C`
- Evidence IDs: `P1.1C.CONFORMANCE`, `P1.1C.RATCHETS`
- Handoff: `.codex-handoff/phase-01-p1-1c.json`
- Result states: `verified | characterized | blocked | failed`

This is one of exactly two P1.S2 producer packets. It becomes executable only after the router commit
containing it is integrated and the successor controller reports `live=true`. It neither launches a
worker nor authorizes P1.1B or P1.S3+ work.

## Mission

Implement only the frozen semantic-harness scaffold, synthetic in-memory team-lifecycle fixture
corpus, and ADR-19/20 dependency/parity/renderer ratchets. Prove the P1.1C-owned negative controls
without creating P1.1D feature code, test transport adapters, production registration, a global API,
or filesystem behavior.

## Exact mandatory reads

Read in this order; no directory, glob, or implicit sibling read is authorized:

1. `AGENTS.md`
2. `docs/hosted-web-phases/START_HERE.md`
3. `docs/hosted-web-phases/EVIDENCE_LIFECYCLE.md`
4. `docs/hosted-web-phases/README.md`
5. `docs/hosted-web-phases/EXECUTION_INDEX.json`
6. `docs/hosted-web-phases/phase-01/controller-packet.md`
7. `docs/hosted-web-phases/phase-01/lanes/p1-s2-conformance.md`
8. `CLAUDE.md`
9. `AGENT_CRITICAL_GUARDRAILS.md`
10. `docs/FEATURE_ARCHITECTURE_STANDARD.md`
11. `docs/hosted-web-phases/PACKET_STANDARD.md`
12. `docs/hosted-web-phases/phase-01/execution-dag.md`
13. `docs/hosted-web-phases/phase-01/architecture-and-contracts.md`
14. `docs/hosted-web-phases/phase-01/conformance-and-tests.md`
15. `docs/research/hosted-web/phase-1/bootstrap/ownership-manifest.json`
16. `docs/research/hosted-web/phase-1/bootstrap/baseline-fingerprints.json`
17. `.codex-handoff/phase-01-p1-s1-schema-version-remediation.json`
18. `src/shared/contracts/hosted/app-error.ts`
19. `src/shared/contracts/hosted/identifiers.ts`
20. `src/shared/contracts/hosted/index.ts`
21. `src/shared/contracts/hosted/query-context.ts`
22. `src/shared/contracts/hosted/revision.ts`
23. `src/main/http/index.ts`
24. `src/main/http/teams.ts`
25. `src/main/ipc/teams.ts`
26. `src/main/services/infrastructure/HttpServer.ts`
27. `src/main/standalone.ts`
28. `src/preload/constants/ipcChannels.ts`
29. `src/preload/index.ts`
30. `src/renderer/api/index.ts`
31. `package.json`
32. `tsconfig.json`
33. `vitest.config.ts`

The files in items 23–30 are inspection-only frozen production boundaries. There are no pre-existing
mandatory P1.1C scripts or fixtures; this lane creates only the exact owned paths below.

## Exact writable paths

- `.codex-handoff/phase-01-p1-1c.json`
- `scripts/hosted-web/phase-1/check-feature-dependencies.ts`
- `scripts/hosted-web/phase-1/check-parity-references.ts`
- `scripts/hosted-web/phase-1/check-renderer-boundaries.ts`
- `test/architecture/hosted-web/phase-1/conformance/semantic-harness.test.ts`
- `test/architecture/hosted-web/phase-1/conformance/semantic-harness.ts`
- `test/architecture/hosted-web/phase-1/dependencies/feature-dependencies.test.ts`
- `test/architecture/hosted-web/phase-1/fixtures/core-side-effect.ts`
- `test/architecture/hosted-web/phase-1/fixtures/filesystem-adapter.ts`
- `test/architecture/hosted-web/phase-1/fixtures/forbidden-core-import.ts`
- `test/architecture/hosted-web/phase-1/fixtures/hosted-electron-api.ts`
- `test/architecture/hosted-web/phase-1/fixtures/legacy-god-dto.ts`
- `test/architecture/hosted-web/phase-1/fixtures/path-secret-leak.ts`
- `test/architecture/hosted-web/phase-1/fixtures/production-adapter-mount.ts`
- `test/architecture/hosted-web/phase-1/fixtures/ratchet-regression.ts`
- `test/architecture/hosted-web/phase-1/parity/parity-references.test.ts`
- `test/architecture/hosted-web/phase-1/renderer-boundaries/renderer-boundaries.test.ts`
- `test/fixtures/hosted-web/phase-1/team-lifecycle/manifest.json`
- `test/fixtures/hosted-web/phase-1/team-lifecycle/outcomes/corrupt.json`
- `test/fixtures/hosted-web/phase-1/team-lifecycle/outcomes/draft.json`
- `test/fixtures/hosted-web/phase-1/team-lifecycle/outcomes/empty.json`
- `test/fixtures/hosted-web/phase-1/team-lifecycle/outcomes/not-found-inapplicable.json`
- `test/fixtures/hosted-web/phase-1/team-lifecycle/outcomes/partial.json`
- `test/fixtures/hosted-web/phase-1/team-lifecycle/outcomes/provisioning-inapplicable.json`
- `test/fixtures/hosted-web/phase-1/team-lifecycle/outcomes/stale.json`
- `test/fixtures/hosted-web/phase-1/team-lifecycle/outcomes/success.json`
- `test/fixtures/hosted-web/phase-1/team-lifecycle/outcomes/unavailable.json`
- `test/fixtures/hosted-web/phase-1/team-lifecycle/outcomes/unexpected.json`

Everything else is read-only, including P1.1B paths, P1.1D feature/tests/adapters, existing P1.1A
contracts/tests/handoffs, package/lock/config files, docs, research, production registration, and the
future P1.R1 evidence path. A needed extra path is a stop condition.

## Acceptance and negative controls

1. The semantic harness and fixed corpus are deterministic, in-memory, path-free, transport-neutral
   P1.1D inputs; they do not implement the future list use case or an IPC/HTTP-shaped adapter.
2. The three scanners are narrow test tooling, content-sensitive where required, and fail deliberate
   mutations without becoming production manifests or generated-client inputs.
3. Owned controls fail with the frozen diagnostics: `P1.NEG.CORE_SIDE_EFFECT` /
   `phase1-core-side-effect-forbidden`; `P1.NEG.HOSTED_ELECTRON_API` /
   `phase1-hosted-electron-api-forbidden`; `P1.NEG.IMPORT_FORBIDDEN` /
   `phase1-core-import-forbidden`; `P1.NEG.LEGACY_GOD_DTO` /
   `phase1-legacy-god-dto-forbidden`; `P1.NEG.NO_FILESYSTEM_ADAPTER_PHASE1` /
   `phase1-filesystem-adapter-forbidden`; `P1.NEG.PARITY_DRIFT` /
   `phase1-parity-reference-drift`; `P1.NEG.PATH_SECRET_LEAK` /
   `phase1-path-secret-leak`; `P1.NEG.PRODUCTION_ADAPTER_MOUNT` /
   `phase1-test-adapter-production-import`; and `P1.NEG.RATCHET_REGRESSION` /
   `phase1-ratchet-regression`.
4. Every negative has its accepted-manifest positive neighbor where that neighbor is P1.1C-owned. The
   P1.1D-owned positive neighbors for `LEGACY_GOD_DTO` and `NO_FILESYSTEM_ADAPTER_PHASE1` remain
   absent and explicitly `unverified`; this lane must not create or edit them.
5. Existing debt may be pinned or quarantined but not declared fixed. Counts may not increase; a rename
   cannot evade a content-based scan; no new exception, dependency, config change, or shared ratchet
   file is allowed.
6. Fixtures contain only synthetic IDs, fixed clocks, deterministic outcomes, and fake principals. No
   host/project/runtime path, credential, auth/provider payload, command body, network, process,
   watcher, repair, cleanup, mutable cache, or real project is used.
7. Both evidence IDs reach the strongest truthful proof level. P1.1D semantics, production isolation
   beyond the owned ratchet, P1.R1 acceptance, and complete Phase 1 remain unverified.

## Required checks

Run and record exact commands, exit codes, and tool versions:

```bash
pnpm exec vitest run test/architecture/hosted-web/phase-1/conformance test/architecture/hosted-web/phase-1/dependencies test/architecture/hosted-web/phase-1/parity test/architecture/hosted-web/phase-1/renderer-boundaries
pnpm lint:fast:files -- scripts/hosted-web/phase-1/check-feature-dependencies.ts scripts/hosted-web/phase-1/check-parity-references.ts scripts/hosted-web/phase-1/check-renderer-boundaries.ts test/architecture/hosted-web/phase-1/conformance/semantic-harness.test.ts test/architecture/hosted-web/phase-1/conformance/semantic-harness.ts test/architecture/hosted-web/phase-1/dependencies/feature-dependencies.test.ts test/architecture/hosted-web/phase-1/fixtures/core-side-effect.ts test/architecture/hosted-web/phase-1/fixtures/filesystem-adapter.ts test/architecture/hosted-web/phase-1/fixtures/forbidden-core-import.ts test/architecture/hosted-web/phase-1/fixtures/hosted-electron-api.ts test/architecture/hosted-web/phase-1/fixtures/legacy-god-dto.ts test/architecture/hosted-web/phase-1/fixtures/path-secret-leak.ts test/architecture/hosted-web/phase-1/fixtures/production-adapter-mount.ts test/architecture/hosted-web/phase-1/fixtures/ratchet-regression.ts test/architecture/hosted-web/phase-1/parity/parity-references.test.ts test/architecture/hosted-web/phase-1/renderer-boundaries/renderer-boundaries.test.ts
pnpm typecheck
pnpm exec prettier --check .codex-handoff/phase-01-p1-1c.json scripts/hosted-web/phase-1/check-feature-dependencies.ts scripts/hosted-web/phase-1/check-parity-references.ts scripts/hosted-web/phase-1/check-renderer-boundaries.ts test/architecture/hosted-web/phase-1/conformance/semantic-harness.test.ts test/architecture/hosted-web/phase-1/conformance/semantic-harness.ts test/architecture/hosted-web/phase-1/dependencies/feature-dependencies.test.ts test/architecture/hosted-web/phase-1/fixtures/core-side-effect.ts test/architecture/hosted-web/phase-1/fixtures/filesystem-adapter.ts test/architecture/hosted-web/phase-1/fixtures/forbidden-core-import.ts test/architecture/hosted-web/phase-1/fixtures/hosted-electron-api.ts test/architecture/hosted-web/phase-1/fixtures/legacy-god-dto.ts test/architecture/hosted-web/phase-1/fixtures/path-secret-leak.ts test/architecture/hosted-web/phase-1/fixtures/production-adapter-mount.ts test/architecture/hosted-web/phase-1/fixtures/ratchet-regression.ts test/architecture/hosted-web/phase-1/parity/parity-references.test.ts test/architecture/hosted-web/phase-1/renderer-boundaries/renderer-boundaries.test.ts test/fixtures/hosted-web/phase-1/team-lifecycle/manifest.json test/fixtures/hosted-web/phase-1/team-lifecycle/outcomes/corrupt.json test/fixtures/hosted-web/phase-1/team-lifecycle/outcomes/draft.json test/fixtures/hosted-web/phase-1/team-lifecycle/outcomes/empty.json test/fixtures/hosted-web/phase-1/team-lifecycle/outcomes/not-found-inapplicable.json test/fixtures/hosted-web/phase-1/team-lifecycle/outcomes/partial.json test/fixtures/hosted-web/phase-1/team-lifecycle/outcomes/provisioning-inapplicable.json test/fixtures/hosted-web/phase-1/team-lifecycle/outcomes/stale.json test/fixtures/hosted-web/phase-1/team-lifecycle/outcomes/success.json test/fixtures/hosted-web/phase-1/team-lifecycle/outcomes/unavailable.json test/fixtures/hosted-web/phase-1/team-lifecycle/outcomes/unexpected.json
git diff --check
git status --short
```

The accepted manifest freezes these negative-control commands; run each applicable command and record
the exact diagnostic:

```bash
pnpm exec vitest run test/architecture/hosted-web/phase-1/dependencies/feature-dependencies.test.ts
pnpm exec vitest run test/architecture/hosted-web/phase-1/renderer-boundaries/renderer-boundaries.test.ts
pnpm exec vitest run test/architecture/hosted-web/phase-1/parity/parity-references.test.ts
pnpm exec vitest run test/architecture/hosted-web/phase-1/conformance/semantic-harness.test.ts
```

The manifest also freezes the cross-owner command
`pnpm exec vitest run test/architecture/hosted-web/phase-1/dependencies/feature-dependencies.test.ts test/features/team-lifecycle/contracts/listTeamLifecycleSummaries.test.ts`
for `P1.NEG.LEGACY_GOD_DTO`. Its P1.1D-owned second path does not exist in P1.S2. Do not create it or
claim the combined result; record the combined check and P1.1D positive-neighbor proof as `unverified`
while the focused P1.1C dependency test proves only this lane's frozen fixture/scanner half.

Prove that the changed/untracked set is exactly the 28 writable paths,
every non-owned path matches `phaseStartSha`, and the integrated router start differs from the
canonical base only on its eight contract-owned docs paths. Scan all changed and untracked files,
including JSON and the handoff, for secrets, credentials, auth/provider payloads, private, home, or
real-project paths, raw command/runtime bodies, and binary files; review every match.

## Stop conditions

Stop and return the standard blocker record on a stale base, router, packet, phase start, or controller
with `live!=true`; pre-integration work; duplicate/prior packet use; path overlap; changed predecessor
or accepted evidence; a need for any extra path or dependency; a missing mutation/positive neighbor
within P1.1C ownership or exact diagnostic; an attempt to create a P1.1D-owned neighbor; production
import/mount exposure; filesystem/path-taking/runtime work; non-deterministic or secret/private-path
evidence; unclassified owned-path failure; or any attempt to start P1.S3+. Do not retry, refill, repair
the sibling, or widen scope.

## Handoff

Write `.codex-handoff/phase-01-p1-1c.json` using `PACKET_STANDARD.md`. Include base, exact integrated
router `phaseStartSha`/plan bundle, packet revision, both evidence IDs and proof levels, exact changed
paths, all commands/exit codes/tool versions, the complete owned negative-result matrix and stable
diagnostics, fixture hashes, explicitly unverified P1.1D neighbor/semantic claims, blockers, and the
binary patch SHA-256 plus per-file SHA-256 values.

The only safe next action is to wait for the independent P1.1B handoff and a separately authorized
P1.R1 router decision. Do not request or start P1.R1, P1.1D, integration, or production work.
