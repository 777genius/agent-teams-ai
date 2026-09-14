# P1.R1 routes and ratchets formal review lane

## Authority and provenance

- Phase/node: `phase-01` / `P1.R1`
- Packet revision: `phase-01-p1-r1-review-r1`
- Canonical base: `6a9e9ab714359638fb93a6880855a53c9e8ef4be`
- Canonical tree: `22020029327465ed389cd4479db340082ae81601`
- Accepted producer commits: routes `74038b54eee23e93798b3aa5d11411d3f7e9adcf`; conformance
  `6a9e9ab714359638fb93a6880855a53c9e8ef4be`
- Admission input: `02a6b3ac5ac2baaad55c413f8547252dddee4d41`, tree-identical to canonical
- Admission reviewer: `agent-teams-hosted-web-refactor-p1-s2-admission-review-v15-r2`, disposition
  `ACCEPT`
- Evidence under review: `P1.1B.ROUTES`, `P1.1B.CAPABILITIES`, `P1.1C.CONFORMANCE`,
  `P1.1C.RATCHETS`
- Result path: `docs/research/hosted-web/phase-1/reviews/routes-ratchets.md`
- Result states: `ACCEPT | REJECT`

This is one formal review, not another admission pass. It becomes executable only after the exact
seven-path router commit containing it is integrated and its successor controller reports
`live=true`. It does not launch a worker, revise accepted bytes, integrate its output, or authorize a
successor.

## Independence gate

The assigned reviewer identity, controller job, and source worktree must be different from:

1. the P1.1B producer responsible for `74038b54eee23e93798b3aa5d11411d3f7e9adcf`;
2. the P1.1C producer responsible for `6a9e9ab714359638fb93a6880855a53c9e8ef4be`; and
3. admission reviewer `agent-teams-hosted-web-refactor-p1-s2-admission-review-v15-r2`.

The reviewer must record all three exclusions and its own runtime identity, controller job, and
worktree in the result. Failure to prove independence is `REJECT`; substitution or reassignment is not
authorized by this packet.

## Mission

Review the exact canonical P1.S2 tree independently and return one formal disposition. Confirm that
RouteCatalog assertions and capability descriptors remain separate and non-production; that the
semantic harness, synthetic corpus, dependency/parity/renderer scanners, and ratchets enforce the
frozen architecture without implementing P1.1D; and that every handoff claim, negative diagnostic,
path count, hash, and inherited failure is truthful and mutually consistent.

Do not repair a finding. Do not modify product, tests, scripts, fixtures, handoffs, router docs, or
existing research evidence. Do not add research, run a real project, or infer production readiness.

## Exact mandatory reads

Read in this order; directory reads, globs, implicit siblings, and recursive research reads are not
authorized:

1. `AGENTS.md`
2. `docs/hosted-web-phases/START_HERE.md`
3. `docs/hosted-web-phases/EVIDENCE_LIFECYCLE.md`
4. `docs/hosted-web-phases/README.md`
5. `docs/hosted-web-phases/EXECUTION_INDEX.json`
6. `docs/hosted-web-phases/phase-01/controller-packet.md`
7. `docs/hosted-web-phases/phase-01/lanes/p1-r1-review.md`
8. `CLAUDE.md`
9. `AGENT_CRITICAL_GUARDRAILS.md`
10. `docs/FEATURE_ARCHITECTURE_STANDARD.md`
11. `docs/hosted-web-phases/PACKET_STANDARD.md`
12. `docs/hosted-web-phases/phase-01/execution-dag.md`
13. the exact 37 canonical input paths listed below, in listed order

No other research path is a mandatory read. The result path is new output, not input.

## Exact 37-path canonical review input

P1.1B contributes exactly these 9 paths:

1. `.codex-handoff/phase-01-p1-1b.json`
2. `src/main/composition/hosted/routing/RouteCatalog.ts`
3. `src/main/composition/hosted/routing/index.ts`
4. `src/main/composition/hosted/routing/route-types.ts`
5. `test/architecture/hosted-web/phase-1/routes/RouteCatalog.test.ts`
6. `test/architecture/hosted-web/phase-1/routes/capability-descriptors.test.ts`
7. `test/architecture/hosted-web/phase-1/routes/fixtures/duplicate-route.ts`
8. `test/architecture/hosted-web/phase-1/routes/fixtures/missing-reference.ts`
9. `test/architecture/hosted-web/phase-1/routes/fixtures/test-only-production-route.ts`

P1.1C contributes exactly these 28 paths:

1. `.codex-handoff/phase-01-p1-1c.json`
2. `scripts/hosted-web/phase-1/check-feature-dependencies.ts`
3. `scripts/hosted-web/phase-1/check-parity-references.ts`
4. `scripts/hosted-web/phase-1/check-renderer-boundaries.ts`
5. `test/architecture/hosted-web/phase-1/conformance/semantic-harness.test.ts`
6. `test/architecture/hosted-web/phase-1/conformance/semantic-harness.ts`
7. `test/architecture/hosted-web/phase-1/dependencies/feature-dependencies.test.ts`
8. `test/architecture/hosted-web/phase-1/fixtures/core-side-effect.ts`
9. `test/architecture/hosted-web/phase-1/fixtures/filesystem-adapter.ts`
10. `test/architecture/hosted-web/phase-1/fixtures/forbidden-core-import.ts`
11. `test/architecture/hosted-web/phase-1/fixtures/hosted-electron-api.ts`
12. `test/architecture/hosted-web/phase-1/fixtures/legacy-god-dto.ts`
13. `test/architecture/hosted-web/phase-1/fixtures/path-secret-leak.ts`
14. `test/architecture/hosted-web/phase-1/fixtures/production-adapter-mount.ts`
15. `test/architecture/hosted-web/phase-1/fixtures/ratchet-regression.ts`
16. `test/architecture/hosted-web/phase-1/parity/parity-references.test.ts`
17. `test/architecture/hosted-web/phase-1/renderer-boundaries/renderer-boundaries.test.ts`
18. `test/fixtures/hosted-web/phase-1/team-lifecycle/manifest.json`
19. `test/fixtures/hosted-web/phase-1/team-lifecycle/outcomes/corrupt.json`
20. `test/fixtures/hosted-web/phase-1/team-lifecycle/outcomes/draft.json`
21. `test/fixtures/hosted-web/phase-1/team-lifecycle/outcomes/empty.json`
22. `test/fixtures/hosted-web/phase-1/team-lifecycle/outcomes/not-found-inapplicable.json`
23. `test/fixtures/hosted-web/phase-1/team-lifecycle/outcomes/partial.json`
24. `test/fixtures/hosted-web/phase-1/team-lifecycle/outcomes/provisioning-inapplicable.json`
25. `test/fixtures/hosted-web/phase-1/team-lifecycle/outcomes/stale.json`
26. `test/fixtures/hosted-web/phase-1/team-lifecycle/outcomes/success.json`
27. `test/fixtures/hosted-web/phase-1/team-lifecycle/outcomes/unavailable.json`
28. `test/fixtures/hosted-web/phase-1/team-lifecycle/outcomes/unexpected.json`

The sets must be disjoint, complete, and unchanged at canonical P1.S2. A 36th/38th path, overlap,
missing input, or content drift is `REJECT`.

## Exact exclusive writer authority

The reviewer owns exactly one path:

- `docs/research/hosted-web/phase-1/reviews/routes-ratchets.md`

Everything else is read-only. The reviewer may create parent directories needed for that one file but
may not place any other file in them. Any other changed or untracked path is `REJECT` and a stop
condition, not permission to clean or repair it.

## Architecture gate

Review the 37 inputs against `docs/FEATURE_ARCHITECTURE_STANDARD.md` and require all of the following:

1. RouteCatalog is a frozen assertion collection over immutable descriptors. It is not a dispatcher,
   mutable cache, production route registry, generated client input, or source of business rules.
2. Capability/action assertions remain separate and feature-owned. `testOnly` routes cannot establish
   or advertise production support.
3. The semantic harness and team-lifecycle corpus are deterministic, in-memory, path-free, and
   transport-neutral. They do not implement the P1.1D list use case.
4. The dependency, parity, and renderer scanners remain test tooling, are content-sensitive where
   frozen, and are not imported or mounted by production code.
5. No product IPC/HTTP/preload/renderer registration, filesystem adapter, dependency/config change,
   legacy god DTO, secret/path-bearing contract, real-project access, or Phase 1 completion claim is
   introduced.
6. The two P1.1D-owned positive neighbors and future P1.1D semantics remain absent and explicitly
   unverified; their absence is not a P1.S2 defect.

Run the two exact aggregate architecture commands and require the frozen counts:

```bash
pnpm exec vitest run test/architecture/hosted-web/phase-1/routes
pnpm exec vitest run test/architecture/hosted-web/phase-1/conformance test/architecture/hosted-web/phase-1/dependencies test/architecture/hosted-web/phase-1/parity test/architecture/hosted-web/phase-1/renderer-boundaries
```

The first must pass 2 files and 16/16 tests; the second must pass 4 files and 13/13 tests.

## Exact scope and provenance gate

Run and record these commands with expanded runtime-bound `phaseStartSha` where shown:

```bash
git merge-base --is-ancestor a0dc964e9a71b782b1bbad4769db62a691e50c97 74038b54eee23e93798b3aa5d11411d3f7e9adcf
git merge-base --is-ancestor 74038b54eee23e93798b3aa5d11411d3f7e9adcf 6a9e9ab714359638fb93a6880855a53c9e8ef4be
git diff --name-only a0dc964e9a71b782b1bbad4769db62a691e50c97..74038b54eee23e93798b3aa5d11411d3f7e9adcf
git diff --name-only 74038b54eee23e93798b3aa5d11411d3f7e9adcf..6a9e9ab714359638fb93a6880855a53c9e8ef4be
git diff --name-only a0dc964e9a71b782b1bbad4769db62a691e50c97..6a9e9ab714359638fb93a6880855a53c9e8ef4be
git diff --exit-code 02a6b3ac5ac2baaad55c413f8547252dddee4d41..6a9e9ab714359638fb93a6880855a53c9e8ef4be
git rev-parse 02a6b3ac5ac2baaad55c413f8547252dddee4d41^{tree}
git rev-parse 6a9e9ab714359638fb93a6880855a53c9e8ef4be^{tree}
git diff --name-only 6a9e9ab714359638fb93a6880855a53c9e8ef4be..<phaseStartSha-from-worker-start-v1>
git diff --exit-code <phaseStartSha-from-worker-start-v1> -- . ':(exclude)docs/research/hosted-web/phase-1/reviews/routes-ratchets.md'
git status --short
```

Require 9 route paths, 28 conformance paths, exactly the listed 37-path union, no diff between admitted
and canonical input, tree `22020029327465ed389cd4479db340082ae81601` for both, exactly the seven
router paths between base and `phaseStartSha`, no non-owned worktree diff, and only the owned result in
status. Validate both handoff JSON files, every per-file SHA-256, both patch hashes, revisions, base,
plan bundle, evidence IDs, proof levels, commands, negative matrices, and unverified claims against
the canonical bytes. Any inconsistency is `REJECT`.

## Exact focused gates

Run all six commands independently and require the exact counts:

```bash
pnpm exec vitest run test/architecture/hosted-web/phase-1/routes/RouteCatalog.test.ts
pnpm exec vitest run test/architecture/hosted-web/phase-1/routes/capability-descriptors.test.ts
pnpm exec vitest run test/architecture/hosted-web/phase-1/dependencies/feature-dependencies.test.ts
pnpm exec vitest run test/architecture/hosted-web/phase-1/renderer-boundaries/renderer-boundaries.test.ts
pnpm exec vitest run test/architecture/hosted-web/phase-1/parity/parity-references.test.ts
pnpm exec vitest run test/architecture/hosted-web/phase-1/conformance/semantic-harness.test.ts
```

Required results are respectively 12/12, 4/4, 4/4, 3/3, 3/3, and 3/3 tests.

## Exact negative gate

The aggregate and focused commands must exercise and assert every frozen negative below. Inspect the
test and fixture pairs and record the exact diagnostic and positive-neighbor result in the review:

| Negative ID                           | Required diagnostic                       | Required neighbor disposition                                                       |
| ------------------------------------- | ----------------------------------------- | ----------------------------------------------------------------------------------- |
| `P1.NEG.ROUTE_DRIFT`                  | `phase1-route-catalog-drift`              | duplicate and missing-reference cases rejected; adjacent valid descriptors accepted |
| `P1.NEG.CAPABILITY_MOUNT`             | `phase1-test-capability-production-mount` | production-support and production-mount cases rejected; test catalog accepted       |
| `P1.NEG.CORE_SIDE_EFFECT`             | `phase1-core-side-effect-forbidden`       | verified                                                                            |
| `P1.NEG.HOSTED_ELECTRON_API`          | `phase1-hosted-electron-api-forbidden`    | verified                                                                            |
| `P1.NEG.IMPORT_FORBIDDEN`             | `phase1-core-import-forbidden`            | verified                                                                            |
| `P1.NEG.LEGACY_GOD_DTO`               | `phase1-legacy-god-dto-forbidden`         | fixture/scanner half verified; P1.1D neighbor unverified                            |
| `P1.NEG.NO_FILESYSTEM_ADAPTER_PHASE1` | `phase1-filesystem-adapter-forbidden`     | fixture/scanner half verified; P1.1D neighbor unverified                            |
| `P1.NEG.PARITY_DRIFT`                 | `phase1-parity-reference-drift`           | verified                                                                            |
| `P1.NEG.PATH_SECRET_LEAK`             | `phase1-path-secret-leak`                 | verified                                                                            |
| `P1.NEG.PRODUCTION_ADAPTER_MOUNT`     | `phase1-test-adapter-production-import`   | verified on eight frozen production boundaries                                      |
| `P1.NEG.RATCHET_REGRESSION`           | `phase1-ratchet-regression`               | verified                                                                            |

Do not create or run the absent P1.1D positive-neighbor path. Do not claim `P1.NEG.SEMANTIC_OUTCOME`
or future feature conformance. Missing or changed diagnostics, false positive-neighbor claims, or a
negative that no longer rejects is `REJECT`.

## Exact quality and safety gates

Run and record the following exact commands. The lint list is every TypeScript input; the Prettier
list is all 37 canonical inputs.

```bash
pnpm lint:fast:files -- src/main/composition/hosted/routing/RouteCatalog.ts src/main/composition/hosted/routing/index.ts src/main/composition/hosted/routing/route-types.ts test/architecture/hosted-web/phase-1/routes/RouteCatalog.test.ts test/architecture/hosted-web/phase-1/routes/capability-descriptors.test.ts test/architecture/hosted-web/phase-1/routes/fixtures/duplicate-route.ts test/architecture/hosted-web/phase-1/routes/fixtures/missing-reference.ts test/architecture/hosted-web/phase-1/routes/fixtures/test-only-production-route.ts scripts/hosted-web/phase-1/check-feature-dependencies.ts scripts/hosted-web/phase-1/check-parity-references.ts scripts/hosted-web/phase-1/check-renderer-boundaries.ts test/architecture/hosted-web/phase-1/conformance/semantic-harness.test.ts test/architecture/hosted-web/phase-1/conformance/semantic-harness.ts test/architecture/hosted-web/phase-1/dependencies/feature-dependencies.test.ts test/architecture/hosted-web/phase-1/fixtures/core-side-effect.ts test/architecture/hosted-web/phase-1/fixtures/filesystem-adapter.ts test/architecture/hosted-web/phase-1/fixtures/forbidden-core-import.ts test/architecture/hosted-web/phase-1/fixtures/hosted-electron-api.ts test/architecture/hosted-web/phase-1/fixtures/legacy-god-dto.ts test/architecture/hosted-web/phase-1/fixtures/path-secret-leak.ts test/architecture/hosted-web/phase-1/fixtures/production-adapter-mount.ts test/architecture/hosted-web/phase-1/fixtures/ratchet-regression.ts test/architecture/hosted-web/phase-1/parity/parity-references.test.ts test/architecture/hosted-web/phase-1/renderer-boundaries/renderer-boundaries.test.ts
pnpm typecheck
pnpm exec prettier --check .codex-handoff/phase-01-p1-1b.json src/main/composition/hosted/routing/RouteCatalog.ts src/main/composition/hosted/routing/index.ts src/main/composition/hosted/routing/route-types.ts test/architecture/hosted-web/phase-1/routes/RouteCatalog.test.ts test/architecture/hosted-web/phase-1/routes/capability-descriptors.test.ts test/architecture/hosted-web/phase-1/routes/fixtures/duplicate-route.ts test/architecture/hosted-web/phase-1/routes/fixtures/missing-reference.ts test/architecture/hosted-web/phase-1/routes/fixtures/test-only-production-route.ts .codex-handoff/phase-01-p1-1c.json scripts/hosted-web/phase-1/check-feature-dependencies.ts scripts/hosted-web/phase-1/check-parity-references.ts scripts/hosted-web/phase-1/check-renderer-boundaries.ts test/architecture/hosted-web/phase-1/conformance/semantic-harness.test.ts test/architecture/hosted-web/phase-1/conformance/semantic-harness.ts test/architecture/hosted-web/phase-1/dependencies/feature-dependencies.test.ts test/architecture/hosted-web/phase-1/fixtures/core-side-effect.ts test/architecture/hosted-web/phase-1/fixtures/filesystem-adapter.ts test/architecture/hosted-web/phase-1/fixtures/forbidden-core-import.ts test/architecture/hosted-web/phase-1/fixtures/hosted-electron-api.ts test/architecture/hosted-web/phase-1/fixtures/legacy-god-dto.ts test/architecture/hosted-web/phase-1/fixtures/path-secret-leak.ts test/architecture/hosted-web/phase-1/fixtures/production-adapter-mount.ts test/architecture/hosted-web/phase-1/fixtures/ratchet-regression.ts test/architecture/hosted-web/phase-1/parity/parity-references.test.ts test/architecture/hosted-web/phase-1/renderer-boundaries/renderer-boundaries.test.ts test/fixtures/hosted-web/phase-1/team-lifecycle/manifest.json test/fixtures/hosted-web/phase-1/team-lifecycle/outcomes/corrupt.json test/fixtures/hosted-web/phase-1/team-lifecycle/outcomes/draft.json test/fixtures/hosted-web/phase-1/team-lifecycle/outcomes/empty.json test/fixtures/hosted-web/phase-1/team-lifecycle/outcomes/not-found-inapplicable.json test/fixtures/hosted-web/phase-1/team-lifecycle/outcomes/partial.json test/fixtures/hosted-web/phase-1/team-lifecycle/outcomes/provisioning-inapplicable.json test/fixtures/hosted-web/phase-1/team-lifecycle/outcomes/stale.json test/fixtures/hosted-web/phase-1/team-lifecycle/outcomes/success.json test/fixtures/hosted-web/phase-1/team-lifecycle/outcomes/unavailable.json test/fixtures/hosted-web/phase-1/team-lifecycle/outcomes/unexpected.json
git diff --check
```

Lint, Prettier, and diff must be green. `pnpm typecheck` may exit 1 only for exactly the unchanged seven
inherited Phase 0 diagnostics in these three files and with no P1.S2-owned diagnostic:

- `test/architecture/hosted-web/phase-0/auth-artifacts/auth-artifacts-spike.test.ts`
- `test/architecture/hosted-web/phase-0/host-primitives/evidence-scanner.test.ts`
- `test/architecture/hosted-web/phase-0/provider-runtime/scan-runtime-surfaces.test.ts`

Scan every one of the 37 canonical inputs and the owned result for credentials, secrets, auth/provider
payloads, private/home/real-project paths, raw command/runtime bodies, and binary content. Record the
exact command, exit code, and manual classification of every lexical match. A leaked value, private
path, binary, new typecheck diagnostic, or changed inherited diagnostic is `REJECT`.

## Disposition rule and result contract

Return `ACCEPT` only if independence is proven and every architecture, provenance, 37-path scope,
handoff/hash, aggregate, focused, negative, quality, safety, and ownership requirement passes exactly.
Any failure is `REJECT`; there is no conditional acceptance and no repair authority.

Write only `docs/research/hosted-web/phase-1/reviews/routes-ratchets.md`. It must contain:

1. `Disposition: ACCEPT` or `Disposition: REJECT` as the single formal result;
2. reviewer identity/job/worktree and the three independence exclusions;
3. canonical, producer, admission, tree, router `phaseStartSha`, and packet-revision provenance;
4. exact 9 + 28 = 37 scope accounting and tree-equivalence proof;
5. every command, exit code, observed test count, and typecheck diagnostic classification;
6. the complete 11-ID negative matrix and positive-neighbor dispositions;
7. handoff, patch/hash, architecture, safety, and ownership findings;
8. all P0/P1/P2 findings or an explicit zero count for each; and
9. an explicit statement that P1.1D, P1.R2, integration/P1.I, P1.F, and Phase 2+ remain blocked
   pending formal `ACCEPT` integration and a later router.

The only safe next action is to return the result to the controller for a later router decision. Do
not integrate or push it, launch a successor, start P1.1D, or expand research.
