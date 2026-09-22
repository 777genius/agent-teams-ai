# Lead Session Parsing Cache Plan

## Goal

Reduce repeated `team:getData` cost for active teams by avoiding reparsing the same resolved lead-session JSONL file when the file has not changed.

Primary target:

- repeated refreshes of a visible active team

Not a primary target for phase 1:

- the very first uncached team open

Reason:

- the first miss still runs the current extraction logic
- phase 1 is a warm-path optimization, not a cold-path extraction rewrite

## Why This Is The Safest First Optimization

Today, `getTeamData()` repeatedly pays for lead-session history assembly:

1. resolve candidate project session directories
2. list `.jsonl` files
3. find the matching session file
4. parse the same JSONL twice
5. merge, sort, and dedup messages
6. repeat the same work on the next refresh even if the file is unchanged
7. still duplicate work under concurrent misses because there is no in-flight coalescing here

Relevant code:

- [src/main/services/team/TeamDataService.ts#L494](/Users/belief/dev/projects/claude/claude_team/src/main/services/team/TeamDataService.ts#L494)
- [src/main/services/team/TeamDataService.ts#L2150](/Users/belief/dev/projects/claude/claude_team/src/main/services/team/TeamDataService.ts#L2150)
- [src/main/services/team/TeamDataService.ts#L2324](/Users/belief/dev/projects/claude/claude_team/src/main/services/team/TeamDataService.ts#L2324)
- [src/main/services/team/leadSessionMessageExtractor.ts#L96](/Users/belief/dev/projects/claude/claude_team/src/main/services/team/leadSessionMessageExtractor.ts#L96)
- [src/main/utils/pathDecoder.ts#L5](/Users/belief/dev/projects/claude/claude_team/src/main/utils/pathDecoder.ts#L5)

This is safer than introducing a new lightweight IPC path because it does not change:

- what data is returned
- when refresh happens
- how live `lead_process` rows merge with persisted history
- any renderer/main truth boundary

## Guardrails

This work touches `main process / IPC` and team detail truth assembly.

Main failure modes to avoid:

- stale lead-session history shown after the file changed
- cache poisoning due to file mutation during parse
- cross-request mutation bleed from shared cached objects
- cache key mistakes caused by lossy path encoding assumptions

The change should preserve:

- current message shapes
- current message IDs
- current extraction semantics
- current team detail IPC contract

## Scope

### In scope

- add a bounded in-memory cache for parsed lead-session results
- reuse cached results only when the exact resolved session file is unchanged
- coalesce concurrent misses for the same file signature
- keep the returned `InboxMessage[]` shape unchanged
- add focused tests for freshness, invalidation, concurrency, and mutation safety

### Out of scope

- new IPC endpoints
- renderer refresh strategy changes
- changing `lead_process` merge/dedup logic
- replacing file scans with watchers
- rewriting extraction into a brand-new single-pass parser in phase 1
- caching project-dir resolution in phase 1

## Design Constraints

### 1. Cache after `jsonlPath` resolution, not before

Do not cache by `projectPath` or encoded project dir.

Why:

- `encodePath()` is lossy for paths containing dashes
- `getLeadProjectDirCandidates()` already exists because one project can require multiple candidate directory probes

Relevant code:

- [src/main/services/team/TeamDataService.ts#L2135](/Users/belief/dev/projects/claude/claude_team/src/main/services/team/TeamDataService.ts#L2135)
- [src/main/utils/pathDecoder.ts#L27](/Users/belief/dev/projects/claude/claude_team/src/main/utils/pathDecoder.ts#L27)

Rule:

- cache only after the final `jsonlPath` has already been concretely resolved

### 2. No TTL-based freshness

This cache must not use time-based correctness semantics.

There is a TTL-based advisory cache elsewhere:

- [src/main/services/team/TeamMemberRuntimeAdvisoryService.ts](/Users/belief/dev/projects/claude/claude_team/src/main/services/team/TeamMemberRuntimeAdvisoryService.ts)

That pattern is not appropriate here because lead-session rows are part of user-visible truth.

Rule:

- freshness comes only from file signature for the exact `jsonlPath`
- timestamps may be stored for eviction bookkeeping or debug only
- no "fresh for 5 seconds" shortcuts

### 3. Instance-scoped cache, not module-global

Preferred ownership:

- `TeamDataService` owns the cache instance
- optionally inject the cache into `TeamDataService` for tests

Do not use:

- a hidden module-global singleton

Why:

- the app already uses a long-lived `TeamDataService`
- tests should get fresh state with a fresh service instance
- module-global state would make isolation and failure analysis worse

### 4. First patch optimizes warm refreshes, not cold misses

Phase 1 still leaves one important cost untouched:

- on the first uncached read, the file is still parsed using the existing two-pass extraction path

That is acceptable because:

- it keeps correctness risk low
- it still removes repeated hot-refresh cost

If cold misses remain too slow after this patch, the next candidate optimization is a single-pass extractor, not a riskier cache broadening.

## Proposed Design

### 1. Cache the combined per-file extraction result

Integration point:

- `extractLeadSessionTextsFromJsonl(...)` in `TeamDataService`

Why here:

- it already defines the combined contract used by `getTeamData()`
- it merges assistant thoughts plus slash-command results
- it provides one place to attach both memoization and in-flight coalescing
- it avoids two separate caches that could drift

Do not cache:

- raw `projectPath -> jsonlPath` resolution
- whole-team assembled message lists

### 2. Cache key

Phase-1 key should include:

- `jsonlPath`
- `leadSessionId`
- `leadName`
- requested `maxTexts`
- cache schema version

Important tradeoff:

- keeping `maxTexts` in the key is less optimal for hit rate
- but it is safer than canonicalizing to a larger per-session cap in the first patch

Why this conservative choice is correct:

- the helper is private, but its caller passes a dynamic `remaining` budget based on earlier sessions
- requested-cap keys avoid subtle slicing mistakes in phase 1

### 3. Freshness signature

Primary signature:

- `size`
- `mtimeMs`

Optional tie-breaker:

- `ctimeMs`

Why not content hashing in phase 1:

- it adds more I/O and CPU to the hot path
- it makes the "optimization" more expensive

Accepted residual risk:

- a same-size rewrite on a coarse-timestamp filesystem is theoretically possible
- this is rare enough to accept for phase 1 if the cache is in-memory and tied to exact `jsonlPath`

### 4. In-flight coalescing

Memoization alone is not enough.

If two refreshes miss the cache at once, both can still parse the same file.

Required behavior:

- keep a separate `inFlightByKey` map
- attach the observed pre-parse signature to the in-flight entry
- if another request sees the same key and same observed signature, await that promise
- if another request observes a newer signature, do not await the older in-flight promise

Do not:

- mix settled entries and in-flight promises in one map

### 5. Do not cache ambiguous results

This is the most important safety rule after exact-path scoping.

If the file changes during parse:

1. pre-parse stat sees signature `S1`
2. parse runs
3. post-parse stat sees signature `S2`

If `S2 !== S1`:

- return the parsed result to the current caller
- do not populate the fulfilled cache
- clear the in-flight entry

Why:

- the result may still be acceptable as a best-effort snapshot for that one request
- but it is not safe enough to promote into cache

This is stricter and safer than caching under the old signature.

### 6. Defensive cloning

Never return the cached array instance directly.

Why:

- `getTeamData()` mutates messages during enrichment and dedup flows
- shared references would create cross-request contamination

Clone requirements:

- clone array
- clone each message object
- deep-clone nested mutable fields used by render/equality logic:
  - `taskRefs`
  - `attachments`
  - `toolCalls`
  - `slashCommand`
  - `commandOutput`

Do not:

- attach cache metadata to returned message objects

Relevant renderer equality code:

- [src/renderer/utils/messageRenderEquality.ts](/Users/belief/dev/projects/claude/claude_team/src/renderer/utils/messageRenderEquality.ts)

### 7. Bounded storage

Use a small cap, for example:

- `64` fulfilled entries

Eviction:

- insertion-order `Map`
- evict oldest fulfilled entry when exceeding cap

The cache is best-effort only:

- any entry may be dropped at any time
- eviction must never affect correctness, only latency

### 8. Do not cache failures

If stat, open, read, or parse fails:

- preserve current behavior
- do not cache the error
- do not leave a rejected promise in `inFlightByKey`

Why:

- JSONL writes are concurrent
- transient failures must not become sticky stale state

## Detailed Implementation Plan

### Phase 1. Add a cache helper

Suggested file:

- `src/main/services/team/cache/LeadSessionParseCache.ts`

Suggested operations:

- `getIfFresh(key, signature)`
- `getInFlight(key, signature)`
- `setInFlight(key, signature, promise)`
- `set(key, signature, messages)`
- `clearForPath(jsonlPath)`
- optional `clearAll()`

Helper responsibilities:

- normalize key
- compare signatures
- return defensive clones
- coalesce concurrent misses
- bound fulfilled entries
- keep settled cache and in-flight state separate

### Phase 2. Wire it into `TeamDataService`

Change only `extractLeadSessionTextsFromJsonl(...)`.

Algorithm:

1. stat file before parse
2. build key
3. try fulfilled cache hit
4. if miss, try matching in-flight entry
5. if no matching in-flight entry, create one
6. run current combined extraction using existing helpers unchanged
7. stat file again after parse
8. if post-parse signature matches pre-parse signature, populate fulfilled cache
9. otherwise skip cache population
10. clear in-flight entry in `finally`

Strict non-goals while wiring:

- do not change message ordering
- do not change trimming semantics
- do not change message IDs
- do not change assistant-thought extraction logic
- do not change slash-command result extraction logic
- do not change project-dir resolution logic

### Phase 3. Tests

Prefer focused tests at the `TeamDataService` layer because the cache integrates there.

Potentially add a dedicated cache helper test if the helper becomes non-trivial.

### Phase 4. Re-evaluate after profiling

Only if needed after phase 1:

1. optional directory-listing cache
2. optional canonical per-session cache not keyed by requested `maxTexts`
3. optional single-pass extractor for cold misses

Those are phase 2+ because each increases semantic risk.

## Edge Cases

### 1. File appended during read

Current behavior already tolerates partial trailing lines by skipping invalid JSON lines.

Phase-1 rule:

- if signature changed during parse, do not cache result

### 2. File deleted or moved after a previous successful cache fill

Rule:

- every cache lookup must be preceded by a fresh `stat`
- no successful fresh `stat` means no cache hit

### 3. Different requested `maxTexts`

Phase-1 rule:

- requested cap stays in the cache key

Why:

- lower hit rate is acceptable
- semantic conservatism is more important in this area

### 4. `leadName` changes while file is unchanged

Rule:

- include `leadName` in the key

### 5. Concurrent refreshes

Rule:

- only same-key, same-signature requests may share an in-flight promise

### 6. Newer request races an older in-flight parse

If request A saw signature `S1` and request B sees `S2`:

- request B must not await A's in-flight promise

### 7. Path ambiguity from encoded project dirs

Rule:

- never treat encoded project dir as canonical cache identity
- only the resolved `jsonlPath` is canonical enough for phase 1

### 8. Fresh service instances in tests

Rule:

- new `TeamDataService` instance should imply fresh cache state

## Areas With Lower Confidence

### 1. File signature granularity

Confidence: medium.

Why:

- filesystem timestamp granularity differs
- same-size rewrites are rare but possible

Decision:

- use `size + mtimeMs` primarily
- optionally add `ctimeMs` as tie-breaker
- document residual risk instead of overengineering phase 1

### 2. Requested-cap keys vs canonical per-session cache

Confidence: medium.

Why:

- canonical caching could improve hit rate
- but requested-cap keys are more obviously equivalent to today's behavior

Decision:

- requested-cap keys in phase 1

### 3. In-flight signature matching

Confidence: medium.

Why:

- easy to implement incorrectly if signature is not stored with the in-flight promise

Decision:

- store signature alongside each in-flight promise
- require exact signature match before reuse

### 4. Post-parse signature mismatch handling

Confidence: medium-high.

Why:

- returning but not caching ambiguous results is semantically conservative
- but this still leaves one request with a best-effort snapshot rather than a strong snapshot

Decision:

- accept current best-effort behavior for the single request
- forbid cache population on mismatch

### 5. Cold-load expectations

Confidence: high.

Why:

- phase 1 clearly improves warm refreshes more than first opens

Decision:

- state that explicitly
- do not oversell the patch

## Testing Plan

In [test/main/services/team/TeamDataService.test.ts](/Users/belief/dev/projects/claude/claude_team/test/main/services/team/TeamDataService.test.ts) or a dedicated cache test:

1. repeated extraction of the same unchanged JSONL uses cached results
2. append invalidates cache and returns fresh results
3. changing `leadName` does not reuse stale sender data
4. returned cached results are cloned and caller mutation does not poison the next read
5. different `maxTexts` requests do not incorrectly reuse the wrong slice
6. two concurrent requests for the same uncached file coalesce into one parse
7. missing or deleted JSONL does not return stale cached content
8. partial trailing line remains tolerated and does not get cached as a sticky failure
9. path with dashes and underscores still works once `jsonlPath` is resolved
10. if a newer request sees a newer signature, it does not await an older in-flight parse
11. if the file changes during parse, result is returned but not stored in fulfilled cache
12. fresh `TeamDataService` instances do not share hidden cache state

In [test/main/services/team/leadSessionMessageExtractor.test.ts](/Users/belief/dev/projects/claude/claude_team/test/main/services/team/leadSessionMessageExtractor.test.ts):

13. existing extraction semantics remain unchanged

Existing behavior that must still hold:

- slash-command result merging
- message ordering
- stable message IDs

## Verification

Targeted first:

```bash
bun test test/main/services/team/leadSessionMessageExtractor.test.ts test/main/services/team/TeamDataService.test.ts
```

Then broader team-service confidence if needed:

```bash
bun test test/main/services/team
```

## Success Criteria

The change is successful if:

1. repeated `team:getData` for an unchanged active team avoids reparsing the same session file
2. new lead-session output appears after the file changes without manual invalidation
3. concurrent refreshes do not duplicate parse work for the same signature
4. newer signatures never reuse older in-flight parse results
5. ambiguous mid-read results are never committed into fulfilled cache
6. path-resolution behavior for project session discovery remains unchanged
7. existing TeamDataService and extractor tests still pass
8. no duplicate or missing lead thoughts appear compared with current behavior

## Recommended Order

1. add cache helper with bounded fulfilled entries and separate in-flight map
2. make it instance-scoped or injectable into `TeamDataService`
3. integrate only at `extractLeadSessionTextsFromJsonl(...)`
4. add pre-parse and post-parse signature checks
5. add focused tests for hit, miss, invalidation, mutation safety, concurrency, and no-cache-on-ambiguous-read
6. run targeted tests
7. only then consider directory-listing cache or single-pass extraction if profiling still points there

## Recommendation

Recommended phase-1 approach:

- parse cache
- in-flight coalescing
- no cache population if the file changed during parse

Ratings:

- Parse-cache-only first step: 🎯 9   🛡️ 9   🧠 4
- Parse-cache plus in-flight coalescing: 🎯 9   🛡️ 9   🧠 5
- Parse-cache plus in-flight plus no-cache-on-mid-read-mutation: 🎯 9   🛡️ 10   🧠 6
- Plus directory-listing cache in the same patch: 🎯 5   🛡️ 6   🧠 7
- Skip cache and jump straight to new lightweight IPC API: 🎯 8   🛡️ 7   🧠 7

Estimated patch size for the recommended step:

- around 180-320 changed lines
