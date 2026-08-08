# P1.S2 routes lane

## Authority and provenance

- Phase/node: `phase-01` / `P1.1B`
- Packet revision: `phase-01-s2-routes-r1`
- Base SHA: `041b5c7c2d3225b7dc2eca9e9b7b71aa33217060`
- Depends on: independently accepted and integrated `P1.1A`
- Evidence owner: `P1.1B`
- Evidence IDs: `P1.1B.ROUTES`, `P1.1B.CAPABILITIES`
- Handoff: `.codex-handoff/phase-01-p1-1b.json`
- Result states: `verified | characterized | blocked | failed`

This is one of exactly two P1.S2 producer packets. It becomes executable only after the router commit
containing it is integrated and the successor controller reports `live=true`. It neither launches a
worker nor authorizes P1.1C or P1.S3+ work.

## Mission

Implement only the frozen RouteCatalog collection/assertions and separate capability cross-reference.
Route and method/path IDs, required handler/schema/policy/client/test references, and capability/action
IDs must be unique and complete. Catalog assertions operate on immutable test descriptors; production
catalogs reject `testOnly` routes and production support remains absent. Do not create a runtime route
framework, dispatcher, generated client, feature DTO, or production registration.

## Exact mandatory reads

Read in this order; no directory, glob, or implicit sibling read is authorized:

1. `AGENTS.md`
2. `docs/hosted-web-phases/START_HERE.md`
3. `docs/hosted-web-phases/EVIDENCE_LIFECYCLE.md`
4. `docs/hosted-web-phases/README.md`
5. `docs/hosted-web-phases/EXECUTION_INDEX.json`
6. `docs/hosted-web-phases/phase-01/controller-packet.md`
7. `docs/hosted-web-phases/phase-01/lanes/p1-s2-routes.md`
8. `CLAUDE.md`
9. `AGENT_CRITICAL_GUARDRAILS.md`
10. `docs/FEATURE_ARCHITECTURE_STANDARD.md`
11. `docs/hosted-web-phases/PACKET_STANDARD.md`
12. `docs/hosted-web-phases/phase-01/execution-dag.md`
13. `docs/hosted-web-phases/phase-01/architecture-and-contracts.md`
14. `docs/hosted-web-phases/phase-01/conformance-and-tests.md`
15. `docs/research/hosted-web/phase-1/bootstrap/ownership-manifest.json`
16. `.codex-handoff/phase-01-p1-s1-schema-version-remediation.json`
17. `src/shared/contracts/hosted/app-error.ts`
18. `src/shared/contracts/hosted/identifiers.ts`
19. `src/shared/contracts/hosted/index.ts`
20. `src/shared/contracts/hosted/query-context.ts`
21. `src/shared/contracts/hosted/revision.ts`
22. `package.json`
23. `tsconfig.json`
24. `vitest.config.ts`

There are no pre-existing mandatory scripts or fixtures. The lane creates only its owned scripts/tests
listed below and may not recursively read preserved research.

## Exact writable paths

- `.codex-handoff/phase-01-p1-1b.json`
- `src/main/composition/hosted/routing/RouteCatalog.ts`
- `src/main/composition/hosted/routing/index.ts`
- `src/main/composition/hosted/routing/route-types.ts`
- `test/architecture/hosted-web/phase-1/routes/RouteCatalog.test.ts`
- `test/architecture/hosted-web/phase-1/routes/capability-descriptors.test.ts`
- `test/architecture/hosted-web/phase-1/routes/fixtures/duplicate-route.ts`
- `test/architecture/hosted-web/phase-1/routes/fixtures/missing-reference.ts`
- `test/architecture/hosted-web/phase-1/routes/fixtures/test-only-production-route.ts`

Everything else is read-only, including P1.1C paths, existing P1.1A contracts/tests/handoffs,
package/lock/config files, docs, research, production IPC/HTTP/preload/renderer registration, legacy
APIs, and the future P1.R1 evidence path. A needed extra path is a stop condition.

## Acceptance and negative controls

1. Route IDs and method/path pairs are unique; every descriptor requires stable owner, trust kind,
   auth-policy, readiness, schema, handler, client, and semantic-test references.
2. RouteCatalog is a frozen assertion collection over immutable descriptors, not a mutable cache,
   runtime manifest, dispatcher, router framework, or source of feature business rules.
3. Capability/action IDs remain separate and feature-owned. Fixture route presence never implies
   production support or dynamic resource allowance.
4. `P1.NEG.ROUTE_DRIFT` deliberately duplicates a route/method/path and removes a required reference;
   the focused test fails it with exactly `phase1-route-catalog-drift` while the adjacent valid
   descriptors pass.
5. `P1.NEG.CAPABILITY_MOUNT` sets production support or mounts a `testOnly` route; the focused test
   fails it with exactly `phase1-test-capability-production-mount` while the adjacent capability
   descriptors pass.
6. No production route, channel, client, handler, policy, schema, feature contract, or registration is
   created or modified. No path, secret, auth/provider payload, or real-project data enters fixtures or
   handoff evidence.
7. Both evidence IDs reach `target_verified`, or the handoff records the narrower truthful proof level
   and leaves the unmet claim unverified.

## Required checks

Run and record exact commands, exit codes, and tool versions:

```bash
pnpm exec vitest run test/architecture/hosted-web/phase-1/routes/RouteCatalog.test.ts
pnpm exec vitest run test/architecture/hosted-web/phase-1/routes/capability-descriptors.test.ts
pnpm exec vitest run test/architecture/hosted-web/phase-1/routes
pnpm lint:fast:files -- src/main/composition/hosted/routing/RouteCatalog.ts src/main/composition/hosted/routing/index.ts src/main/composition/hosted/routing/route-types.ts test/architecture/hosted-web/phase-1/routes/RouteCatalog.test.ts test/architecture/hosted-web/phase-1/routes/capability-descriptors.test.ts test/architecture/hosted-web/phase-1/routes/fixtures/duplicate-route.ts test/architecture/hosted-web/phase-1/routes/fixtures/missing-reference.ts test/architecture/hosted-web/phase-1/routes/fixtures/test-only-production-route.ts
pnpm typecheck
pnpm exec prettier --check .codex-handoff/phase-01-p1-1b.json src/main/composition/hosted/routing/RouteCatalog.ts src/main/composition/hosted/routing/index.ts src/main/composition/hosted/routing/route-types.ts test/architecture/hosted-web/phase-1/routes/RouteCatalog.test.ts test/architecture/hosted-web/phase-1/routes/capability-descriptors.test.ts test/architecture/hosted-web/phase-1/routes/fixtures/duplicate-route.ts test/architecture/hosted-web/phase-1/routes/fixtures/missing-reference.ts test/architecture/hosted-web/phase-1/routes/fixtures/test-only-production-route.ts
git diff --check
git status --short
```

Also prove that the changed/untracked set is exactly the nine writable paths, every non-owned path
matches `phaseStartSha`, and the integrated router start differs from the canonical base only on its
eight contract-owned docs paths. Scan all changed and untracked files, including the handoff, for
credentials, secrets, auth/provider payloads, private, home, or real-project paths, raw command/runtime
bodies, and binary files; record reviewed matches, not merely a tracked-only zero-match search.

## Stop conditions

Stop and return the standard blocker record on a stale base, router, packet, phase start, or controller
with `live!=true`; pre-integration work; duplicate/prior packet use; path overlap; changed predecessor
or accepted evidence; a need for any extra path or dependency; inability to keep route and capability
sources separate; a missing deliberate negative or exact diagnostic; mutable/runtime catalog behavior;
production exposure; filesystem/path-taking work; secret/private-path evidence; unclassified owned-path
failure; or any attempt to start P1.S3+. Do not retry, refill, repair the sibling, or widen scope.

## Handoff

Write `.codex-handoff/phase-01-p1-1b.json` using `PACKET_STANDARD.md`. Include base, exact integrated
router `phaseStartSha`/plan bundle, packet revision, both evidence IDs and proof levels, exact changed
paths, all commands/exit codes/tool versions, deliberate negative results and diagnostics, unverified
claims, blockers, and the binary patch SHA-256 plus per-file SHA-256 values.

The only safe next action is to wait for the independent P1.1C handoff and a separately authorized
P1.R1 router decision. Do not request or start P1.R1, P1.1D, integration, or production work.
