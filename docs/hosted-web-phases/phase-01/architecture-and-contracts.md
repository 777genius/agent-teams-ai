# Proposed architecture and contracts

Status: design proposal only. Every identifier and path is proposed until serial bootstrap.

## Feature ownership

| Concern                                                                        | Proposed owner               | Explicitly not owned                                                                    |
| ------------------------------------------------------------------------------ | ---------------------------- | --------------------------------------------------------------------------------------- |
| Opaque ID/context/revision/error primitives                                    | tiny shared contract kernel  | feature DTOs, transport status, persistence, auth policy                                |
| Team summary schema/parser/query/read port                                     | `team-lifecycle`             | tasks, messages, runtime control, workspace authorization, raw provider/filesystem data |
| Feature route descriptor and browser-safe route constant                       | `team-lifecycle`             | global route registration or auth implementation                                        |
| Feature capability/action descriptor                                           | `team-lifecycle`             | runtime resource allowance and UI state                                                 |
| RouteCatalog collection/assertions                                             | hosted app composition       | feature business rules or generic request dispatch                                      |
| Semantic conformance harness, IPC/HTTP-shaped adapters, and ADR-19/20 ratchets | architecture-test tooling    | production adapters, preload/global APIs, registration, or canonical product state      |
| Global ratchet files                                                           | serialized integration owner | concurrent producer edits or any transport registration                                 |

Only folders required by the first slice are created. `team-lifecycle` does not absorb tasks,
messaging, approvals, review, runtime control, workspace registry, or console composition.

## Candidate small contract kernel

Proposed exports are branded string types plus constructors/parsers, not classes or a universal
envelope:

- `ActorId`, `SessionId`, `DeploymentId`, `BootId`, `RequestId`, and test-only fixture `TeamId`;
- `QueryContext` containing actor/session, deployment/boot, request, authorized scope,
  deadline/cancellation;
- opaque `Revision` and `Cursor` values;
- safe `AppErrorCode` categories: `invalid_request`, `unauthenticated`, `forbidden`, `not_found`,
  `conflict`, `unsupported`, `unavailable`, `cancelled`, and `internal`;
- `SafeAppError` with code, stable safe reason, optional diagnostic ID and bounded retry hint.

The kernel must not export `ApiResponse<T>`, `Repository<T>`, `PlatformAdapter`, a route descriptor, a
capability descriptor, feature error codes, HTTP status, IPC result types, or provider data. Adding a
sixth primitive family requires a usage in the accepted first slice and bootstrap review.

## Candidate first vertical slice

Proposed application query: `ListTeamLifecycleSummaries(query, context)`. It is a conformance
specimen, not a production-registered feature in Phase 1.

Proposed request:

```ts
type ListTeamLifecycleSummariesQuery = {
  limit: number; // integer, 1..200; defaulted by each input adapter to 50
  cursor?: Cursor;
};
```

Proposed immutable result:

```ts
type TeamLifecycleSummaryPage = {
  schemaVersion: 1;
  snapshotRevision: Revision;
  items: readonly TeamLifecycleSummary[];
  nextCursor: Cursor | null;
};

type TeamLifecycleSummary = {
  teamId: TeamId;
  displayName: string;
  lifecycle: 'draft' | 'ready' | 'running' | 'degraded' | 'stopped' | 'deleted';
  revision: Revision;
};
```

This is deliberately smaller than legacy `TeamSummary`: no `teamName`, project/host path, session ID,
member/task payload, provider status, launch diagnostics, or mutable entity escapes. Phase 1 uses only
synthetic test `TeamId` values. Phase 2 decides how canonical identities and legacy projections feed
the port.

Proposed consumer-owned port:

```ts
interface TeamLifecycleSummaryReader {
  listPage(input: {
    scope: AuthorizedScope;
    limit: number;
    cursor?: Cursor;
    signal: AbortSignal;
  }): Promise<TeamLifecycleSummaryReadResult>;
}
```

It is cohesive around one read consistency model. There is no generic repository, save/delete method,
filesystem object, Fastify request, Electron event, or transport error in the port.

## Version, revision, and cursor semantics

- `schemaVersion` is an integer major version. Same-version response parsers ignore additive unknown
  fields after validating known fields; they never preserve them into domain/application objects.
- Unsupported major versions and unknown enum members fail with `unsupported`/`schema_version` rather
  than fabricating empty data. Input objects reject unknown fields.
- Revisions are opaque server-issued tokens. Clients compare equality only and must not parse,
  increment, sort, or use display names as cache keys.
- Cursors are opaque, scope/query/snapshot-bound, integrity-checked adapter tokens. A cursor used by a
  different actor scope, query shape, boot, or expired snapshot returns `invalid_request` with safe
  reason `invalid_cursor`; it never falls back to page one.
- Page ordering is total and deterministic within `snapshotRevision`: normalized display name, then
  opaque team ID as tie-breaker. A next page must use the same snapshot or return `conflict` with safe
  reason `snapshot_changed`.
- Empty success is distinct from unavailable/forbidden. No adapter converts failure to `[]`.

## Auth and safe error semantics

The application receives only a validated `QueryContext`; it never reads cookies, Electron event
objects, headers, IPs, or global auth state.

| Application outcome | Test HTTP-shaped mapping                                   | Test IPC-shaped mapping     |
| ------------------- | ---------------------------------------------------------- | --------------------------- |
| success             | `200` plus page                                            | typed success plus page     |
| `invalid_request`   | `400`                                                      | typed failure               |
| `unauthenticated`   | `401`, no body parsing/use-case call                       | test admission failure      |
| `forbidden`         | `403`, no reader call                                      | typed failure               |
| `not_found`         | not applicable to list; fixture rejects accidental mapping | not applicable to list      |
| `conflict`          | `409`                                                      | typed failure               |
| `unsupported`       | `422`                                                      | typed failure               |
| `unavailable`       | `503` plus bounded retry hint                              | typed retryable failure     |
| `cancelled`         | transport cancellation; no internal detail                 | typed cancellation          |
| unexpected fault    | `500` safe envelope with diagnostic ID                     | typed safe internal failure |

HTTP browser policy is proposed as `browser.session.read`; it is fixture metadata only in Phase 1.
The HTTP-shaped adapter receives a fake authenticated browser session; the IPC-shaped adapter receives
a fake local principal. Neither derives identity from a production event or is present in production
registration. Safe responses and logs must never contain cookie/token values, raw provider output,
command bodies, host paths, stack traces, or legacy `teamName` when it could reveal a path convention.

## Route and capability separation

Proposed conformance-fixture IDs (not production constants or advertised capabilities):

- route: `team-lifecycle.list-summaries.v1`;
- method/path: `GET /api/v1/team-lifecycle/teams`;
- IPC-shaped operation: `teamLifecycle:listSummaries`;
- specimen facet: `teamRead`;
- action/capability: `team.lifecycle.list`;
- request/response schemas: `team-lifecycle.list.request.v1` and
  `team-lifecycle.list.response.v1`.

The conformance route descriptor owns method/path, trust kind, auth-policy ID, readiness requirement,
schemas, handler reference, `testOnly: true`, and optional specimen-capability reference. The separate
capability descriptor owns facet/action support and feature owner but fixes production support to
absent. Dynamic resource allowance is absent from Phase 1 and cannot be inferred from fixture route
presence. RouteCatalog assertions operate on immutable fixture descriptors only; production catalogs
must reject `testOnly` descriptors. The parity ledger cross-references the proposed sources but is
neither a runtime manifest nor a generated client.

## Phase 1 filesystem boundary

The application port accepts values only; it has no path/root/config parameter. Its sole Phase 1
implementation is an in-memory deterministic reader under the test tree. No production or test module
in this specimen may import filesystem APIs, resolve ambient roots, create watchers, repair files, or
perform cleanup. `P1.NEG.NO_FILESYSTEM_ADAPTER_PHASE1` scans imports and port/constructor signatures
and includes a deliberately path-taking reader that must fail with the stable diagnostic
`phase1-filesystem-adapter-forbidden`.

The audited `P1.NEG.TEST_ROOT_ESCAPE` control is explicitly deferred to Phase 2's first
filesystem-backed output adapter. That later packet must create fresh temporary project and runtime
roots with an ownership marker, reject unmarked, pre-existing, ambient, home-scoped, and
symlink-escaped roots before access, and limit cleanup to marker-verified fixture-owned paths. This
deferral reopens immediately if any filesystem-backed or path-taking adapter enters Phase 1.

## Dependency direction

`contracts <- isolated test input adapters`, `domain <- application`, application owns the read port,
the test-only in-memory reader implements it, and only the conformance harness wires them. No Phase 1
preload or renderer adapter exists. Only root or documented layer entrypoints are public. Core cannot
import `@main`, Electron, Fastify, React, Zustand, `fs`, `path`, `child_process`, provider SDKs, or
transport types. Future hosted composition may import explicit production adapters only after a later
phase supplies identity, authorization, and registration.
