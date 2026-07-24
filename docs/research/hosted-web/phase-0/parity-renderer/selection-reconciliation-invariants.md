# Phase 0 W1 selection and reconciliation invariants

Evidence ID: `P0.W1.SELECTION_INVARIANTS`

Pinned AST: `a32f509e6d9bd31ba2135940e336729bf90c3d93`

Result: `characterized`

This record freezes required behavior; it does not claim that the current renderer already implements
the hosted revision/cursor model. Current desktop characterization comes from
`src/renderer/store/slices/teamSlice.ts`, `test/renderer/store/teamSlice.test.ts` and
`test/renderer/store/teamSliceContextRace.test.ts`. Phase 1 may extract reducers and narrow facets, but
must not replace those suites with snapshots or weaken their race coverage.

## Selection and identity

1. Selection commits only for the captured context identity, context epoch, team name, team-local
   epoch and selected-team load nonce. A response from a previous context, a reset using the same
   context ID, a previous team selection, delete, stop or launch is stale and has no visible effect.
2. Selecting an uncached team clears stale detail immediately. Selecting a cached team may reuse only
   the cache entry for that exact current scope; the selected pointer and cache entry must not diverge.
3. Hosted identity expands the current guards to the canonical tuple: deployment ID, boot ID, context
   epoch, opaque team ID, team generation, binding generation, workspace mount generation, roster
   generation, file-writer epoch, snapshot revision, instance-event cursor and current run reference.
   Team name is a display/legacy alias, not cache authority.
4. A boot ID change invalidates capabilities and session-derived allowance, forces a fresh snapshot,
   and cannot be treated as an ordinary reconnect. Stable deployment/team IDs may retain only safe UI
   preferences.
5. Only one reconciler selects `currentRunRef`. Provisioning, member-spawn, runtime, stop and cancel
   projections consume that reference; none chooses an arbitrary newest run.

Current proof: context-race tests cover old context, same-ID epoch reset and team reset; teamSlice tests
cover immediate stale selection clearing, cached selection, launch/delete invalidation and current-run
replacement. Hosted generation fields beyond the current context/team epochs remain Phase 1 work.

## Thin and full snapshots

1. Thin and full requests use distinct single-flight keys. Repeated callers may request at most one
   required fresh follow-up; a forced full refresh never aliases an in-flight thin request.
2. A thin selection snapshot may paint first, but cannot erase member, roster or runtime information
   from a newer full snapshot. A queued full refresh drains after the thin request settles or through
   the post-paint fallback.
3. Empty or lead-only rosters are not proof of deletion. Existing members may be preserved only when a
   same-scope summary/config/full launch record confirms the complete roster. An explicit removed
   marker is authoritative and must commit.
4. Any snapshot response carries a revision vector and the ADR-33 same-transaction/lower replay
   cursor. The cursor is a lower replay barrier, never described as “latest” or “current.”
5. A snapshot commits only when its captured identity tuple is still current and its revision is not
   older than the visible projection. Retryable failure keeps the last valid same-generation snapshot;
   only authoritative deletion or generation change clears it.
6. Semantically unchanged snapshots preserve object identity. Runtime timestamp observations may
   advance freshness memory but may not replace visible data unless renderer-facing state changed.

Current proof: focused tests cover queued full-after-thin, late thin responses, empty/lead-only roster
handling, explicit removal, post-paint failures and semantic runtime stabilization. Current snapshots do
not carry the complete hosted revision vector or ADR-33 cursor; that is an explicit unverified gap.

## Tombstones and terminal state

1. Delete, stop, launch replacement and a missing/cleared provisioning run create generation-scoped
   tombstones before clearing projections. Late SSE, poll, watcher, snapshot or member-runtime results
   for a tombstoned run are ignored.
2. An optimistic pending run is atomically replaced by the returned canonical run. A second unrelated
   run cannot displace the selected canonical run merely because its timestamp is newer.
3. Provisioning terminal states never regress. The only deliberate lifecycle exception is an explicitly
   modeled `ready -> disconnected` transition.
4. Tombstones are bounded by time and count, but cannot expire while a conflicting run is still
   observable. Cleanup removes a tombstone only with proof that the old run/generation is no longer an
   event, poll, process or snapshot source.
5. Cleanup of timers, subscriptions, pending approvals, runtime tool layers, messages and cached
   projections is exact to the team generation being removed. Cleanup from an old generation must not
   erase replacement state with the same display team name.

Current proof: teamSlice tests cover delete tombstoning, launch epoch invalidation, pending-to-canonical
replacement and stale progress rejection. The current `ignoredProvisioningRunIds` and
`ignoredRuntimeRunIds` maps do not encode bounded expiry/count or the complete hosted generation tuple;
bounded, observability-aware tombstone retention remains unverified Phase 1 work.

## Message pagination

1. Head refresh and older-page loading are serialized for one team. Concurrent head refreshes are
   single-flight and schedule at most one fresh follow-up.
2. An older page is requested with the exact current cursor and feed revision. If a head refresh or
   generation change invalidates either while the request is waiting, the page is discarded and a fresh
   head is loaded; the stale cursor is never continued.
3. Head merge preserves an already loaded older tail. Message identity deduplication is deterministic,
   and a historical feed change is distinguished from a visible-head change.
4. Pagination state is scoped to the full identity tuple. Context switch, launch, delete or team
   generation change clears only the obsolete scope and prevents queued work from restarting there.
5. Hosted queries are bounded and return explicit `nextCursor`, `hasMore`, feed/snapshot revision and
   redaction semantics. An empty browser stub response is never accepted as a complete page.

Current proof: teamSlice tests cover head single-flight/follow-up, head-behind-older serialization,
tail preservation, feed revision mismatch, launch invalidation and stale-cursor rejection. Server
revision-vector integration is not present on the pinned branch.

## Snapshot, event and poll races

The hosted reconciler must execute this order:

1. Capture the complete scope/generation tuple before a request.
2. Fetch a snapshot with revision vector and lower replay cursor.
3. Commit only if scope is still current and the snapshot is not older than visible state.
4. Subscribe from that cursor before declaring the view live.
5. Deduplicate by event ID; reject old aggregate, run, roster, mount or writer generations.
6. Apply a pure reducer when the event is complete; otherwise schedule one coalesced bounded refresh.
7. On gap, `resync_required` or schema mismatch, pause incremental application, fetch a new snapshot
   and resume from its cursor.
8. Use polling only as bounded health/recovery fallback. Poll responses obey identical scope and
   revision checks and cannot resurrect terminal/tombstoned state.
9. Retry with `Retry-After`, exponential backoff plus jitter, browser offline/visibility awareness and
   a per-tab request budget. Auth errors stop ordinary retry, coalesce one device renewal across tabs,
   then re-bootstrap or enter explicit pairing recovery. Mutation requests are never loop-retried.

Current desktop wiring is not proof of this algorithm: `initializeNotificationListeners` registers
team/tool/tracking listeners globally, provisioning subscription checks method presence, and component
log surfaces register additional listeners. `P0.W1.LEGACY_BYPASSES` enumerates those sites. ADR-20
requires feature-owned mount/unmount registration and runtime capability-permutation tests before the
hosted team entrypoint mounts.

## Fail-closed assertions for Phase 1 gates

- No facet presence, optional chain or method-existence check is action-support evidence.
- No supported action may throw “not available in browser mode,” silently no-op, or fabricate empty,
  offline or successful data.
- Every rendered control has one action mapping; unavailable desktop/deferred controls and their
  effects/listeners are absent before mount.
- Every event and poll fixture includes a stale identity/generation negative control.
- Every deletion/stop/launch fixture injects a late snapshot, event and poll result and proves no
  resurrection.
- Every pagination fixture advances the head/feed revision while an older page is pending and proves
  stale cursor rejection.
- Every snapshot fixture tests thin-after-full ordering and semantic object-identity preservation.

Proof levels are intentionally split: current Electron race behavior is `characterized`; the hosted
revision/cursor/tombstone algorithm is a mandatory invariant specification and remains `unverified`
until Phase 1 implementation and conformance tests exist.
