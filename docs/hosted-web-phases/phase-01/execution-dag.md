# Proposed execution DAG, ownership, and integration

Status: blocked design. IDs, paths, owners, estimates, commands, and pairings are proposed until serial
bootstrap. They are planning precision, not present write authority.

## DAG

```text
P1.S0 serial bootstrap
  -> P1.1A contract kernel
      -> P1.1B route/catalog conventions ----+
      -> P1.1C conformance + ratchets --------+-> P1.R1 seam review
                                                -> P1.1D first read proof
                                                  -> P1.R2 semantic review
                                                    -> P1.I serialized integration
                                                      -> P1.F freeze
```

`1B` and `1C` may run in parallel only after `1A` is integrated. The required chain is exactly
`1B + 1C -> R1 -> 1D -> R2 -> I`: R1 acceptance is an admission dependency of 1D, and R2 acceptance
is an admission dependency of integration. `1D` consumes reviewed interfaces; it does not copy them.
Reviews write only review evidence. `P1.I` is the sole writer of shared existing files.

## Proposed lane registry

| Slot    | Mission                                                                                    | Depends on    | Proposed evidence                      | Unique estimate bucket |
| ------- | ------------------------------------------------------------------------------------------ | ------------- | -------------------------------------- | ---------------------- |
| `P1.S0` | Resolve/freeze all proposal tokens and baseline fingerprints.                              | Ready gates   | `P1.S0.BOOTSTRAP`, `P1.S0.BASELINE`    | 120–220 lines          |
| `P1.1A` | Minimal kernel, parsers, and import negatives.                                             | `S0`          | `P1.1A.KERNEL`, `P1.1A.VERSION`        | 180–300 lines          |
| `P1.1B` | RouteCatalog assertions and separate capability cross-reference.                           | `1A`          | `P1.1B.ROUTES`, `P1.1B.CAPABILITIES`   | 180–320 lines          |
| `P1.1C` | IPC/HTTP semantic harness plus ADR-19/20/dependency negatives.                             | `1A`          | `P1.1C.CONFORMANCE`, `P1.1C.RATCHETS`  | 240–420 lines          |
| `P1.1D` | List query, feature contracts/port, in-memory reader, isolated test IPC/HTTP adapters.     | accepted `R1` | `P1.1D.LIST_SLICE`, `P1.1D.TRANSPORTS` | 300–520 lines          |
| `P1.R1` | Review 1B architecture and 1C false-positive/negative behavior.                            | `1B`, `1C`    | `P1.R1.ARCH_REVIEW`                    | 60–110 lines           |
| `P1.R2` | Review 1D semantic/auth/error/cursor behavior and recheck 1A kernel size.                  | `1D`          | `P1.R2.SEMANTIC_REVIEW`                | 60–110 lines           |
| `P1.I`  | Adopt in order, perform shared ratchet wiring, gates, rollback proof, and evidence freeze. | accepted `R2` | `P1.I.INTEGRATION`, `P1.I.ROLLBACK`    | 100–220 lines          |

The 1,240–2,220 planning range is intentionally reconciled as unique buckets; serial bootstrap must
compare it with the parent 900–1,600 estimate and either narrow scope or record an approved variance.
Review/evidence lines are not silently excluded.

## Proposed exclusive paths

Each row is an all-or-nothing proposed writer set. Serial bootstrap must resolve globs into exact files
before a worker starts.

| Owner   | Proposed exclusive writable paths                                                                                                                                                                                                                       |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `P1.1A` | `src/shared/contracts/hosted/{identifiers,query-context,revision,app-error,index}.ts`; `test/architecture/hosted-web/phase-1/contracts/**`                                                                                                              |
| `P1.1B` | `src/main/composition/hosted/routing/{RouteCatalog,route-types,index}.ts`; `test/architecture/hosted-web/phase-1/routes/**`                                                                                                                             |
| `P1.1C` | `scripts/hosted-web/phase-1/{check-parity-references,check-renderer-boundaries,check-feature-dependencies}.ts`; `test/architecture/hosted-web/phase-1/{conformance,parity,renderer-boundaries,dependencies}/**`                                         |
| `P1.1D` | `src/features/team-lifecycle/index.ts`; `src/features/team-lifecycle/contracts/**`; `src/features/team-lifecycle/core/application/**`; `test/features/team-lifecycle/**` (including the only in-memory reader and IPC/HTTP-shaped adapters/composition) |
| `P1.R1` | `docs/research/hosted-web/phase-1/reviews/routes-ratchets.md`                                                                                                                                                                                           |
| `P1.R2` | `docs/research/hosted-web/phase-1/reviews/list-semantics.md`                                                                                                                                                                                            |
| `P1.I`  | only the shared-writer paths below plus `docs/research/hosted-web/phase-1/{decision-register,evidence-index,estimate-reconciliation,integration-report}.json`                                                                                           |

No producer may edit `package.json`, lockfiles, TypeScript configs, ESLint configs, legacy APIs, global
composition, or another lane's test directory.

## Proposed single shared-writer paths

Only `P1.I`, after accepted R2 evidence, may edit these existing/global files:

- `src/main/ipc/teams.ts`, `src/main/http/teams.ts`, `src/main/http/index.ts`,
  `src/main/services/infrastructure/HttpServer.ts`, `src/main/standalone.ts`,
  `src/preload/constants/ipcChannels.ts`, `src/preload/index.ts`, and
  `src/renderer/api/index.ts` are explicitly **read-only** in Phase 1. Their unchanged import/mount
  graph is positive evidence; no exception or “dormant” registration is allowed.
- `scripts/hosted-web/phase-0/parity-renderer/scan-api-and-actions.ts` and the adopted parity ledger only
  when bootstrap proves a generator-owned cross-reference is required;
- `package.json`, lint/TS configs, and lockfiles: read-only unless a new reviewed packet revision names
  the exact need and owner.

An overlap is `scope_overlap`, not permission for cooperative concurrent editing. Integration returns a
finding to the owning lane rather than repairing producer code in shared files.

## Sandbox and fixture topology

- `test/fixtures/hosted-web/phase-1/team-lifecycle/` is proposed as one integration-owned data-fixture
  root; producer tests may reference it read-only after bootstrap.
- Fixtures use synthetic UUID-like IDs, fixed clocks, deterministic revisions/cursors, fake
  principals, and in-memory records only. They contain no path/root field or filesystem helper.
- Positive vectors: empty page, single page, stable multi-page ordering, additive response field,
  cancellation, and equal application outcome through all adapters.
- Negative vectors: invalid/foreign/expired cursor, unknown request field, unsupported schema version,
  unauthenticated/forbidden admission, unavailable port, corrupt/partial/unexpected reader outcomes,
  duplicate route/action, missing handler/schema/policy/client/test reference, forbidden import,
  direct Electron/global access, production import/mount of either transport-shaped adapter, a hosted
  facet attempting to implement `ElectronAPI`, and any path-taking/filesystem-backed adapter.
- No fixture or Phase 1 command opens or creates a home/runtime/project root, real workspace, provider
  CLI, credential store, network listener, terminal, child process, user project, filesystem watcher,
  repair path, cleanup path, or mutable host-global cache.
- `P1.NEG.TEST_ROOT_ESCAPE` is deferred to Phase 2's first filesystem-backed adapter with marked-root,
  pre-access escape rejection, and marker-checked cleanup requirements. Phase 1 must pass
  `P1.NEG.NO_FILESYSTEM_ADAPTER_PHASE1`; otherwise the deferral is invalid and work stops.

## Review and integration order

1. Adopt `1A`; run its parser/import checks.
2. Complete `1B` and `1C` in parallel on disjoint paths.
3. `R1` reviews both together for catalog minimality, route/capability separation, omission
   sensitivity, deliberate failures, no-filesystem enforcement, and production adapter isolation.
4. Only after accepted `R1`, rebase/start `1D` on the reviewed interfaces.
5. `R2` independently compares every applicable/non-applicable semantic vector across
   direct/IPC-shaped/HTTP-shaped tests, reviews redaction/cursor behavior, and rechecks `1A` for unused
   abstractions.
6. Only after accepted `R2`, `P1.I` adopts in dependency order
   `1A -> (1B + 1C) -> R1 -> 1D -> R2`, performs shared ratchet/evidence wiring without transport
   registration, runs the full matrix, and either freezes or rejects. No squash may erase
   evidence-to-commit provenance.

Reviewers must be different from the producer for the reviewed evidence. A rejected finding names the
evidence ID, smallest reproducer, owner, and whether unaffected integration can continue.

## Capacity and recovery

Maximum active producer slots after bootstrap: two (`1B`, `1C`). `R1`, `1D`, `R2`, and `I`
then run serially in that order. A replacement worker resumes the same worktree and handoff after
validating base, packet revision, existing diff, and checks. Duplicate completion requires controller
supersession, never refill.
