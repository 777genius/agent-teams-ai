# Proposed migration, operations, and risk controls

Status: blocked proposal. All IDs, thresholds, paths, and owners are proposed until serial bootstrap.

## Migration and ratchet sequence

1. Characterize and hash the legacy list seams; do not change them.
2. Add the isolated kernel and team-lifecycle contracts.
3. Prove the application query against an in-memory test reader.
4. Add IPC-shaped and HTTP-shaped adapters only under the isolated conformance test tree; add no
   production channel, route, preload/global facet, renderer client, or registration.
5. Run shadow semantic comparisons in fixtures; no dual writes exist because the slice is read-only.
6. Add ratchets that forbid new legacy/global dependencies while counting untouched debt.
7. Freeze evidence. Phase 2 may add real output adapters and decide renderer/route cutover only after
   stable identity and auth/readiness prerequisites exist.

No old authority is removed in Phase 1. The conformance seam has no production reachability, so
rollback is removal of the new unregistered feature contracts, fixture descriptors, and test harness
while retaining rejected evidence. There are no new production IPC calls to disable.

## Rollback triggers and procedure

Trigger rollback on legacy desktop regression, accidental production IPC/HTTP adapter exposure, auth
admission bypass, semantic mismatch, raw error/path leak, unstable cursor/revision behavior,
dependency cycle, performance budget breach, or ratchet false-negative.

The integration owner removes only the unregistered specimen and verifies that production IPC, preload,
HTTP, renderer, and legacy behavior remain byte/graph-equivalent to the frozen baseline, reruns
architecture scans, and records the rejected evidence IDs.
No state rollback, data migration, file repair, or dual-write reconciliation is needed. Never weaken a
negative gate to make rollback green. Phase 2 cannot consume rejected contracts until a new reviewed
revision supersedes them.

## Observability

The proposed slice emits structured, redacted diagnostics at adapters/composition only:

- route/channel/action ID, request ID, outcome code, duration bucket, item count, page-present flag,
  and diagnostic ID;
- no actor/session/team identifier, cursor value, display name, host path, cookie/token, provider
  output, stack, or request body;
- metrics for request count, outcome count, cancellation, invalid cursor, use-case duration, adapter
  duration, response bytes, and denied-before-use-case count;
- one startup assertion summary for catalog counts and test-only route production absence.

Logs are not conformance evidence by themselves. Tests spy on calls and normalized outcomes. Proposed
cardinality and payload limits are frozen in serial bootstrap; unknown codes are rejected rather than
becoming labels.

## Risk register

| Proposed risk                                     | Likelihood/impact | Detection                                         | Mitigation / owner                              |
| ------------------------------------------------- | ----------------- | ------------------------------------------------- | ----------------------------------------------- |
| Phase 0 assumption changes contract shape         | High/high         | prerequisite and stale-packet checks              | keep blocked; `P1.S0` re-derives proposal       |
| Tiny kernel grows into god API                    | Medium/high       | export census and unused-abstraction review       | usage-required rule; `R2`                       |
| RouteCatalog becomes framework/runtime manifest   | Medium/high       | import/shape negatives                            | metadata/assertions only; `R1`                  |
| Capability and route state merge                  | Medium/high       | source-separation and cross-reference tests       | feature-owned separate descriptors; `1B`        |
| List slice invents identity                       | High/high         | fixture/DTO review and production-adapter absence | synthetic test IDs only; Phase 2 owns identity  |
| Test IPC/HTTP adapter leaks into production       | Low/critical      | production import-graph/mount negative            | test-only composition; `1C`/`P1.I`              |
| IPC-shaped and HTTP-shaped mappings differ subtly | Medium/high       | shared vectors plus use-case spy                  | semantic harness; `1C`/`R2`                     |
| Safe errors leak legacy paths/secrets             | Medium/critical   | canary vectors and changed-file scan              | allowlisted envelope/redaction; `R2`            |
| Cursor scope/revision replay is ambiguous         | Medium/high       | foreign/expired/snapshot-change vectors           | opaque bound cursors; `1A`/`1D`                 |
| ADR-19 scanner misses an omission                 | Medium/high       | omitted-row/signature/reference negatives         | omission-sensitive fixtures; `R1`               |
| ADR-20 scan has evasion or false positives        | Medium/high       | renamed/aliased/dynamic access fixtures           | import graph plus AST/source census; `R1`       |
| Shared-file merge corrupts ownership              | Medium/high       | path manifest and status checks                   | one integration writer; controller              |
| New dependency destabilizes build/cache           | Low/medium        | lockfile/status check                             | no dependency changes; packet revision required |
| Performance gate is noisy or gamed                | Medium/medium     | fixed fixtures, separated overhead, repeated run  | host-qualified baseline; `P1.I`                 |
| Existing failures are mislabeled green            | Medium/high       | fingerprint comparison                            | preserve exact inherited ledger; controller     |
| Filesystem work enters deferred Phase 1 scope     | Low/critical      | port/signature/import no-filesystem negative      | stop Phase 1; reopen `P1-GAP-009`; `R1`         |

No open critical risk may be accepted at Phase 1 freeze. High risks require a named owner, evidence,
and either mitigation or explicit phase-blocking decision.

## Integration evidence and handoff

The freeze must publish a decision register, evidence index with proof levels/hashes, unique estimate
reconciliation, inherited-failure comparison, performance report, dependency/lockfile assertion,
scope/diff/secret/path report, reciprocal reviews, rollback result, and the smallest Phase 2 input.
Evidence says `source_observed`, `fixture_characterized`, or `target_verified` precisely; it does not
call an isolated Fastify injection a production hosted verification.

## Phase 1 completion boundary

Phase 1 is done only when the [controller Definition of Done](./controller-packet.md#definition-of-done)
is proved at the integrated SHA. It does not mean hosted team reads, stable identities, browser auth,
production routing, renderer migration, or lifecycle mutation are complete. Those claims remain
explicitly unverified and feed later phases.
