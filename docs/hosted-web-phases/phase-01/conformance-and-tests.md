# Proposed conformance and architecture gates

Status: blocked proposal. IDs, fixtures, commands, and thresholds are proposed until serial bootstrap.

## One semantic vector, three transports

The harness constructs one `ListTeamLifecycleSummaries` use case around a deterministic in-memory
reader and clock. It calls it directly, through an IPC-shaped adapter with a fake invoke
event/principal binder, and through Fastify injection with a fake authenticated session binder. Both
transport-shaped adapters, their identifiers, and their composition live under
`test/features/team-lifecycle/conformance/`; production code cannot import the test tree. There is no
IPC registration, preload/global exposure, renderer client, HTTP registration, or production
composition change. The harness compares normalized application outcomes, not byte-identical
transport envelopes.

| Obligation                    | Direct/test                     | IPC                         | HTTP                                   |
| ----------------------------- | ------------------------------- | --------------------------- | -------------------------------------- |
| query defaults/validation     | normalized query                | wire parser then same query | query parser then same query           |
| actor/scope/deadline/cancel   | fixed `QueryContext`            | derived local principal     | derived test browser session           |
| success page/revisions/cursor | exact semantic page             | typed IPC success           | `200` decoded page                     |
| invalid cursor/schema         | `invalid_request`/`unsupported` | typed safe failure          | `400`/`422` safe envelope              |
| unauthenticated/forbidden     | policy outcome                  | admission/typed failure     | `401`/`403`, use-case spy count zero   |
| unavailable/internal          | safe application outcome        | typed retry/internal        | `503`/`500`, redacted diagnostic       |
| cancellation                  | cancelled outcome               | cancelled result            | aborted injection/no post-cancel write |

Conformance fails on changed item order, missing revision, fabricated empty success, raw error message,
different retryability, use-case invocation after admission denial, or transport objects reaching core.

## Complete audited outcome oracle

The normalized oracle is either
`{ kind: 'success', page, warnings: [] }` or
`{ kind: 'failure', code, reason, retryable, diagnosticPresent }`. Phase 1 permits no success
warnings, no partial item page, and no adapter metadata beyond the allowlisted transport status,
request-correlation presence, and admission-before-use-case count. All three paths must produce the
same normalized value and ordered items; adapters invoke the use case exactly once after successful
admission and zero times after denied admission.

Every state named by the independent audit is classified below. “Not applicable” is an asserted
semantic decision with a negative fixture and a later owner, not an omitted vector.

| Audited state | Phase 1 applicability                       | Normalized oracle / assertion                                                                                                                    | Carry-forward owner               |
| ------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------- |
| success       | Applicable                                  | Non-empty page, exact `schemaVersion`, snapshot/item revisions, deterministic order, opaque cursor, and empty warnings.                          | Phase 1                           |
| empty         | Applicable                                  | Successful empty page with snapshot revision, `nextCursor: null`, and empty warnings; never fabricated from a failure.                           | Phase 1                           |
| not-found     | Not applicable                              | A collection list has no requested resource whose absence can be `not_found`; a fixture injecting that result must fail as an unhandled outcome. | Phase 2 first point/resource read |
| draft         | Applicable as data, not a top-level outcome | A draft item remains an ordered item with lifecycle `draft`; it cannot become empty, not-found, or a warning.                                    | Phase 1                           |
| provisioning  | Not applicable                              | The specimen contract has no provisioning workflow/state and must reject an unknown `provisioning` lifecycle rather than coerce it.              | Phase 2 real lifecycle projection |
| corrupt       | Applicable as failure                       | `internal/corrupt_source`, no items or raw parser/path detail, non-retryable, diagnostic present; identical safe mapping through all adapters.   | Phase 1                           |
| partial       | Applicable as rejected partial read         | `unavailable/partial_source`, retryable only when the reader marks retry safe, no partial items, and no warning-only success.                    | Phase 1                           |
| unavailable   | Applicable                                  | `unavailable/source_unavailable` with bounded retry hint; never `[]`.                                                                            | Phase 1                           |
| stale         | Applicable                                  | Foreign/expired cursor is `invalid_request/invalid_cursor`; changed snapshot is `conflict/snapshot_changed`; neither restarts pagination.        | Phase 1                           |
| unexpected    | Applicable                                  | `internal/unexpected`, redacted diagnostic present, no raw message/stack/path, non-retryable.                                                    | Phase 1                           |

Ordering is normalized display name followed by opaque ID, byte-for-byte stable within the snapshot.
The warning allowlist is empty for this specimen. Resource and snapshot revisions remain explicit and
equality-only. Adapter-only metadata is compared separately and may not alter the oracle. The fixture
manifest must contain one positive/applicable vector or one fail-closed non-applicability vector for
every row.

## Route, capability, and parity assertions

- Route IDs and method/path pairs are unique; referenced handler, schema, auth policy, trust kind,
  readiness dimension, owner, and test metadata exist.
- Browser routes may reference browser capabilities; runtime/private/health routes may not become
  browser facets.
- Capability/action IDs are unique and feature-owned. Supported means an implemented semantic path,
  not a throwing/no-op stub. Resource allowance remains a separate future projection.
- Browser client constants and parsers reference the feature contract route/schema IDs. No handwritten
  alternate path string is allowed in the migrated proof.
- ADR-19 records retain pinned legacy signature hashes and independently reference owner, disposition,
  action, route/channel, public feature entrypoint, and semantic test. Missing or stale references fail.
- Direct, decomposed, and desktop-only negative fixtures prove each mapping class. The ledger is never
  imported by production runtime or used to generate a mega client.

## Negative architecture gates

Each gate includes one passing fixture and one deliberately failing fixture with an exact diagnostic:

1. Core/contracts cannot import Electron, Fastify, React, Zustand, Node built-ins, `@main`, renderer,
   preload, or infrastructure paths.
2. External feature code imports only documented team-lifecycle root/layer entrypoints; deep imports
   and cycles fail.
3. Hosted composition cannot import an unrestricted `@main/application/hosted` facade or business
   service locator.
4. Migrated renderer code cannot reach `window.electronAPI`, global `ElectronAPI`, generic HTTP client,
   or transport singleton; only the narrow `teamRead` facet is legal.
5. The hosted renderer import graph cannot reach desktop-only modules, and listener registration is
   inventoried with cleanup ownership.
6. No hosted facet is structurally assignable to `ElectronAPI`; no all-parity DTO/interface or
   `TeamsAPI` implementation may be added.
7. Unsupported UI controls are absent/disabled with a safe reason before interaction; a throwing or
   silent stub fails. Phase 1 supplies fixture components only, not product UI migration.
8. Production composition, IPC registration, preload/global API, renderer API, or HTTP registration
   importing either test-only transport adapter/composition fails with
   `phase1-test-adapter-production-import`; the positive production graph contains neither identifier.
9. Route-level filesystem checks, cache invalidation, runtime overlays, authorization decisions, or
   pagination logic in input adapters fail source assertions.
10. Manual error-string matching (`IpcError`, raw `.message`) in the new slice fails; the untouched
    legacy surface remains a counted ratchet baseline.
11. Any Phase 1 port or adapter taking a path/root, importing filesystem/path APIs, using ambient root
    lookup, watchers, repair, or cleanup fails with `phase1-filesystem-adapter-forbidden`.

## Named negative-control inventory

Serial bootstrap must freeze exact paths, mutations, positive neighbors, stable diagnostics, owners,
and commands for every row. A category label without a deliberate failing mutation is not evidence.

| Fixture ID                            | Phase 1 disposition                                                                                                                                                                              |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `P1.NEG.IMPORT_FORBIDDEN`             | Required: forbidden core/framework/import fixture.                                                                                                                                               |
| `P1.NEG.HOSTED_ELECTRON_API`          | Required: hosted facet structural alias/implementation fails.                                                                                                                                    |
| `P1.NEG.LEGACY_GOD_DTO`               | Required: legacy aggregate, raw name, and path fields fail.                                                                                                                                      |
| `P1.NEG.ROUTE_DRIFT`                  | Required: duplicate/missing ID and schema/handler/policy/test drift fail.                                                                                                                        |
| `P1.NEG.PARITY_DRIFT`                 | Required: legacy signature and cross-reference omission fail.                                                                                                                                    |
| `P1.NEG.SEMANTIC_OUTCOME`             | Required: every applicable and non-applicable row above is mutation-tested.                                                                                                                      |
| `P1.NEG.CORE_SIDE_EFFECT`             | Required: watcher, repair, process, notification, runtime overlay, and transport logger reachability fail.                                                                                       |
| `P1.NEG.SCHEMA_VERSION`               | Required: malformed/missing/future/incompatible version and unknown-field rules fail safely.                                                                                                     |
| `P1.NEG.ID_REVISION_CURSOR`           | Required: cross-kind/raw/stale/foreign/mismatched values fail.                                                                                                                                   |
| `P1.NEG.CAPABILITY_MOUNT`             | Required: production support remains absent and unsupported listeners/controls fail.                                                                                                             |
| `P1.NEG.RATCHET_REGRESSION`           | Required: path/symbol debt increase or expired quarantine fails.                                                                                                                                 |
| `P1.NEG.PRODUCTION_ADAPTER_MOUNT`     | Required: production import or mount of IPC-shaped or HTTP-shaped adapters fails.                                                                                                                |
| `P1.NEG.NO_FILESYSTEM_ADAPTER_PHASE1` | Required: any path-taking or filesystem-backed reader/adapter fails before execution.                                                                                                            |
| `P1.NEG.TEST_ROOT_ESCAPE`             | Explicitly deferred to Phase 2's first filesystem adapter; marked-root admission and cleanup controls are mandatory there. Deferral is valid only while the preceding no-filesystem gate passes. |
| `P1.NEG.PATH_SECRET_LEAK`             | Required: raw host paths, auth/provider payloads, command bodies, and canaries fail.                                                                                                             |
| `P1.NEG.PERFORMANCE_DEGRADATION`      | Required: limits, duplicate calls, ignored cancellation, cache/revision, fallback/source, or telemetry loss fail.                                                                                |

## Ratchet semantics

Serial bootstrap records counts and hashes for current TeamsAPI members, renderer callers/bypasses,
direct Electron accesses, global listeners, HTTP route strings, and forbidden-import exceptions.
Integration permits counts only to decrease, or to change through an exact reviewed replacement row.
New exceptions require owner, reason, removal phase, source span, and packet revision. A file rename
cannot evade the content-based scan. Existing debt outside the first slice is quarantined, not declared
fixed.

## Proposed checks

Bootstrap must resolve commands against current scripts before freezing them. Candidate commands:

```bash
pnpm exec vitest run test/features/team-lifecycle test/architecture/hosted-web/phase-1
pnpm lint:fast:files -- <exact changed TypeScript files>
pnpm typecheck
pnpm exec prettier --check docs/hosted-web-phases/phase-01 .codex-handoff/<phase-01-handoff>.json
git diff --check
git status --short
```

Additional deterministic scanners must run parity-reference, renderer-boundary, feature-dependency,
production adapter import/mount, Phase 1 no-filesystem-adapter, secret, and absolute-path checks. The
integration report records commands, exit
codes, versions, elapsed time, exact base/result SHA, inherited failures, and fixture hashes. Full
`pnpm lint` is an integration gate when architecture-sensitive configs change; `lint:fast` alone never
replaces typecheck or the full required gate.

## Secret and path scan policy

Scan changed and untracked files for private keys, bearer/cookie/token values, provider auth payloads,
home directories, `/Users/`, non-fixture `/home/`, Windows user roots, task-local `/tmp` paths, real
project names, and raw command/runtime bodies. Allowed examples are fixed placeholders documented in
the fixture manifest. Any match is reviewed; a zero-match grep alone is not proof if binary/untracked
files were excluded.

## Performance and determinism gates

- Bound `limit` to 200 and cursor/token sizes to bootstrap-approved byte maxima before repository work.
- Measure parser and adapter overhead separately from the reader on fixed 1, 50, and 200 item fixtures.
- Proposed acceptance: median direct parser plus use-case overhead under 5 ms for 200 items, transport
  adapter overhead under 10 ms locally, and no more than 10% regression against the frozen baseline;
  bootstrap must replace noisy limits with host-qualified evidence if needed.
- Response size is bounded and excludes legacy payload fields; the 200-item vector must remain below
  the bootstrap-recorded byte budget.
- Cursor parsing is constant-space and bounded-time; malformed input cannot trigger repeated decode or
  unbounded allocation.
- Tests use fixed time/IDs/order and run twice with identical normalized output. No wall-clock sleeps,
  filesystem/path API, ambient or temporary root, network, filesystem watcher, provider process, or
  shared cache is allowed.

## Dependency and cache policy

Phase 1 proposes no new package, code generator, decorator, reflection layer, OpenAPI dependency, or
lockfile edit. Use TypeScript, Fastify injection, Vitest, and existing lint tooling. A missing primitive
is implemented narrowly or triggers a reviewed packet revision; a producer cannot install it.

RouteCatalog is frozen at composition and not a mutable cache. Parser results are not globally cached.
If test/build caching is used, keys include predecessor SHA, packet revision, lockfile hash, Node/pnpm
versions, scanner source hashes, and fixture manifest hash. Evidence/handoffs are never restored from a
cache without rerunning integrity and negative controls. Display name, legacy team name, cursor, raw
path, or auth token is never an application cache key.
