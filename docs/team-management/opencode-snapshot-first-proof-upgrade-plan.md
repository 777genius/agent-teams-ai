# OpenCode Snapshot-First Proof Upgrade Plan

## Goal

Reduce false or avoidable OpenCode review warnings for new tasks by upgrading
metadata-only OpenCode `edit`, `write`, and `apply_patch` changes to verified
full-text before/after changes when, and only when, existing OpenCode snapshot
evidence proves the exact file state transition.

The implementation must be fail-closed:

- If proof is complete, store full before/after content and remove manual-only warnings.
- If proof is incomplete, ambiguous, too large, binary, outside scope, or unavailable, keep the current warning.
- Never use current disk content as proof for historical before/after.
- Never broaden attribution outside strict delivery context.

## Non-goals

- Do not change Codex or Anthropic task extraction.
- Do not change generic review UI semantics.
- Do not infer diffs from current disk.
- Do not scan unrelated OpenCode sessions.
- Do not increase OpenCode snapshot file size limits as part of this work.
- Do not retroactively "fix" old tasks unless existing ledger backfill has strict delivery and snapshot evidence.

## Current System Facts

Desktop repo:

- `ChangeExtractorService` requests OpenCode ledger backfill only when delivery context is available.
- Backfill goes through `OpenCodeReadinessBridge.backfillOpenCodeTaskLedger`.
- Imported events already support full before/after content and metadata-only fallbacks.

Orchestrator repo:

- `OpenCodeProfileManager.buildManagedConfig()` already sets `snapshot: true`.
- `OpenCodeLedgerBridgeService.backfill()` reconstructs toolpart changes, then calls `OpenCodeChangeEvidenceEnricher.enrich()`.
- `OpenCodeOfflineSessionReader` reads OpenCode SQLite history in read-only mode and extracts snapshot windows.
- `OpenCodeSnapshotEvidenceProviderService` reads before/after snapshot file contents with strict limits.
- `OpenCodeToolpartChangeReconstructor` already creates exact `toolpart-chain` changes when it has a known baseline.
- `OpenCodeChangeEvidenceEnricher` already upgrades some metadata-only changes through snapshot or inverse chain proof.

This plan should strengthen the existing evidence path rather than introduce a
new capture subsystem.

## Risk Estimate

Recommended implementation:

- Functional bug risk: 3/10.
- Performance regression risk: 2/10.
- Data safety risk: 2/10.
- Complexity: 7/10.
- Approximate runtime change size: 220-450 LOC.
- Approximate total change size with tests and diagnostics: 450-900 LOC.

The low data safety risk depends on preserving fail-closed behavior. If any
step starts accepting guesses as proof, data safety risk becomes 7/10 or worse.

## Hard Safety Invariants

These invariants are more important than reducing warnings.

1. A full-text upgrade must be tied to one task, one member, one OpenCode
   session, one delivery record, one assistant message, one toolpart, and one
   snapshot window.
2. The upgrade must be local to OpenCode. Codex, Anthropic, generic task-log
   parsing, and non-OpenCode review flows must not change.
3. `strict-delivery` is required for every snapshot-based full-text upgrade.
   Compatible attribution may still import metadata-only events, but it must not
   produce auto-safe before/after content.
4. Current disk content is never historical evidence. It can be displayed as
   read-only context by the desktop, but it cannot remove a warning or enable
   safe reject.
5. Hash-only evidence is not full-text evidence. A hash can verify text that was
   already read from a trusted snapshot, but a hash alone is not enough.
6. Empty string is valid full text. `null` and `undefined` mean unavailable.
7. Large, binary, truncated, path-unsafe, or schema-unsupported content stays
   metadata-only.
8. A failed upgrade must preserve the original change event shape as much as
   possible. It may add diagnostics, but it must not remove warnings or mutate
   operation/confidence.
9. Imported event idempotency must remain based on existing source import keys.
   The upgrade must not create duplicate events for the same toolpart/path.
10. Any multi-change path chain must be all-or-nothing for unresolved changes in
    that path/window. Partial upgrades are allowed only for changes that were
    already independently exact before the chain attempt.
11. The implementation must never make a previously non-rejectable change
    rejectable unless both `beforeContent` and the target after/absence state
    are proven from the same trusted historical evidence path.
12. Diagnostics are allowed to become more detailed. They are not allowed to be
    used as a substitute for proof.

## Things That Are Explicitly Not Proof

These signals can be useful diagnostics, but they must not remove warnings or
enable safe reject by themselves:

- Current disk content matching an expected hash.
- Current disk content matching `newString`.
- A file path appearing in OpenCode tool metadata.
- A file path appearing in a snapshot diff without readable before/after text.
- A before/after hash without the corresponding text blob.
- An OpenCode tool status of `completed`.
- The absence of an error in the toolpart.
- The task title mentioning the same directory.
- A member name matching the expected teammate.
- A session id matching but no strict delivery record.
- A snapshot window in the same session but a different assistant message.
- A snapshot window that overlaps several toolparts ambiguously.
- A successful manual UI render of current disk preview.

If implementation pressure makes any of these tempting, stop and keep the
warning.

## Threat Model

The feature is not security-sensitive in the network sense, but it is
data-safety-sensitive. The main threat is a false full-text proof that enables
safe reject/apply for the wrong historical state.

Bug classes to defend against:

1. Cross-task contamination:
   - A file change from task A appears in task B review.
   - Main defense: strict delivery, canonical task id, source message/window
     matching, real-data smoke.
2. Cross-member contamination:
   - A teammate using the same OpenCode profile is attributed to another member.
   - Main defense: delivery record member/lane/session matching.
3. Cross-window contamination:
   - A toolpart is matched to the wrong snapshot window in the same message.
   - Main defense: exactly-one window matching and order tests.
4. False baseline:
   - Current disk or hash-only evidence is treated as historical before text.
   - Main defense: "not proof" list and code review checklist.
5. Unsafe warning removal:
   - UI stops warning about a file that is still manual-only.
   - Main defense: central warning predicate and negative warning tests.
6. Duplicate imported events:
   - The same source toolpart appears twice after re-backfill.
   - Main defense: source-key idempotency audit and repeated-backfill tests.
7. Silent performance regression:
   - Snapshot proof reads too many blobs or times out often.
   - Main defense: proof-needed filtering, existing limits, timing counters.
8. Unsupported upstream shape:
   - OpenCode changes SQLite/snapshot schema and our parser guesses.
   - Main defense: shape fingerprint, unsupported fallback, abort condition.

For every bug class above, the implementation needs at least one negative test
or real-data smoke assertion.

## Pre-Implementation Audit Checklist

Before writing runtime code, answer these questions from the current codebase:

1. Does the task-change ledger importer update, replace, supersede, or append
   events with the same `sourceImportKey`?
2. Does the desktop review bundle dedupe by source key, file path, event id, or
   a computed change id?
3. Which exact helper decides whether a file is rejectable?
4. Which warnings are currently surfaced in `TeamChangesSection` versus the
   full review dialog?
5. Does the OpenCode backfill cache hide an upgraded result for up to 60 seconds
   after a first metadata-only result?
6. Does `materializeMetadataOnlyChanges` preserve `evidenceProof`,
   `snapshotId`, `snapshotSource`, and warnings exactly?
7. Can the snapshot provider return `beforeState`/`afterState` with hashes but
   no text, and how is that serialized into task-change events?
8. Are OpenCode snapshot windows always message-local in current real data?
9. Are there real examples where a single toolpart touches more than one file?
10. Are there real examples where `apply_patch` contains rename or mode-only
    changes?
11. Does the snapshot provider ever return duplicate file entries for the same
    normalized path?
12. Does the task-change worker cache bundle results independently from the
    OpenCode backfill cache?
13. Are task-level warnings derived only from imported events, or can they come
    from boundary parsing separately?
14. Does a safe reject require `beforeContent`, or can `beforeState.exists === false`
    plus `afterContent` be enough for creates?
15. Is there any existing telemetry/log sink where structured counters can be
    emitted without leaking file contents?

If any answer is unknown, add a focused diagnostic or unit test before changing
behavior. Do not use implementation guesses for these contracts.

## Decision Gates

These gates must be passed in order. Do not skip gates to get fewer warnings
faster.

| Gate | Required evidence | If not met |
| --- | --- | --- |
| G0 contract audit | importer, bundle, rejectability, cache behavior known | no runtime change |
| G1 diagnostics-only | new diagnostics pass tests with no behavior change | fix diagnostics first |
| G2 shadow proof | proof computes stats but imports original changes | keep behavior disabled |
| G3 single-change proof | positive and negative single-change tests pass | keep apply disabled |
| G4 real-data single-change smoke | OpenCode improves or stays same, non-OpenCode unchanged | do not enable default |
| G5 multi-change proof | all chain tests pass, no ambiguous branch accepted | keep `full` unavailable |
| G6 real-data full smoke | no cross-task leakage, budgets pass | keep default `single-change` |
| G7 rollback check | `OPENCODE_SNAPSHOT_PROOF_UPGRADE=off` restores old behavior | do not ship |

The implementation should be easy to stop after G4. Single-change mode is a
valid ship point; `full` mode is optional.

## Known Unknowns That Block Full Mode

`full` mode must stay disabled if any of these are still unknown:

- Whether importer supersedes or appends duplicate `sourceImportKey` events.
- Whether real OpenCode data has nested or overlapping snapshot windows.
- Whether real OpenCode `apply_patch` parts include rename, chmod, or binary
  patch shapes.
- Whether multi-change same-path chains occur often enough to justify the risk.
- Whether review bundle dedupe can handle upgraded old events without duplicate
  rows.
- Whether snapshot proof stats can be collected without logging sensitive
  content.

Unknowns do not block diagnostics or single-change mode. They block `full` mode.

## Assumption Ledger

Keep an explicit ledger of assumptions. Each assumption needs a validation path
and a fallback. Do not leave assumptions implicit in implementation code.

| Assumption | Validation | Fallback if false |
| --- | --- | --- |
| OpenCode snapshot windows are message-local | unit fixture and real-data diagnostics | metadata-only fallback |
| Source import keys are stable across re-backfill | repeated-backfill test | new-imports-only, no old rewrite |
| Review bundle dedupes safely | Phase 0 audit and bridge test | do not upgrade old events |
| Empty string survives materialization | serialization test | do not upgrade empty files |
| Existing reject helper checks current disk | desktop contract test | fix shared helper before enabling |
| Snapshot store objects remain readable long enough | retention fixture and diagnostics | metadata-only fallback |
| Part ordering is stable enough for chains | ordering unit tests | disable `full` |
| Warning predicates are complete | unit tests naming every removed warning | preserve warning |
| Stats can be emitted without content | log review and tests | disable stats or redact harder |
| Non-OpenCode fingerprints stay identical | real-data mode comparison | keep apply modes disabled |

If an assumption has no validation path, it should be moved to "Known Unknowns"
and block `full` mode.

## Capability And Version Gates

Do not assume that `snapshot: true` in managed OpenCode config means snapshot
evidence is usable for every session. Treat snapshot proof as a runtime
capability that must be observed for the specific session being backfilled.

Required capability checks:

- OpenCode SQLite schema is supported.
- Session identity includes project id, directory, worktree, and git VCS.
- Session worktree matches the expected workspace root.
- Snapshot windows are present and paired.
- Snapshot git store reader reports the expected shape fingerprint.
- Snapshot file evidence can be read under the existing limits.
- The proof path sees the same normalized relative path in reconstruction and
  snapshot evidence.

Suggested result type:

```ts
type SnapshotProofCapability =
  | {
      supported: true
      shapeFingerprint: string
      sessionId: string
      projectId: string
    }
  | {
      supported: false
      code:
        | 'sqlite-schema-unsupported'
        | 'session-identity-missing'
        | 'workspace-mismatch'
        | 'snapshot-window-missing'
        | 'snapshot-store-unsupported'
        | 'snapshot-store-missing'
      diagnostics: string[]
    }
```

Rules:

- Unsupported capability returns metadata-only fallback.
- Unknown capability returns metadata-only fallback.
- Capability diagnostics may be emitted in `shadow`.
- Capability success alone is not proof. It only allows proof attempts.

## Mode Behavior Matrix

The mode must determine both proof computation and proof application.

| Mode | Compute proof? | Apply proof? | Import changed events? | Intended use |
| --- | --- | --- | --- | --- |
| `off` | no | no | no | rollback and baseline comparison |
| `shadow` | yes | no | no | validate proof quality and performance |
| `single-change` | yes | only one unresolved change per path/window | yes | safe first rollout |
| `full` | yes | one-change and verified chains | yes | optional later rollout |

If implementation makes `shadow` import different events from `off`, it is a
bug. If implementation makes `off` compute snapshot proof, it is a performance
bug.

## Minimum Safe Scope

The first behavior-changing implementation should intentionally support less
than the full theoretical feature.

Allowed in first `single-change` apply mode:

- OpenCode only.
- `strict-delivery` only.
- One unresolved change for one normalized path inside one snapshot window.
- Text files within existing size limits.
- `write` create when before absence and after text are proven.
- `write` modify when before text, after text, and toolpart after content agree.
- `edit` modify when `oldString` occurs exactly once and produces snapshot after.
- delete when before text and after absence are proven.

Explicitly excluded from first apply mode:

- Multi-change same-path chains.
- `apply_patch` without parsed hunks.
- rename, chmod, binary patch, submodule, and mode-only changes.
- Any case requiring current disk as evidence.
- Any case requiring line-ending normalization.
- Any case where snapshot evidence exists but operation semantics are unclear.
- Any old metadata-only event rewrite unless source-key supersede is proven.

This scope is deliberately conservative. The goal is to prove the pipeline, not
to maximize warning reduction in the first implementation.

## Lowest-Confidence Areas And Mitigations

The implementation should explicitly address the areas below because they are
where mistakes are most likely.

### Snapshot Window Matching

Risk: OpenCode history can contain several `step-start` and `step-finish`
records in the same assistant message. Incorrect ordering could attach a
toolpart to the wrong snapshot pair.

Mitigation:

- Keep the existing requirement that a toolpart must match exactly one window.
- Keep message-local matching. Do not match a toolpart to a window from another
  assistant message.
- Add tests where a toolpart is before the first window, after the last window,
  and inside two overlapping windows.
- If window order cannot be proven from `rawParts`, skip the upgrade.

### Multi-Change Chains

Risk: several edits to the same file can produce the same final content through
more than one path. This is the easiest place to create a convincing but wrong
diff.

Mitigation:

- Implement single-change upgrades first.
- Gate multi-change chain upgrades behind a narrow helper and dense tests.
- Do not allow a `write` in the middle of a reverse chain unless both sides of
  that write are independently proven.
- Abort the whole path/window chain on the first ambiguous step.
- Add a kill switch that can disable multi-change upgrades while leaving
  single-change upgrades enabled.

### Warning Removal

Risk: broad substring filtering can hide warnings that still matter, especially
task-boundary or attribution warnings.

Mitigation:

- Do not remove warnings by broad terms like `manual-only` alone.
- Centralize warning predicates and match only known OpenCode baseline/content
  warning messages.
- Preserve all warnings that mention attribution, delivery, boundary,
  confidence, path scope, binary, too-large, truncated, or unavailable snapshot
  content.
- Add tests where a warning contains `manual-only` but is unrelated to baseline
  proof.

### Snapshot Shape Stability

Risk: OpenCode can change SQLite or snapshot git-store shape. A shape change
could make old assumptions invalid.

Mitigation:

- Keep `snapshotShapeFingerprint` checks visible in diagnostics.
- Treat unknown or unsupported shapes as metadata-only fallback.
- Do not add compatibility shims that guess from partial rows.
- Add an abort condition for a real-data shape mismatch.

### Snapshot Store Retention

Risk: OpenCode SQLite can contain snapshot window hashes while the corresponding
git-store objects are missing, pruned, moved, or unreadable. The history then
looks promising but cannot prove full text.

Mitigation:

- Treat missing snapshot objects as metadata-only fallback.
- Keep a distinct diagnostic for missing store object versus unsupported shape.
- Do not retry by reading current disk.
- Do not reconstruct from only one side of the snapshot pair.
- Add a fixture where the window exists but object read fails.

### Performance

Risk: reading snapshot blobs for every task can become expensive on large
sessions.

Mitigation:

- Try snapshot proof only for unresolved OpenCode changes in strict delivery.
- Pass only unresolved touched paths to the snapshot reader unless a same-path
  chain requires exact already-proven neighbors.
- Keep the current snapshot read limits.
- Add timing diagnostics around snapshot proof attempts.
- Abort rollout if repeated snapshot timeouts appear in smoke data.

### Existing Ledger Events

Risk: a task that was previously imported as metadata-only may later be
backfilled with better evidence. If importer semantics are append-only, the UI
could show duplicates or stale warnings.

Mitigation:

- Audit importer behavior before enabling upgrades for old data.
- Prefer stable source-key replacement/superseding if already supported.
- If replacement is not supported, limit the behavior change to new backfill
  imports and leave old events untouched.
- Add repeated-backfill tests before real-data smoke.

### Cache Invalidation

Risk: desktop or worker cache may return an old metadata-only bundle after the
orchestrator has imported stronger evidence, making validation confusing or
causing stale warnings to persist.

Mitigation:

- Audit all cache layers in Phase 0.
- Include the OpenCode ledger fingerprint or imported event count in cache
  invalidation if an existing mechanism supports it.
- For tests, clear or bypass caches instead of waiting for TTLs.
- Do not add broad cache busting for all teams. Keep invalidation scoped to the
  requested team/task.

### Partial Success Semantics

Risk: one file in a task upgrades while another remains metadata-only. Bulk
review actions might accidentally assume the task is fully safe.

Mitigation:

- Keep rejectability file-level.
- Keep task-level warnings if any file remains manual-only or if boundaries are
  uncertain.
- Add a mixed-task desktop test.

## Feature Flag And Rollback

Add a runtime guard before changing behavior:

```ts
type SnapshotProofUpgradeMode = 'off' | 'shadow' | 'single-change' | 'full'

function getSnapshotProofUpgradeMode(env: NodeJS.ProcessEnv): SnapshotProofUpgradeMode {
  const raw = env.OPENCODE_SNAPSHOT_PROOF_UPGRADE
  if (raw === '0' || raw === 'off') {
    return 'off'
  }
  if (raw === 'shadow') {
    return 'shadow'
  }
  if (raw === 'full') {
    return 'full'
  }
  if (raw === 'single-change') {
    return 'single-change'
  }
  return 'shadow'
}
```

Recommended rollout:

- Default to `shadow` during development and first smoke validation.
- Move to `single-change` only after shadow stats show expected upgrades with
  no behavior changes.
- Move to `full` only after multi-change chain tests and real-data smoke pass.
- Keep `off` available as an emergency rollback path.
- If `full` later becomes the default, that should be a separate rollout change
  after the implementation has passed real-data smoke in explicit `full` mode.

If the project already has a central feature-flag/env helper for OpenCode
runtime behavior, use that instead of adding a new ad-hoc parser.

`shadow` mode is intentionally different from `off`:

- `off` does not attempt proof.
- `shadow` attempts proof and records stats/diagnostics, but returns the
  original changes to the importer.
- `single-change` applies only one-change path/window upgrades.
- `full` applies single-change and multi-change chain upgrades.

This gives a low-risk way to validate proof quality and performance on real
data before changing review safety.

## Architecture

Use this pipeline:

```text
OpenCode SQLite history
  -> toolpart reconstruction
  -> strict delivery attribution
  -> snapshot window grouping
  -> snapshot file read with limits
  -> proof upgrade per path
  -> validate candidate batch
  -> import task-change events
```

The upgrade belongs in the orchestrator evidence layer, primarily around:

- `OpenCodeChangeEvidenceEnricher.ts`
- `OpenCodeSnapshotEvidenceProvider.ts`
- `OpenCodeToolpartChangeReconstructor.ts` only if a small helper or extra metadata is needed
- tests near existing OpenCode evidence and ledger bridge tests

Avoid touching desktop review UI for the proof itself. The desktop should only
benefit from better imported event content.

## Composite Identity Contract

Every full-text proof must be anchored to a composite identity. Do not rely on
any single field alone.

Required identity dimensions:

```ts
type SnapshotProofIdentity = {
  teamName: string
  taskId: string
  memberName: string
  laneId?: string
  sessionId: string
  parentUserMessageId?: string
  assistantMessageId: string
  sourceMessageId: string
  sourcePartId: string
  toolUseId: string
  relativePath: string
  snapshotWindowId: string
  fromSnapshot: string
  toSnapshot: string
}
```

Rules:

- `taskId` must be canonical, not display-only.
- `memberName`, `laneId`, and `sessionId` must come from strict delivery or
  already trusted session records.
- `sourceMessageId` must match the snapshot window message id.
- `sourcePartId` must be inside the matched window according to the same
  message's part order.
- `relativePath` must be normalized through the existing OpenCode path helpers.
- `fromSnapshot` and `toSnapshot` must be the exact pair used to read file
  evidence.

If any identity dimension is missing, the default is `metadata-only-fallback`.

## Ordering Contract

Same-path chains are safe only if toolpart order is stable and proven. Use the
existing ordering data from OpenCode SQLite. Do not introduce a new sort.

Preferred order keys, in priority order:

1. `messageTimeCreated`
2. `messageIdSort`
3. `messagePartOrder`
4. `partId`

Rules:

- Do not sort only by `partId`.
- Do not sort only by timestamp.
- Do not merge parts from different `sourceMessageId` values into one chain.
- If two parts have indistinguishable order, do not upgrade the chain.
- If raw part order is unavailable, single-change upgrade may still work, but
  multi-change mode must skip.

Example guard:

```ts
function hasStablePartOrder(parts: SourcePartSortKey[]): boolean {
  const seen = new Set<string>()
  for (const part of parts) {
    const key = [
      part.messageTimeCreated,
      part.messageIdSort,
      part.messagePartOrder,
      part.partId,
    ].join('\0')
    if (seen.has(key)) {
      return false
    }
    seen.add(key)
  }
  return true
}
```

If the real symbol names differ, keep the same invariant.

## Cross-Repo Contract Boundaries

This feature crosses the desktop repo and the orchestrator repo. Keep the
contract explicit.

Desktop responsibilities:

- Request OpenCode backfill only when delivery context exists.
- Keep cache/in-flight dedupe behavior.
- Render full-text events as diffs.
- Render metadata-only events as manual-only warnings.
- Use existing rejectability checks. Do not special-case OpenCode snapshot
  events in the UI unless a rendering bug is found.

Orchestrator responsibilities:

- Read OpenCode history and snapshot evidence.
- Decide whether proof is strong enough to materialize before/after text.
- Preserve strict delivery attribution.
- Preserve source import keys.
- Emit diagnostics explaining why upgrades were skipped.

Shared contract:

```ts
type ReviewSafetyContract = {
  sourceImportKey: string
  evidenceProof: OpenCodeEvidenceProof
  beforeContent: string | null
  afterContent: string | null
  beforeState?: { exists?: boolean; sha256?: string; sizeBytes?: number; unavailableReason?: string }
  afterState?: { exists?: boolean; sha256?: string; sizeBytes?: number; unavailableReason?: string }
  warnings?: string[]
}
```

Safe reject requires a proven historical baseline:

```ts
function hasSafeHistoricalBaseline(change: ReviewSafetyContract): boolean {
  if (change.beforeContent !== null) {
    return true
  }
  return change.beforeState?.exists === false && change.afterContent !== null
}
```

The exact desktop helper may have a different name. The invariant should match
this contract.

## Apply/Reject Execution Safety Contract

Snapshot proof can make a review event eligible for normal diff rendering and
safe reject consideration. It must not bypass current worktree conflict checks.

Review safety and execution safety are different:

- Review safety answers: "Do we know the historical before/after for this
  change?"
- Execution safety answers: "Can we apply or reject this change against the
  user's current disk state right now?"

This feature only upgrades review safety. It must not weaken execution safety.

Required rules:

- Rejecting a modify still requires the current file to match the expected after
  state, or whatever stricter existing conflict check is already used.
- Rejecting a create still requires the current file to match the created after
  state before deletion.
- Rejecting a delete still requires the current absence/after state to match the
  expected deleted state before restoring before content.
- Accepting an OpenCode change must not overwrite unrelated current disk edits.
- Bulk `Reject All` must keep per-file conflict checks and skip unsafe files.
- Current disk mismatch should produce a conflict/manual warning, not a proof
  downgrade.

Suggested predicate split:

```ts
function isReviewSafe(change: ReviewSafetyContract): boolean {
  return isSnapshotReviewSafe(change)
}

function canExecuteReject(input: {
  change: ReviewSafetyContract
  currentDiskState: { exists: boolean; sha256?: string }
}): boolean {
  if (!isReviewSafe(input.change)) {
    return false
  }
  // Use the existing project helper here. This sketch only documents that
  // execution safety is a separate check from proof safety.
  return currentDiskMatchesExpectedAfterState(input.change, input.currentDiskState)
}
```

Do not implement `currentDiskMatchesExpectedAfterState` ad hoc if the project
already has a conflict/rejectability helper. This plan requires preserving that
existing behavior.

## Data Model Contract

Do not introduce a new task-change event shape unless absolutely necessary.
Prefer filling existing fields:

```ts
type UpgradedOpenCodeChangeContract = {
  sourceTool: 'write' | 'edit' | 'apply_patch' | 'snapshot_patch'
  sourceImportKey: string
  evidenceProof: 'opencode-snapshot' | 'inverse-edit-chain' | 'inverse-apply-patch-chain' | 'toolpart-chain'
  confidence: 'high' | 'exact'
  beforeContent: string | null
  afterContent: string | null
  beforeState: {
    exists?: boolean
    sha256?: string
    sizeBytes?: number
    unavailableReason?: never
  }
  afterState: {
    exists?: boolean
    sha256?: string
    sizeBytes?: number
    unavailableReason?: never
  }
  snapshotId?: string
  snapshotSource?: 'opencode'
  warnings: string[]
}
```

Important:

- Upgraded full-text events should not carry `unavailableReason` for the
  before/after side they claim to prove.
- Metadata-only events may carry `unavailableReason`, but then they must remain
  non-rejectable.
- `confidence: 'high'` is acceptable for snapshot proof. Use `exact` only for
  truly exact toolpart chains that already have local full text.
- `snapshotId` is useful provenance, but it is not required for safety if the
  proof was otherwise validated. Missing `snapshotId` should be diagnostic.

## Storage And Memory Contract

The feature must not create a second blob storage path or keep large full-text
content in memory longer than the existing ledger import requires.

Rules:

- Reuse the existing task-change ledger content storage.
- Do not duplicate before/after text in diagnostics, stats, or cache keys.
- Do not add per-team global caches of snapshot file content.
- Do not store both snapshot raw blobs and task-change blobs unless the existing
  snapshot reader already does that internally.
- Apply the per-file and total byte limits before materializing upgraded events.
- If a file exceeds the limit, store metadata-only state with a reason.
- If many small files exceed the total byte budget, skip the excess files as
  metadata-only instead of raising the limit.
- Stats should count bytes read and files skipped, but never include content.

Suggested stats additions:

```ts
type SnapshotProofStorageStats = {
  bytesRead: number
  bytesMaterialized: number
  skippedByByteLimit: number
  skippedByTotalBudget: number
}
```

Memory pressure is a reason to keep metadata-only fallback. It is not a reason
to increase limits or stream partial text into a diff.

## Mutation Rules

When an upgrade is skipped, only diagnostics may change. The returned
`ReconstructedOpenCodeToolChange` must preserve:

- `beforeContent`
- `afterContent`
- `beforeState`
- `afterState`
- `operation`
- `confidence`
- `warnings`
- `evidenceProof`
- `sourceImportKey`

When an upgrade succeeds, only these fields may change:

- `beforeContent`
- `afterContent`
- `beforeState`
- `afterState`
- `operation`, only when the tool semantics and snapshot operation both prove it
- `confidence`
- `warnings`, only through the central resolved-warning predicate
- `evidenceProof`
- `evidenceDiagnostics`
- `snapshotId`
- `snapshotSource`

No other fields should be rewritten by the proof upgrade. This reduces
accidental attribution changes.

## Proof Levels

Use explicit proof labels and keep their meaning strict.

```ts
type OpenCodeEvidenceProof =
  | 'toolpart-chain'
  | 'opencode-snapshot'
  | 'inverse-edit-chain'
  | 'inverse-apply-patch-chain'
  | 'metadata-only-fallback'
```

Accepted for auto review:

- `toolpart-chain`
- `opencode-snapshot`
- `inverse-edit-chain`
- `inverse-apply-patch-chain`

Not accepted for safe reject/apply:

- `metadata-only-fallback`
- current disk only
- file path metadata only
- hash without text
- text without matching task/window/path proof

## Proof Decision Tables

### Operation State Table

| Tool | Snapshot before | Snapshot after | Tool fields | Upgrade? | Reason |
| --- | --- | --- | --- | --- | --- |
| `write` create | absent | text | content absent or same as after | yes | create is fully proven |
| `write` modify | text | text | content absent or same as after | yes | before and after are fully proven |
| `write` modify | unavailable | text | any | no | overwrite baseline is unknown |
| `write` modify | text | text | content differs from after | no | toolpart and snapshot disagree |
| `edit` modify | text | text | old/new apply exactly once | yes | edit transition is proven |
| `edit` modify | text | text | old/new ambiguous | no | multiple valid transitions are possible |
| `apply_patch` modify | text | text | hunks verify exactly | yes | patch transition is proven |
| `apply_patch` modify | text | text | hunks missing | maybe | only if the snapshot window has exact single-file proof and no competing changes |
| delete | text | absent | delete operation | yes | delete is fully proven |
| any | binary/large/unavailable | any | any | no | full text is not available |

### Confidence Table

| Evidence | Confidence | Safe reject/apply? |
| --- | --- | --- |
| toolpart chain with known previous text | `exact` | yes |
| snapshot before/after with verified transition | `high` | yes |
| inverse edit/apply-patch chain with exact single replacements | `high` | yes |
| snapshot path anchor without verified transition | `medium` | no |
| metadata-only toolpart | `medium` | no |

Do not upgrade confidence from `medium` to `high` unless safe reject/apply would
also be valid.

## Proof State Machine

Implement the upgrade as a state machine, not as scattered conditionals.

```text
original change
  -> not eligible
  -> candidate
  -> snapshot evidence requested
  -> snapshot evidence matched
  -> transition verified
  -> upgraded change
  -> validated import candidate
```

Failure from any state returns to the original metadata-only change plus
diagnostics.

Allowed transitions:

| From | To | Required condition |
| --- | --- | --- |
| original | not eligible | not OpenCode, exact already, flag off, non-strict delivery |
| original | candidate | OpenCode unresolved change, strict delivery, flag permits |
| candidate | snapshot requested | non-empty touched path set within limits |
| snapshot requested | snapshot matched | exactly one window and one file anchor |
| snapshot matched | transition verified | operation-specific before/after proof succeeds |
| transition verified | upgraded | state hashes match content and warnings stripped safely |
| upgraded | validated import candidate | existing candidate validation accepts it |

Forbidden transitions:

- original -> upgraded
- candidate -> upgraded
- snapshot requested -> upgraded
- snapshot matched -> upgraded without operation-specific verification
- skipped -> upgraded

Suggested type:

```ts
type ProofState =
  | { state: 'not-eligible'; reason: SnapshotUpgradeDiagnosticCode }
  | { state: 'candidate'; change: ReconstructedOpenCodeToolChange }
  | { state: 'snapshot-matched'; change: ReconstructedOpenCodeToolChange; anchor: SnapshotFileAnchor }
  | { state: 'transition-verified'; change: ReconstructedOpenCodeToolChange; before: string | null; after: string | null }
  | { state: 'upgraded'; change: ReconstructedOpenCodeToolChange }
  | { state: 'skipped'; reason: SnapshotUpgradeDiagnosticCode; original: ReconstructedOpenCodeToolChange }
```

The concrete implementation does not have to use this exact union, but it
should preserve the same transitions.

## Exhaustiveness And Type Safety

Use exhaustive switches for proof decisions, operation handling, and feature
flag modes. Do not add a permissive `default` branch that silently preserves or
upgrades without naming the case.

```ts
function assertNever(value: never, context: string): never {
  throw new Error(`Unexpected ${context}: ${String(value)}`)
}

function applyProofDecision(
  decision: SnapshotProofDecision,
  original: ReconstructedOpenCodeToolChange,
): ReconstructedOpenCodeToolChange {
  switch (decision.type) {
    case 'upgraded':
      return decision.change
    case 'skipped':
      return original
    default:
      return assertNever(decision, 'snapshot proof decision')
  }
}
```

If TypeScript cannot prove exhaustiveness, keep the code more explicit rather
than using casts. A cast in proof code should be treated as a review smell.

## Default Answers To Uncertainty

Use these defaults when implementation hits an unclear case:

| Question | Default |
| --- | --- |
| Is attribution strict enough? | no upgrade |
| Is toolpart order stable? | no multi-change upgrade |
| Does snapshot text prove the operation? | no upgrade |
| Does warning removal feel broad? | preserve warning |
| Is content text or binary? | treat as unavailable |
| Does old event replacement behavior seem unclear? | new imports only |
| Is cache invalidation unclear? | do not rely on cache for proof |
| Does UI need an OpenCode-specific branch? | fix shared helper or stop |
| Is performance impact unclear? | keep flag off or single-change only |

These defaults are part of the safety design, not temporary indecision.

## Formal Proof Predicates

Implement proof decisions through small predicates that can be unit tested
directly. Avoid spreading equivalent checks across several branches.

```ts
function isReadableFullText(value: string | null | undefined): value is string {
  return typeof value === 'string'
}

function isKnownAbsent(state: { exists?: boolean } | undefined): boolean {
  return state?.exists === false
}

function hasUnavailableReason(state: { unavailableReason?: string } | undefined): boolean {
  return typeof state?.unavailableReason === 'string' && state.unavailableReason.length > 0
}

function isProvenCreate(change: ReviewSafetyContract): boolean {
  return (
    isKnownAbsent(change.beforeState) &&
    isReadableFullText(change.afterContent) &&
    !hasUnavailableReason(change.afterState)
  )
}

function isProvenModify(change: ReviewSafetyContract): boolean {
  return (
    isReadableFullText(change.beforeContent) &&
    isReadableFullText(change.afterContent) &&
    !hasUnavailableReason(change.beforeState) &&
    !hasUnavailableReason(change.afterState)
  )
}

function isProvenDelete(change: ReviewSafetyContract): boolean {
  return (
    isReadableFullText(change.beforeContent) &&
    change.afterState?.exists === false &&
    !hasUnavailableReason(change.beforeState)
  )
}

function isSnapshotReviewSafe(change: ReviewSafetyContract): boolean {
  return (
    change.evidenceProof === 'opencode-snapshot' ||
    change.evidenceProof === 'inverse-edit-chain' ||
    change.evidenceProof === 'inverse-apply-patch-chain' ||
    change.evidenceProof === 'toolpart-chain'
  ) && (
    isProvenCreate(change) ||
    isProvenModify(change) ||
    isProvenDelete(change)
  )
}
```

The real implementation can use existing helper names, but tests should cover
the predicates above as behavior. In particular, `unavailableReason` on a side
that claims full proof should make the change unsafe.

## Atomicity And Failure Semantics

Snapshot proof should behave atomically at three levels.

Per change:

- Success returns one upgraded change.
- Failure returns the original change unchanged plus diagnostics.
- No intermediate state should be visible to importer validation.

Per same-path chain:

- Success upgrades every unresolved change in the chain.
- Failure upgrades none of the unresolved changes in the chain.
- Already exact changes may remain exact, but they must not be rewritten by the
  failed chain attempt.

Per import batch:

- Candidate validation runs after proof upgrade.
- If import fails, review safety must not observe a partially imported safe
  state.
- Retry uses stable source import keys.

Implementation pattern:

```ts
const original = change
const decision = tryUpgradeChange(change)
if (decision.type === 'skipped') {
  diagnostics.push(decision.reason)
  return original
}
const upgraded = decision.change
if (!isSnapshotReviewSafe(upgraded)) {
  diagnostics.push('snapshot-upgrade-skipped/postcondition-failed')
  return original
}
return upgraded
```

Do not mutate `change` in place before postconditions pass.

## Postconditions

Every successful upgrade must satisfy these postconditions:

```ts
function assertUpgradePostconditions(input: {
  original: ReconstructedOpenCodeToolChange
  upgraded: ReconstructedOpenCodeToolChange
}): boolean {
  const { original, upgraded } = input
  return (
    original.sourceImportKey === upgraded.sourceImportKey &&
    original.taskId === upgraded.taskId &&
    original.teamName === upgraded.teamName &&
    original.memberName === upgraded.memberName &&
    original.sessionId === upgraded.sessionId &&
    original.sourcePartId === upgraded.sourcePartId &&
    original.sourceMessageId === upgraded.sourceMessageId &&
    original.relativePath === upgraded.relativePath &&
    upgraded.evidenceProof !== 'metadata-only-fallback' &&
    isSnapshotReviewSafe(upgraded)
  )
}
```

If a postcondition fails, keep the original change and emit a diagnostic. A
postcondition failure is a bug in proof logic, not a reason to relax safety.

## Runtime Assertion Policy

Assertions should catch programmer errors without making production data unsafe.

Rules:

- In tests, postcondition failures should fail loudly.
- In production backfill, postcondition failures should skip the upgrade,
  preserve the original metadata-only change, and emit a diagnostic.
- Assertions must never catch an error and continue with upgraded content.
- Assertions must not include file content in thrown messages.
- Assertions should include stable identifiers such as task id, source part id,
  source import key, and normalized relative path.

Suggested pattern:

```ts
function enforceUpgradePostconditions(input: {
  original: ReconstructedOpenCodeToolChange
  upgraded: ReconstructedOpenCodeToolChange
  diagnostics: string[]
}): ReconstructedOpenCodeToolChange {
  if (assertUpgradePostconditions(input)) {
    return input.upgraded
  }
  input.diagnostics.push(
    `snapshot-upgrade-skipped/postcondition-failed:${input.original.sourceImportKey}`,
  )
  return input.original
}
```

Do not use runtime assertions to justify looser proof predicates. Assertions are
a last guard, not the proof itself.

## Implementation Phases

### Phase 0 - Audit Contracts Before Behavior Changes

This phase should be completed before any runtime behavior change.

Audit:

- Ledger import behavior for duplicate `sourceImportKey`.
- Review bundle dedupe behavior.
- Existing rejectability helper.
- Existing OpenCode backfill cache and in-flight behavior.
- `materializeMetadataOnlyChanges` serialization of proof fields.
- Current real-data snapshot diagnostics for a few OpenCode teams.

Deliverable:

```text
Contract audit:
- sourceImportKey duplicate policy: replace | supersede | append | unknown
- review bundle dedupe key: ...
- rejectability helper: ...
- metadata materialization preserves proof fields: yes | no
- observed snapshot shape fingerprint: ...
- can proceed to Phase 1: yes | no
```

If any field is `unknown`, do not proceed to behavior changes.

### Phase 1 - Add Targeted Diagnostics

Add diagnostics that explain why a metadata-only change was not upgraded.
This makes real-data validation much easier.

Examples:

- `snapshot-upgrade-skipped/no-window`
- `snapshot-upgrade-skipped/ambiguous-window`
- `snapshot-upgrade-skipped/no-file-anchor`
- `snapshot-upgrade-skipped/binary`
- `snapshot-upgrade-skipped/too-large`
- `snapshot-upgrade-skipped/path-chain-ambiguous`
- `snapshot-upgrade-skipped/toolpart-after-mismatch`
- `snapshot-upgrade-skipped/current-disk-not-proof`
- `snapshot-upgrade-skipped/strict-delivery-required`
- `snapshot-upgrade-skipped/unsupported-snapshot-shape`
- `snapshot-upgrade-skipped/warning-preserved`
- `snapshot-upgrade-skipped/feature-flag-off`

These diagnostics should not be user-noisy by default, but they should be
available in backfill result diagnostics and tests.

Diagnostics should be structured internally even if the public result remains a
string array:

```ts
type SnapshotUpgradeDiagnosticCode =
  | 'snapshot-upgrade-skipped/no-window'
  | 'snapshot-upgrade-skipped/ambiguous-window'
  | 'snapshot-upgrade-skipped/no-file-anchor'
  | 'snapshot-upgrade-skipped/operation-mismatch'
  | 'snapshot-upgrade-skipped/toolpart-after-mismatch'
  | 'snapshot-upgrade-skipped/path-chain-ambiguous'
  | 'snapshot-upgrade-skipped/strict-delivery-required'
  | 'snapshot-upgrade-skipped/unsupported-snapshot-shape'

function pushSnapshotDiagnostic(
  diagnostics: string[],
  code: SnapshotUpgradeDiagnosticCode,
  detail: string,
): void {
  diagnostics.push(`${code}: ${detail}`)
}
```

Using a small typed union makes it harder to accidentally invent inconsistent
diagnostics throughout the proof code.

### Phase 2 - Make Upgrade Eligibility Explicit

Add a helper that decides whether a change needs snapshot proof. It should skip
already exact full-text changes.

```ts
function needsSnapshotProof(change: ReconstructedOpenCodeToolChange): boolean {
  if (change.evidenceProof === 'toolpart-chain') {
    return false
  }
  if (change.beforeContent !== null && change.afterContent !== null) {
    return false
  }
  if (change.beforeState?.exists === false && change.afterContent !== null) {
    return false
  }
  if (change.beforeContent !== null && change.afterState?.exists === false) {
    return false
  }
  return (
    change.sourceTool === 'write' ||
    change.sourceTool === 'edit' ||
    change.sourceTool === 'apply_patch' ||
    change.sourceTool === 'snapshot_patch'
  )
}
```

Use this helper before expensive snapshot work where possible:

```ts
const changesNeedingProof = params.changes.filter(needsSnapshotProof)
if (changesNeedingProof.length === 0) {
  return result
}
```

Important: this helper should reduce work, not reduce safety. If in doubt,
include a change in snapshot proof attempt and let the proof logic reject it.

Add a second helper for safety eligibility. It must be stricter than
`needsSnapshotProof`.

```ts
function mayUseSnapshotProof(input: {
  attributionMode: OpenCodeLedgerAttributionMode
  change: ReconstructedOpenCodeToolChange
  mode: SnapshotProofUpgradeMode
}): boolean {
  if (input.mode === 'off') {
    return false
  }
  if (input.attributionMode !== 'strict-delivery') {
    return false
  }
  if (!needsSnapshotProof(input.change)) {
    return false
  }
  return input.change.attributionMethod === 'delivery-ledger-taskrefs'
}
```

This keeps "should we spend time trying?" separate from "is this proof allowed
to affect review safety?".

Add a third helper for apply eligibility. `shadow` may compute proof, but must
not apply it.

```ts
function mayApplySnapshotProof(input: {
  mode: SnapshotProofUpgradeMode
  changeCountForPathWindow: number
}): boolean {
  if (input.mode === 'off' || input.mode === 'shadow') {
    return false
  }
  if (input.mode === 'single-change') {
    return input.changeCountForPathWindow === 1
  }
  return input.mode === 'full'
}
```

The call site should look structurally like this:

```ts
const decision = tryComputeSnapshotProof(change)
stats.record(decision)
if (!mayApplySnapshotProof({ mode, changeCountForPathWindow })) {
  return originalChange
}
return decision.type === 'upgraded' ? decision.change : originalChange
```

This prevents diagnostics-only validation from accidentally changing imported
review events.

Also make the final proof decision return a typed result instead of a nullable
change. Nullable returns tend to hide why an upgrade failed.

```ts
type SnapshotProofDecision =
  | {
      type: 'upgraded'
      change: ReconstructedOpenCodeToolChange
      proof: Exclude<OpenCodeEvidenceProof, 'metadata-only-fallback'>
    }
  | {
      type: 'skipped'
      reason: SnapshotUpgradeDiagnosticCode
      preserveOriginal: true
    }

function preserveOriginal(
  reason: SnapshotUpgradeDiagnosticCode,
): SnapshotProofDecision {
  return { type: 'skipped', reason, preserveOriginal: true }
}
```

Callers should be forced to handle both branches. A skipped decision must return
the original change unchanged except for diagnostics collected outside the
change object.

### Phase 3 - Strengthen Snapshot Anchor Matching

Snapshot anchors should be accepted only when all these conditions hold:

1. The change belongs to a strict delivery session.
2. The source toolpart belongs to exactly one snapshot window.
3. The snapshot window belongs to the same OpenCode message.
4. The normalized touched path is inside the session worktree.
5. The snapshot reader returns an anchor for the exact relative path.
6. Text content is full text, not binary, and within existing limits.
7. The file operation is compatible with the tool operation.

Add a small validation helper:

```ts
type SnapshotAnchorValidation =
  | { ok: true }
  | { ok: false; reason: string }

function validateSnapshotAnchorForChange(input: {
  change: ReconstructedOpenCodeToolChange
  anchor: SnapshotFileAnchor | undefined
}): SnapshotAnchorValidation {
  const { change, anchor } = input
  if (!anchor) {
    return { ok: false, reason: 'snapshot-upgrade-skipped/no-file-anchor' }
  }

  if (change.operation === 'create' && anchor.operation !== 'create') {
    return { ok: false, reason: 'snapshot-upgrade-skipped/operation-mismatch' }
  }

  if (change.operation === 'delete' && anchor.operation !== 'delete') {
    return { ok: false, reason: 'snapshot-upgrade-skipped/operation-mismatch' }
  }

  if (change.operation === 'modify' && anchor.operation === 'create') {
    return { ok: false, reason: 'snapshot-upgrade-skipped/operation-mismatch' }
  }

  return { ok: true }
}
```

Do not rely only on operation matching. It is a gate, not proof.

The validation helper should also distinguish these concepts:

- `anchor operation`: what the snapshot diff says happened to the file.
- `tool operation`: what the reconstructed toolpart thinks happened.
- `review operation`: what the imported task-change event will expose.

If these disagree, do not silently rewrite the operation unless the snapshot
transition and tool semantics both prove the new value. For example, a `write`
with no previous baseline may be reconstructed as `modify`; if snapshot says
`create` and before is absent, it may be upgraded to `create`. A reconstructed
`edit` must not become `create` or `delete`.

Add source identity checks before path checks:

```ts
function isSameSourceWindow(input: {
  change: ReconstructedOpenCodeToolChange
  windowMessageId: string
  windowId: string
  matchedWindowIds: string[]
}): boolean {
  return (
    input.change.sourceMessageId === input.windowMessageId &&
    input.matchedWindowIds.length === 1 &&
    input.matchedWindowIds[0] === input.windowId
  )
}
```

The exact data shape can differ, but the check must prove message-local and
single-window identity before using the snapshot file anchor.

### Phase 4 - Upgrade Single-Change Snapshot Proof

For one change touching a file within a snapshot window, upgrade directly if the
snapshot anchor proves the full transition.

Rules:

- `write` create:
  - accept when `beforeState.exists === false` and `afterContent` is full text.
  - if toolpart content exists, require it to equal snapshot after content.
- `write` modify:
  - accept when both snapshot before and after are full text.
  - if toolpart content exists, require it to equal snapshot after content.
- `edit` modify:
  - accept when both snapshot before and after are full text.
  - require applying `oldString -> newString` to before to equal after, unless the edit came from a verified snapshot patch.
- `apply_patch`:
  - accept when snapshot before and after are full text.
  - if parsed hunks exist, verify before-to-after application or inverse chain.
- delete:
  - accept when snapshot before is full text and snapshot after is absent.

For phase 4, do not support "maybe" `apply_patch` upgrades without parsed hunks.
Keep those for phase 5 or leave them metadata-only. This reduces the first
behavior change to the most provable cases.

Example helper:

```ts
function applyEditExactlyOnce(input: {
  before: string
  oldString: string | undefined
  newString: string | undefined
}): string | null {
  if (
    typeof input.oldString !== 'string' ||
    typeof input.newString !== 'string' ||
    input.oldString === input.newString
  ) {
    return null
  }
  if (countOccurrences(input.before, input.oldString) !== 1) {
    return null
  }
  return input.before.replace(input.oldString, input.newString)
}
```

Example upgrade:

```ts
function upgradeEditFromSnapshot(input: {
  change: ReconstructedOpenCodeToolChange
  anchor: SnapshotFileAnchor
}): ReconstructedOpenCodeToolChange | null {
  const before = input.anchor.beforeContent
  const after = input.anchor.afterContent
  if (typeof before !== 'string' || typeof after !== 'string') {
    return null
  }

  const applied = applyEditExactlyOnce({
    before,
    oldString: input.change.oldString,
    newString: input.change.newString,
  })
  if (applied !== after) {
    return null
  }

  return {
    ...input.change,
    beforeContent: before,
    afterContent: after,
    beforeState: contentStateForText(before),
    afterState: contentStateForText(after),
    confidence: 'high',
    evidenceProof: 'opencode-snapshot',
    snapshotId: input.anchor.snapshotId,
    snapshotSource: input.anchor.snapshotId ? 'opencode' : undefined,
    warnings: stripManualOnlyWarnings(input.change.warnings, input.anchor.warnings),
  }
}
```

Add a generic transition verifier so write/edit/apply_patch decisions share the
same state checks:

```ts
type VerifiedTransition =
  | { ok: true; beforeContent: string | null; afterContent: string | null; operation: 'create' | 'modify' | 'delete' }
  | { ok: false; reason: SnapshotUpgradeDiagnosticCode }

function verifySnapshotTransition(input: {
  change: ReconstructedOpenCodeToolChange
  anchor: SnapshotFileAnchor
}): VerifiedTransition {
  const before = input.anchor.beforeContent
  const after = input.anchor.afterContent

  if (input.anchor.operation === 'create') {
    return typeof after === 'string'
      ? { ok: true, beforeContent: null, afterContent: after, operation: 'create' }
      : { ok: false, reason: 'snapshot-upgrade-skipped/no-file-anchor' }
  }

  if (input.anchor.operation === 'delete') {
    return typeof before === 'string'
      ? { ok: true, beforeContent: before, afterContent: null, operation: 'delete' }
      : { ok: false, reason: 'snapshot-upgrade-skipped/no-file-anchor' }
  }

  if (typeof before !== 'string' || typeof after !== 'string') {
    return { ok: false, reason: 'snapshot-upgrade-skipped/no-file-anchor' }
  }

  return { ok: true, beforeContent: before, afterContent: after, operation: 'modify' }
}
```

This function should not be the final proof for `edit` or `apply_patch`. It only
proves that snapshot text exists for the operation state.

Before returning an upgraded change, verify the emitted states match the emitted
content:

```ts
function assertStateMatchesContent(input: {
  beforeContent: string | null
  afterContent: string | null
  beforeState: ReconstructedOpenCodeToolChange['beforeState']
  afterState: ReconstructedOpenCodeToolChange['afterState']
}): boolean {
  if (input.beforeContent !== null) {
    const expected = contentStateForText(input.beforeContent)
    if (input.beforeState?.sha256 !== expected.sha256) {
      return false
    }
  }
  if (input.afterContent !== null) {
    const expected = contentStateForText(input.afterContent)
    if (input.afterState?.sha256 !== expected.sha256) {
      return false
    }
  }
  return true
}
```

If this assertion fails, keep the original metadata-only change and emit a
diagnostic. Do not import inconsistent state/content.

### Phase 5 - Upgrade Multi-Change Same-Path Chains

When several changes touch the same file inside one snapshot window, only
upgrade if the whole chain verifies.

Algorithm:

1. Start from snapshot `afterContent`.
2. Walk changes for that path in reverse source order.
3. For each change:
   - if it already has full before/after, require its after to equal the cursor.
   - for `edit`, reverse `newString -> oldString` exactly once.
   - for `apply_patch`, reverse parsed hunks exactly once.
   - for `write`, only allow it as the first/oldest operation if snapshot before
     matches the previous state or known absent state.
4. If any step is ambiguous, stop and keep all unresolved warnings.
5. If the reverse chain reaches snapshot `beforeContent`, materialize
   replacements for every unresolved change in the chain.

Pseudo-code:

```ts
function upgradeSamePathChain(input: {
  changes: ReconstructedOpenCodeToolChange[]
  anchor: SnapshotFileAnchor
  diagnostics: string[]
}): Map<string, ReconstructedOpenCodeToolChange> {
  const replacements = new Map<string, ReconstructedOpenCodeToolChange>()
  let cursor = input.anchor.afterContent

  if (typeof cursor !== 'string') {
    input.diagnostics.push('snapshot-upgrade-skipped/no-after-anchor')
    return replacements
  }

  for (let index = input.changes.length - 1; index >= 0; index -= 1) {
    const change = input.changes[index]
    if (!change) {
      continue
    }

    const upgraded = reverseOneChangeFromAfter({ change, after: cursor, anchor: input.anchor })
    if (!upgraded) {
      input.diagnostics.push(`snapshot-upgrade-skipped/path-chain-ambiguous:${change.relativePath}`)
      return new Map()
    }

    replacements.set(change.sourceImportKey, upgraded.change)
    cursor = upgraded.beforeContent
  }

  if (typeof input.anchor.beforeContent === 'string' && cursor !== input.anchor.beforeContent) {
    input.diagnostics.push('snapshot-upgrade-skipped/path-chain-boundary-mismatch')
    return new Map()
  }

  return replacements
}
```

This is the highest-risk section. Keep tests dense here.

If there is any schedule pressure, defer this whole phase. Single-change
upgrades are enough to reduce many warnings and are much less risky.

Additional multi-change restrictions:

- Do not cross snapshot-window boundaries.
- Do not cross assistant-message boundaries.
- Do not cross task delivery boundaries.
- Do not mix changes with different `sourceMessageId`.
- Do not mix changes with different normalized `relativePath`.
- Do not include changes whose source import key is missing or duplicated.
- Do not upgrade a chain if any change in the path has an operation that cannot
  be reversed from the current cursor.
- Do not upgrade if the final reverse cursor does not exactly equal snapshot
  `beforeContent` for modify/delete, or known absence for create.

Add this explicit guard:

```ts
function assertSinglePathWindowChain(input: {
  changes: ReconstructedOpenCodeToolChange[]
}): boolean {
  const relativePaths = new Set(input.changes.map(change => change.relativePath))
  const messageIds = new Set(input.changes.map(change => change.sourceMessageId))
  const importKeys = new Set(input.changes.map(change => change.sourceImportKey))
  return (
    relativePaths.size === 1 &&
    messageIds.size === 1 &&
    importKeys.size === input.changes.length
  )
}
```

### Phase 6 - Warning Stripping Must Be Conservative

Only remove warnings that are made false by the new proof.

Safe to remove after verified before/after:

- `OpenCode edit was captured without a proven full-text baseline; apply/reject is manual-only.`
- `OpenCode write overwrote an existing file before the bridge had a known baseline; reject is manual-only.`
- `OpenCode apply_patch was captured without full before/after text; review is manual-only.`
- `OpenCode toolpart content was unavailable or too large; review is manual-only.`
- `full review depends on snapshot evidence`

Do not remove:

- attribution warnings
- low confidence task boundary warnings
- delivery context warnings
- path outside session directory warnings
- large/binary warnings for other files
- warnings attached to unrelated changes in the same task
- snapshot unavailable warnings attached to the same file
- any warning whose text is not in the known resolved warning predicate

Example:

```ts
function isResolvedByFullTextProof(warning: string): boolean {
  return (
    warning === 'OpenCode edit was captured without a proven full-text baseline; apply/reject is manual-only.' ||
    warning === 'OpenCode write overwrote an existing file before the bridge had a known baseline; reject is manual-only.' ||
    warning === 'OpenCode apply_patch was captured without full before/after text; review is manual-only.' ||
    warning === 'OpenCode toolpart content was unavailable or too large; review is manual-only.' ||
    warning.includes('full review depends on snapshot evidence')
  )
}

function stripManualOnlyWarnings(
  existing: string[] | undefined,
  snapshotWarnings: string[] | undefined,
): string[] {
  return [
    ...(existing ?? []).filter(warning => !isResolvedByFullTextProof(warning)),
    ...(snapshotWarnings ?? []),
  ].filter(Boolean)
}
```

If snapshot warnings contain unavailable content for this exact file, the change
should probably not have been upgraded. Add a test for that.

### Phase 7 - Preserve Performance Limits And Add Budgets

Do not increase these limits by default:

- `maxFiles: 100`
- `maxBytesPerTextFile: 1024 * 1024`
- `maxTotalBytes: 4 * 1024 * 1024`
- `timeoutMs: 3000`

Additional guard:

```ts
const unresolved = params.changes.filter(needsSnapshotProof)
if (unresolved.length === 0) {
  return result
}

const touchedRelativePaths = [...new Set(unresolved.map(change => change.relativePath))]
```

Do not pass already exact changes into `touchedRelativePaths` unless needed for
chain verification. This keeps snapshot reads narrow.

Add explicit performance budgets:

- A no-op backfill with no unresolved OpenCode changes should not invoke the
  snapshot reader.
- A strict-delivery task with one unresolved file should read one touched path.
- Snapshot proof attempt should record elapsed time in diagnostics when it
  exceeds 500 ms.
- More than two snapshot timeouts in a real-data smoke run blocks rollout.
- The broad real-data smoke should not increase total runtime by more than 10%
  compared with the baseline measured before the change.

Implementation sketch:

```ts
const startedAt = performance.now()
const snapshotResult = await readSnapshotEvidence()
const elapsedMs = performance.now() - startedAt
if (elapsedMs > 500) {
  diagnostics.push(`snapshot-upgrade-slow: ${Math.round(elapsedMs)}ms`)
}
```

Use the local runtime timing primitive already used in the orchestrator if
`performance.now()` is not available in that module.

Add a resource envelope for one backfill call:

```ts
type SnapshotProofResourceEnvelope = {
  maxSnapshotReadsPerBackfill: 10
  maxTouchedPathsPerRead: 100
  maxBytesPerTextFile: 1024 * 1024
  maxTotalBytesPerRead: 4 * 1024 * 1024
  maxElapsedMsPerRead: 3000
}
```

Do not add hidden retries that can multiply these limits. One failed or timed
out snapshot read should produce diagnostics and preserve metadata-only changes.

### Phase 8 - Idempotency And Existing Ledger Events

The upgrade may change the materialized content for a source event that was
previously imported as metadata-only. That needs a clear policy.

Preferred policy:

1. Keep `sourceImportKey` stable.
2. Let the existing ledger importer treat the upgraded event as the same source
   event, not a new file change.
3. If the importer is append-only and cannot update a previous event safely,
   do not attempt to rewrite old ledger data in this feature.
4. For new tasks, the upgraded evidence should be imported on the first backfill.
5. For old tasks, a re-backfill can show better evidence only if the existing
   ledger/import layer already supports replacing or superseding by source key.

Add a test for repeated backfill. It should not duplicate files in the review
bundle.

### Phase 9 - Desktop Contract Validation

This phase should not add new UI behavior unless tests expose a bug. It validates
that the upgraded events are already consumed safely.

Checklist:

- Full-text upgraded OpenCode event renders through the same path as Codex full-text diffs.
- Metadata-only OpenCode event still renders the warning banner.
- Mixed full-text and metadata-only task keeps per-file rejectability.
- `Reject All` skips metadata-only files.
- Current disk preview remains read-only context.
- Task summary warnings remain visible if attribution or boundary warnings remain.

If any item fails, fix the shared review safety helper rather than adding a
separate OpenCode-specific branch in the UI.

## Observability And Metrics

Add counters to diagnostics or existing debug output. They should be cheap and
safe to expose in test logs.

Suggested counters:

```ts
type SnapshotProofStats = {
  attemptedChanges: number
  upgradedChanges: number
  skippedChanges: number
  skippedByReason: Record<string, number>
  snapshotReadCount: number
  snapshotReadTimeouts: number
  snapshotReadElapsedMs: number
  touchedPathCount: number
  exactToolpartChainCount: number
  metadataOnlyFallbackCount: number
}
```

Use these stats in smoke output:

```text
OpenCode snapshot proof:
- attempted: 12
- upgraded: 7
- skipped: 5
- skipped/no-window: 2
- skipped/path-chain-ambiguous: 1
- skipped/too-large: 2
- snapshot reads: 3
- snapshot read time: 184ms
```

Metrics must not include file content or secrets. Paths are acceptable only if
the existing diagnostics already expose paths in the same context.

## Deterministic Output Comparison

Use deterministic fingerprints to compare `off`, `shadow`, and apply modes.
This catches accidental behavior changes that are hard to see in UI screenshots.

Suggested fingerprint input:

```ts
type ReviewBundleFingerprintInput = Array<{
  taskId: string
  relativePath: string
  sourceImportKey: string
  evidenceProof: string | undefined
  operation: string
  beforeSha256?: string
  afterSha256?: string
  warningCount: number
  rejectable: boolean
}>
```

Rules:

- `off` and `shadow` fingerprints must match except for diagnostics/stats.
- `single-change` may change OpenCode entries only.
- `full` may change OpenCode entries only.
- Non-OpenCode entries must have identical fingerprints in every mode.
- Fingerprints must not include raw file content.

If a mode comparison fails, inspect the structured diff before looking at UI.

## Cache And Re-Backfill Policy

The safest initial policy is:

- New backfills may import upgraded proof.
- Existing metadata-only events should not be rewritten unless the current
  importer already has a proven source-key replacement/supersede path.
- The desktop cache should not be globally invalidated.
- A task-specific refresh may re-read after successful OpenCode import.
- If cache behavior is unclear, tests should bypass cache and the rollout should
  leave old events unchanged.

Pseudo-policy:

```ts
type ExistingEventPolicy = 'new-imports-only' | 'supersede-by-source-key'

function chooseExistingEventPolicy(audit: {
  importerSupersedesBySourceKey: boolean
  reviewBundleDedupesBySourceKey: boolean
}): ExistingEventPolicy {
  return audit.importerSupersedesBySourceKey && audit.reviewBundleDedupesBySourceKey
    ? 'supersede-by-source-key'
    : 'new-imports-only'
}
```

Do not create a third policy that appends upgraded duplicates and relies on UI
filtering to hide the old event.

## Rollback Runbook

Rollback must be possible without data repair.

Immediate rollback:

```bash
OPENCODE_SNAPSHOT_PROOF_UPGRADE=off
```

Expected behavior after rollback:

- New OpenCode backfills return to previous metadata-only/manual-only behavior
  for cases without exact toolpart chains.
- Existing already-imported upgraded events remain valid historical full-text
  events. Do not delete them as part of rollback.
- No new upgraded events should be imported while the flag is off.
- Desktop review should continue to render previously imported full-text events.

If rollback is needed because upgraded duplicates were imported:

1. Do not add renderer-side filtering as a permanent fix.
2. Identify whether duplicates share `sourceImportKey`.
3. Fix importer/source-key dedupe.
4. Add a regression test with the duplicated event fixture.
5. Only then consider a one-off ledger cleanup, and only with explicit user
   approval.

If rollback is needed because of performance:

1. Keep diagnostics.
2. Disable proof upgrade.
3. Preserve exact `toolpart-chain` behavior.
4. Inspect snapshot read counters and touched path counts.
5. Re-enable only after reducing reads, not after raising limits.

## Implementation Slices

Prefer these slices even if the work lands in one PR. Each slice should compile
and have focused tests before the next slice starts.

1. Diagnostics only:
   - Add typed diagnostic codes.
   - Add stats object.
   - No behavior change.
2. Eligibility only:
   - Add feature flag parser.
   - Add `needsSnapshotProof` and `mayUseSnapshotProof`.
   - Prove `off` mode has no behavior change.
3. Shadow proof:
   - Compute proof decisions and stats.
   - Return original changes to importer.
   - Compare `shadow` and `off` outputs.
4. Single-change proof:
   - Implement formal predicates.
   - Implement create/modify/delete proof for one path/window/change.
   - Keep multi-change groups skipped.
5. Import/idempotency validation:
   - Verify source-key dedupe or choose `new-imports-only`.
   - Add repeated-backfill tests.
6. Desktop validation:
   - Verify shared rejectability consumes upgraded events safely.
   - No OpenCode-specific renderer branch unless a shared helper bug is found.
7. Multi-change proof:
   - Implement only after ordering contract tests pass.
   - Keep behind `full`.
8. Default enablement:
   - Enable `single-change` only after real-data smoke.
   - Enable `full` only in a separate rollout decision.

Stop points:

- It is acceptable to stop after slice 3 and ship only `shadow`.
- It is acceptable to stop after slice 4 and ship only `single-change`.
- It is acceptable to stop after diagnostics if real data shows unsupported
  snapshot shape.
- It is not acceptable to ship multi-change proof without real or synthetic
  chain coverage.

## Definition Of Done By Mode

### `off`

- No behavior change from current metadata-only/full-text decisions.
- Diagnostics may mention that the feature is disabled.
- Tests prove no upgraded event appears in this mode.

### `shadow`

Required before any apply mode can be default:

- Proof attempts run for eligible OpenCode changes.
- Importer receives the original change list.
- Stats include would-upgrade and skipped counts.
- No review diff, rejectability, warning, or file count changes.
- Real-data smoke shows non-OpenCode teams unchanged.
- Performance budget passes while proof is computed but not applied.

### `single-change`

Required before this mode can be default:

- Only one unresolved change for a path/window can upgrade.
- Multi-change path/window groups are skipped with diagnostics.
- `write` create/modify, `edit` modify, and delete cases have positive and
  negative tests.
- Non-OpenCode teams are unchanged in real-data smoke.
- Metadata-only count for OpenCode tasks decreases or stays equal.
- No duplicate review rows after repeated backfill.

### `full`

Required before this mode can be default:

- Every known unknown that blocks full mode is resolved.
- Same-path multi-change order is proven by tests.
- Chain upgrades are all-or-nothing for unresolved changes.
- Real-data smoke includes at least one actual multi-change chain or a synthetic
  fixture with equivalent shape.
- `full` mode can be disabled without changing code.
- A separate rollout decision enables `full`; it must not become default as a
  side effect of implementing single-change mode.

## Edge Case Matrix

### Attribution and Task Boundaries

- No delivery context:
  - Do not run strict snapshot upgrade.
  - Keep existing backfill skipped behavior.
- Delivery context exists but does not include the requested task:
  - Keep `no-attribution` behavior. Do not use compatible fallback for safe full-text.
- Compatible attribution mode:
  - Do not upgrade to auto-safe full text.
  - Reason: task ownership is not strict enough.
- Missing task start boundary:
  - Snapshot proof may prove file content, but task boundary warning remains.
- Estimated end boundary:
  - Snapshot proof may prove file content, but boundary warning remains.
- Same OpenCode session contains several tasks:
  - Only strict delivery records for the requested task are eligible.
- Same member touches same file for two tasks:
  - Do not merge changes across delivery windows.
- Multiple members share an OpenCode profile:
  - Require the delivery record member/lane/session match. Do not trust profile alone.
- Runtime delivery ledger was reset after launch:
  - No strict delivery context means no safe upgrade. Keep warnings.
- Delivery record has task refs but missing observed assistant message:
  - Do not use message-local snapshot proof unless the toolpart can still be
    tied to the delivered prompt through existing strict delivery matching.
- Delivery record has a pre-prompt cursor but no post-prompt cursor:
  - Keep strict-delivery matching conservative. Do not widen to the whole session.
- Task display id matches but canonical task id differs:
  - Use canonical task id for safe upgrades.

### Snapshot Windows

- No snapshot windows:
  - Keep metadata-only warning.
- Toolpart outside window:
  - Keep metadata-only warning.
- Toolpart matches multiple windows:
  - Keep metadata-only warning.
- Window has before hash but no after hash:
  - Keep metadata-only warning.
- Window has after hash but no before hash:
  - Allow create only if file absence is explicitly proven. Otherwise keep warning.
- Snapshot diff contains the path but operation is unknown:
  - Keep metadata-only warning.
- Snapshot diff includes more changed files than reconstructed toolparts:
  - Upgrade only exact reconstructed paths. Add diagnostic for extra snapshot paths.
- Snapshot diff misses a reconstructed path:
  - Keep that path metadata-only.
- OpenCode SQLite changed during read:
  - Existing transaction snapshot is okay, but add diagnostic.
- OpenCode schema changed:
  - Treat as unsupported history shape, no upgrade.
- Snapshot git store object is missing:
  - Keep metadata-only warning and include the store diagnostic.
- Snapshot git store read times out:
  - Keep metadata-only warning and include timeout diagnostic.
- Snapshot window hashes exist but git-store object is pruned:
  - Keep metadata-only warning and include retention diagnostic.
- Snapshot window hashes exist but point to an object from a different project:
  - Treat as workspace mismatch and skip.
- Snapshot window contains no reconstructed changes after path filtering:
  - Do not read files for that window.
- Snapshot reader returns duplicate entries for one relative path:
  - Treat as ambiguous and skip that path.
- Snapshot reader returns content for a path with different casing:
  - Use existing normalized comparison key. If identity is ambiguous, skip.
- Snapshot window is valid but OpenCode part JSON was truncated by our reader
  cap:
  - Treat affected toolparts as metadata-only. Do not combine partial part data
    with snapshot proof.
- Snapshot window contains changes from a tool type not modeled by this plan:
  - Keep those changes metadata-only until the tool type has explicit tests.

### File Content

- Text over size limit:
  - Keep warning with `too-large`.
- Binary or null-byte:
  - Keep warning with `binary`.
- Empty file:
  - Valid text content. Do not confuse empty string with unavailable.
- Missing file after delete:
  - Valid delete if before content is known.
- Missing file before create:
  - Valid create if after content is known.
- File exists before create operation:
  - Operation mismatch, no upgrade.
- File absent after modify operation:
  - Operation mismatch, no upgrade.
- Content normalizes differently by line endings:
  - Do not normalize for proof. Exact byte-equivalent UTF-8 text comparison is required.
- Content has invalid UTF-8:
  - Treat as binary/unavailable.
- Generated/minified text below limit:
  - It can be upgraded if full text is available, but review UI may still choose to collapse display.
- File mode-only changes:
  - Do not create a text diff upgrade unless text before/after also changed or mode changes are explicitly modeled.
- Very small binary file:
  - Size does not make it text. Binary detection still wins.
- UTF-16 or other non-UTF-8 text:
  - Treat as unavailable unless the existing snapshot reader explicitly decodes
    and hashes the exact same text representation used by review events.
- Secrets in file content:
  - Do not log content in diagnostics. Existing ledger storage rules apply to
    before/after blobs.
- Git LFS pointer file:
  - Treat the pointer text as the file content if that is what the snapshot
    contains. Do not dereference LFS objects.
- Sparse checkout missing working-tree file:
  - Irrelevant for proof. Snapshot evidence may still be valid, but execution
    safety must handle current disk conflict separately.
- Submodule path:
  - Do not read inside submodule git data unless existing snapshot reader
    explicitly models submodules. Treat as metadata-only otherwise.
- Permission denied reading snapshot object:
  - Keep metadata-only warning and include a permission diagnostic.

### Edit Semantics

- `oldString === newString`:
  - Skip as no-op as current code does.
- `oldString` missing:
  - Cannot prove edit from toolpart alone.
- `newString` missing:
  - Cannot prove edit from toolpart alone.
- `oldString` appears twice:
  - No upgrade unless snapshot chain proves exact transition through another trusted source.
- `newString` appears twice when reversing:
  - No inverse upgrade.
- Replacement creates same final content through multiple possible paths:
  - No upgrade.
- `replaceAll` or multi-replacement edit shape appears:
  - Do not upgrade until that tool shape is explicitly parsed and tested.
- Edit tool reports success but snapshot before does not contain `oldString`:
  - No upgrade.
- Edit tool reports success but snapshot after does not contain `newString`:
  - No upgrade unless the replacement legitimately deletes the string and the exact transition verifies.
- Empty `oldString`:
  - Do not upgrade. Empty search strings are ambiguous.
- Empty `newString`:
  - Valid deletion only when `oldString` occurs exactly once and snapshot after
    equals the deletion result.
- Overlapping replacements:
  - Do not upgrade unless exact before-to-after application has one valid path.

### Write Semantics

- Write creates new file:
  - Upgrade only if before absent and after content known.
- Write overwrites existing file:
  - Upgrade only if snapshot before and snapshot after are known.
- Toolpart content differs from snapshot after:
  - No upgrade.
- Toolpart content is truncated:
  - Snapshot can still prove after only if snapshot after is available and operation is fully verified.
  - Keep a diagnostic that toolpart content was truncated but snapshot proof was used.
- Existing file baseline unavailable:
  - Keep current warning.
- Write after earlier edit in the same path/window:
  - Treat as chain case. Do not single-change upgrade.
- Write followed by edit in the same path/window:
  - Treat as chain case. Single-change upgrade is not enough.
- Write content is available but snapshot after is unavailable:
  - Do not use toolpart content alone for existing-file overwrite baseline.
- Write content equals previous content:
  - It may be a no-op. Do not create a misleading modify diff unless snapshot
    shows a real text state transition or the review event model supports no-op
    changes explicitly.
- Write creates parent directories:
  - Only the file text is in scope. Directory creation is not a text proof.

### Apply Patch Semantics

- Patch text unavailable:
  - Snapshot can prove final file-level before/after only if window has exact path anchor.
- Parsed update hunks apply exactly once:
  - Allow inverse chain proof.
- Parsed hunks apply multiple places:
  - No upgrade.
- Patch creates/deletes file:
  - Verify operation with snapshot before/after states.
- Patch touches files not in metadata:
  - Add diagnostic and do not upgrade missing paths unless snapshot path proof is exact.
- Patch contains rename:
  - Do not upgrade as text modify unless rename support is explicitly modeled.
- Patch changes file mode only:
  - Keep metadata-only unless mode changes are supported by the review event schema.
- Patch contains CRLF-sensitive context:
  - Exact text verification is required. Do not line-ending-normalize.
- Patch partially applies in reverse:
  - No upgrade. All hunks must verify.
- Patch has context-only hunks:
  - Do not treat context as a change without before/after text proof.
- Patch deletes and recreates the same file in one patch:
  - Treat as ambiguous unless the parser explicitly models it and tests cover it.

### Paths and Workspaces

- Absolute paths outside workspace:
  - Reject upgrade.
- `..` path traversal:
  - Reject upgrade.
- Windows path separators:
  - Normalize, then validate.
- Symlink points outside workspace:
  - Do not read current disk. Snapshot git store path normalization should be trusted only for repository paths.
- Session directory is subdirectory:
  - Touched paths outside session directory get diagnostic. Do not let this alone prove or disprove content.
- Case-insensitive filesystem:
  - Use existing OpenCode path comparison helpers.
- Unicode normalization differences in file names:
  - Use existing normalized path keys. Do not add a second normalization scheme in this feature.
- Nested git repository inside workspace:
  - Verify snapshot identity against the OpenCode project worktree, not just the process cwd.
- Worktree moved after task:
  - Use recorded project identity. If workspace identity cannot be trusted, no upgrade.
- Workspace root is a symlink:
  - Use existing workspace comparison helpers. Do not add ad-hoc `realpath`
    behavior unless tests cover both symlinked and non-symlinked roots.
- File path contains newline or control characters:
  - Do not include raw path in diagnostics without escaping. Upgrade only if
    existing path normalization accepts it safely.
- Case-only rename:
  - Treat as rename/path operation, not a text modify, unless the review event
    schema explicitly models it.
- Path appears both as file and directory across before/after:
  - Keep metadata-only unless snapshot reader explicitly models the transition.

### Concurrency and Later Changes

- Current disk changed after task:
  - Irrelevant. Do not use current disk for proof.
- Another member changed same file after OpenCode task:
  - Snapshot proof remains historical. Review conflict detection must happen elsewhere.
- Backfill runs twice:
  - Source import keys must dedupe.
- Backfill interrupted:
  - Existing ledger import must remain idempotent.
- OpenCode host is still writing SQLite:
  - Rely on read-only transaction and existing fingerprint diagnostics. Do not retry aggressively.
- Two backfills run concurrently:
  - Existing in-flight dedupe should prevent duplicate desktop calls. The importer must still dedupe by source key.
- User manually edits a file while review is open:
  - Snapshot proof remains historical. Apply/reject conflict handling is outside this feature.
- Team is relaunched while backfill is running:
  - Use run/session identity from the delivery context. Do not merge new runtime
    sessions into the old task proof.
- Snapshot proof succeeds but ledger import fails:
  - Retry should be idempotent by source key. Diagnostics should not mark the
    task as safely upgraded until import succeeds.
- Snapshot store is pruned between capability check and file read:
  - Treat the read failure as metadata-only fallback. Do not retry from current disk.
- OpenCode writes a new assistant message while backfill reads SQLite:
  - Use the read-only transaction snapshot and existing fingerprint diagnostics.
    Do not merge later rows into the current proof attempt.
- SQLite WAL is corrupt or cannot be read:
  - Treat session history as unavailable/unsupported. Do not use partial rows for
    safe proof.
- OpenCode JSON row is malformed:
  - Skip that row and keep affected changes metadata-only. Do not infer from
    surrounding rows.

### UI And Review Semantics

- Full-text upgrade enables normal diff rendering only if the imported event has
  both safe baseline and safe target state.
- Metadata-only warnings should remain visible and should not be hidden by task
  summary aggregation.
- `Reject All` must still skip non-rejectable files.
- A task-level warning may remain even when all file diffs are full-text.
- A file-level warning may remain even when another file in the same task is upgraded.
- Do not change viewed-count behavior in this feature.
- Do not hide task cards solely because all OpenCode warnings were resolved.
- Do not change accept/reject button labels or statuses in this feature.
- Do not mark a file viewed just because snapshot proof succeeded.
- A file becoming review-safe does not mean reject execution must succeed if the
  user changed the worktree after the task.
- Conflict messaging for apply/reject should remain the existing shared
  behavior, not a new OpenCode-only message path.
- If a task card warning disappears because all file-level OpenCode baseline
  warnings were resolved, task-boundary and attribution warnings must still
  remain visible.
- The UI should not describe a snapshot-upgraded file as "guaranteed safe".
  It is "review-safe" or "full-text verified"; execution can still conflict.
- Do not add success toasts or celebratory messaging for proof upgrades. This is
  infrastructure, not a user-facing achievement.

### Security And Privacy

- Do not log before/after content.
- Do not include long snippets in diagnostics.
- Do not include raw paths with control characters in diagnostics.
- Do not include delivery payload text in proof stats.
- Do not expand file size limits for convenience.
- Do not add a new IPC path that exposes arbitrary snapshot reads.
- If a file is upgraded, it is stored through the existing task-change ledger
  content path. Do not add a second storage location.

### Serialization And Backward Compatibility

- Older desktop builds may see new diagnostics but should not require a new
  event schema to render metadata-only fallback.
- Missing `snapshotSource` should not crash review rendering.
- Missing `snapshotId` should not crash review rendering.
- Unknown `evidenceProof` values should be treated as unsafe by review safety
  helpers.
- JSON serialization must preserve empty string content.
- JSON serialization must distinguish absent file from empty file.
- Large content omitted by limits must serialize as unavailable state, not empty
  content.

## Test Plan

### Risk To Test Traceability

| Risk | Required test/smoke |
| --- | --- |
| Cross-task contamination | real-data smoke with at least two tasks in one OpenCode session |
| Cross-member contamination | fixture with shared profile but different member/lane |
| Wrong snapshot window | unit test with overlapping windows and outside-window toolpart |
| False baseline from current disk | unit test proving current disk is never consulted |
| Unsafe warning removal | unit test with unrelated `manual-only` warning preserved |
| Duplicate imported events | repeated-backfill bridge test |
| Performance regression | smoke budget with snapshot read counters |
| Unsupported OpenCode shape | snapshot provider unsupported-shape test |
| Mixed safe/unsafe task | desktop integration test for `Reject All` skipping metadata-only |
| Cache stale result | bridge or desktop worker test bypassing/invalidating cache deliberately |
| Capability false positive | fixture with snapshot enabled but missing store object |
| Shadow mode mutation | fingerprint comparison between `off` and `shadow` |
| Snapshot retention loss | fixture where window exists but object read fails |
| Execution conflict bypass | desktop/review test where current disk differs from expected after |
| Memory/storage blowup | fixture with many small files exceeding total byte budget |
| Malformed OpenCode rows | offline reader/reconstructor fixture with malformed part JSON |

### Negative Control Fixtures

Negative controls are cases that look close to valid proof but must not upgrade.

Required negative controls:

- Same file path, same member, but different task id.
- Same task id, same file path, but different member/lane.
- Same session and file path, but toolpart outside the snapshot window.
- Snapshot before/after text exists, but `oldString` occurs twice.
- Snapshot after equals toolpart content, but before is unavailable.
- Snapshot path matches, but operation is rename or mode-only.
- Current disk matches expected after, but snapshot before is missing.
- `shadow` computes an upgrade decision, but imported fingerprint matches `off`.
- Existing metadata-only event appears before upgraded event with same source key.
- Unknown `evidenceProof` appears in imported data.

Each negative control should assert both behavior and diagnostic reason. A
negative control without a reason is hard to debug and easy to regress.

### Golden Fixture Coverage Matrix

Maintain a small set of golden fixtures that cover the supported state space.

| Fixture | Mode | Expected |
| --- | --- | --- |
| write-create-text | `single-change` | upgraded create |
| write-modify-text | `single-change` | upgraded modify |
| edit-modify-once | `single-change` | upgraded modify |
| delete-text | `single-change` | upgraded delete |
| duplicate-old-string | `single-change` | metadata-only |
| missing-before | `single-change` | metadata-only |
| toolpart-outside-window | `single-change` | metadata-only |
| shadow-valid-edit | `shadow` | would-upgrade stats, original import |
| non-opencode-task | all modes | unchanged fingerprint |
| missing-snapshot-object | all apply modes | metadata-only |
| multi-change-chain | `single-change` | skipped |
| multi-change-chain | `full` | upgraded only if chain verifies |

Golden fixtures should be tiny and deterministic. They should not depend on
wall-clock time, filesystem case behavior, or the user's current worktree.

### Unit Tests

Add or extend `OpenCodeChangeEvidenceEnricher.test.ts`.

Tests:

1. Upgrades metadata-only edit from exact snapshot before/after.
2. Does not upgrade edit when `oldString` appears twice.
3. Does not upgrade edit when snapshot after does not equal applied result.
4. Upgrades write create with before absent and after text.
5. Upgrades write modify when toolpart content equals snapshot after.
6. Does not upgrade write modify when toolpart content differs from snapshot after.
7. Upgrades delete with before text and after absent.
8. Does not remove attribution warnings after content proof.
9. Keeps manual-only warning when anchor has unavailable before/after content.
10. Multi-edit same-path chain upgrades only when the whole chain verifies.
11. Multi-edit same-path chain keeps all metadata-only fallbacks when one step is ambiguous.
12. Snapshot provider unavailable keeps current behavior.
13. Does not remove unrelated `manual-only` warning text.
14. Keeps task boundary warnings after successful content proof.
15. Does not upgrade compatible attribution mode.
16. Does not upgrade when feature flag is `off`.
17. Single-change mode skips multi-change chain upgrade.
18. Empty file create and empty file modify are handled as valid text.
19. CRLF/LF mismatch fails proof instead of normalizing.
20. Duplicate source import keys block chain upgrade.
21. Empty `newString` deletion upgrades only with exact single occurrence.
22. Empty `oldString` never upgrades.
23. State hashes must match emitted full text.
24. Snapshot anchor duplicate path entry skips upgrade.
25. `write` no-op does not create a misleading diff.
26. Skipped proof preserves the original change object fields.
27. Successful proof mutates only allowed fields.
28. Snapshot proof decision returns typed skipped reason, not `null`.
29. Unsupported snapshot shape never upgrades.
30. Existing-event policy defaults to `new-imports-only` when dedupe is unknown.
31. State machine cannot jump from candidate to upgraded without transition verification.
32. Unstable part order blocks multi-change upgrade.
33. Unknown `evidenceProof` is unsafe in review safety helper.
34. Empty string survives materialization and serialization.
35. Absent file is not serialized as empty file.
36. `shadow` mode computes proof stats but returns original changes.
37. `mayApplySnapshotProof` blocks multi-change groups in `single-change`.
38. Exhaustive switches fail compilation when a new mode/proof decision is not handled.
39. Capability success is required before snapshot proof attempt.
40. Missing snapshot git-store object keeps metadata-only fallback.
41. `off` and `shadow` review bundle fingerprints match.
42. Non-OpenCode fingerprints are identical across all modes.
43. Review-safe upgraded change still fails reject execution when current disk mismatches expected after.
44. Total byte budget skips excess files as metadata-only.
45. Malformed OpenCode part JSON cannot produce upgraded proof.
46. LFS pointer text is not dereferenced.
47. Submodule paths stay metadata-only unless explicitly modeled.
48. Runtime postcondition failure preserves original metadata-only change.
49. Every golden fixture has a paired negative control.
50. Minimum safe scope excludes unsupported operation shapes.

Example fixture shape:

```ts
const change: ReconstructedOpenCodeToolChange = {
  taskId: 'task-1',
  taskRef: 'task-1',
  taskRefKind: 'canonical',
  teamName: 'team',
  memberName: 'alice',
  sessionId: 'session',
  assistantMessageId: 'message-1',
  toolUseId: 'tool-1',
  sourcePartId: 'part-1',
  sourceMessageId: 'message-1',
  sourceTool: 'edit',
  sourceImportKey: 'session:part-1:src/app.ts',
  filePath: '/workspace/src/app.ts',
  relativePath: 'src/app.ts',
  beforeContent: null,
  afterContent: null,
  operation: 'modify',
  confidence: 'medium',
  attributionMethod: 'delivery-ledger-taskrefs',
  oldString: 'const value = 1',
  newString: 'const value = 2',
  beforeState: { exists: true, unavailableReason: 'opencode-edit-baseline-not-captured' },
  afterState: { exists: true, unavailableReason: 'opencode-edit-final-content-unavailable' },
  evidenceProof: 'metadata-only-fallback',
  warnings: ['OpenCode edit was captured without a proven full-text baseline; apply/reject is manual-only.'],
  timestamp: new Date(0).toISOString(),
}
```

### Synthetic Fixture Schema

Use a compact fixture builder so edge cases do not depend entirely on live
OpenCode data.

```ts
type SnapshotProofFixture = {
  name: string
  mode: SnapshotProofUpgradeMode
  attributionMode: OpenCodeLedgerAttributionMode
  delivery: {
    teamName: string
    taskId: string
    memberName: string
    laneId?: string
    sessionId: string
    assistantMessageId: string
  }
  windows: Array<{
    messageId: string
    windowId: string
    fromSnapshot: string
    toSnapshot: string
    startPartOrder: number
    finishPartOrder: number
  }>
  parts: Array<{
    partId: string
    messageId: string
    order: number
    tool: 'write' | 'edit' | 'apply_patch'
    filePath: string
    oldString?: string
    newString?: string
    content?: string
  }>
  snapshotFiles: Array<{
    relativePath: string
    beforeContent?: string
    afterContent?: string
    beforeExists: boolean
    afterExists: boolean
  }>
  expected: {
    upgraded: number
    metadataOnly: number
    diagnostics: string[]
  }
}
```

Fixture rules:

- Every positive fixture needs a paired negative fixture that differs by one
  proof condition.
- Fixtures should prefer tiny strings so failures are easy to inspect.
- Fixtures must include at least one empty string case and one absent-file case.
- Fixtures must include one path with unsafe characters for diagnostics escaping.
- Fixtures must not include secrets or large blobs.

### Snapshot Provider Tests

Extend `OpenCodeSnapshotEvidenceProvider.test.ts`.

Tests:

1. Groups only unresolved proof-needed changes into touched paths.
2. Emits diagnostic for missing window.
3. Emits diagnostic for ambiguous window.
4. Preserves existing limits.
5. Does not read snapshot for unrelated exact changes.
6. Does not match windows across assistant messages.
7. Emits diagnostic for extra snapshot paths not in reconstructed toolparts.
8. Emits timeout diagnostic while preserving metadata-only fallback.
9. Does not read snapshot windows with no unresolved touched paths.
10. Escapes unsafe path text in diagnostics.

### Ledger Bridge Tests

Extend `OpenCodeLedgerBridgeService` tests or add a focused fixture test.

Tests:

1. Backfill imports upgraded full-text event for strict delivery OpenCode edit.
2. Backfill keeps metadata-only event for compatible attribution.
3. Backfill keeps metadata-only event with no delivery context.
4. Imported event has stable source import key and dedupes on rerun.
5. `snapshotShapeFingerprint` is present when snapshot proof was used.
6. Repeated backfill does not duplicate file entries.
7. Old metadata-only imported event is not rewritten unless importer already supports superseding by source key.
8. Snapshot proof is not attempted for Codex or Anthropic members.
9. Snapshot proof is not attempted for OpenCode exact `toolpart-chain` changes.
10. Backfill cache does not return stale metadata-only data after an upgraded import in the same test.
11. Import failure leaves no partial safe-review state.

### Desktop Integration Tests

Only if needed. The desktop review UI already handles full text and metadata-only.

Smoke check:

1. Full-text OpenCode upgraded event renders a real diff.
2. Metadata-only event still renders manual-only warning.
3. Reject is enabled only for full-text safe baseline.
4. Warnings remain visible for task boundary uncertainty.
5. `Reject All` skips a mixed task where one OpenCode file upgraded and another stayed metadata-only.
6. Current disk preview remains read-only and does not become a reject baseline.
7. Viewed count is unchanged by proof upgrade.
8. Task-level boundary warning remains visible after all file diffs upgrade.
9. Reject execution still blocks when current disk no longer matches the expected
   after state.
10. Bulk `Reject All` rejects only files that pass both review-safety and
    execution-safety checks.

### Property-Like Tests

Add small table-driven tests for transition verification:

```ts
const editCases = [
  { name: 'single replacement', before: 'a = 1', oldString: '1', newString: '2', after: 'a = 2', ok: true },
  { name: 'duplicate old', before: 'a 1 b 1', oldString: '1', newString: '2', after: 'a 2 b 1', ok: false },
  { name: 'empty old', before: 'abc', oldString: '', newString: 'x', after: 'xabc', ok: false },
  { name: 'delete exactly once', before: 'abc', oldString: 'b', newString: '', after: 'ac', ok: true },
]
```

The point is not random fuzzing. The point is to make ambiguous replacement
rules explicit and hard to regress.

### Real Data Smoke

Before implementation, capture a baseline:

```bash
time pnpm test --run test/main/services/team/TaskChangeComputer.test.ts
time pnpm test --run test/main/services/team/ChangeExtractorService.test.ts
```

After implementation, run the same commands:

```bash
pnpm test --run test/main/services/team/TaskChangeComputer.test.ts
pnpm test --run test/main/services/team/ChangeExtractorService.test.ts
```

Then run the existing real-data smoke scripts used for task changes. Required
checks:

- `errors: 0`
- no increase in item errors
- no cross-task file leakage
- no increase in metadata-only count for OpenCode tasks
- no change for Codex-only teams
- no change for Anthropic-only teams
- broad smoke runtime increase <= 10%
- snapshot timeout count <= 2
- upgraded OpenCode full-text count is explainable by diagnostics
- no decrease in task-boundary warnings unless task-boundary code changed separately
- `off` and `shadow` fingerprints match except diagnostics/stats
- non-OpenCode fingerprints match in all modes

Manual target cases:

- `relay-works-3/#1f735bea`
- `relay-works-3/#bf01e5c3`
- `relay-works-3/#43e6b9b0` should remain Codex-related, not OpenCode-upgraded
- `signal-ops-22` should remain unaffected because it has no OpenCode members
- any OpenCode team with real `snapshotShapeFingerprint` present in diagnostics
- one team with missing/reset delivery ledger, if available

Add at least one synthetic OpenCode snapshot fixture if real data lacks a clean
single-change full-text snapshot case. Real data validates integration, but a
synthetic fixture is better for precise edge cases.

Real-data smoke should compare before/after summaries:

```text
Before:
- OpenCode metadata-only file changes: N
- OpenCode full-text file changes: M
- non-OpenCode full-text file changes: X
- task-boundary warnings: B

After:
- OpenCode metadata-only file changes: <= N
- OpenCode full-text file changes: >= M
- non-OpenCode full-text file changes: X
- task-boundary warnings: B
```

Any non-OpenCode count change is a blocker.

### Failure Injection Tests

Add targeted failure injection where practical:

- Snapshot provider throws.
- Snapshot provider times out.
- Snapshot provider returns duplicate path entries.
- Ledger importer rejects the batch.
- Backfill runs twice with the same source import key.
- Feature flag changes from `single-change` to `off`.
- Snapshot proof succeeds for one file and fails for another file in the same task.

Expected result for every failure injection: original metadata-only safety is
preserved, no duplicate review rows, diagnostics explain the skip/failure.

### Serialization Tests

Add tests around the task-change event materialization boundary:

- `beforeContent: ''` remains empty string.
- `afterContent: ''` remains empty string.
- `beforeContent: null` remains unavailable/absent according to state.
- Unknown `evidenceProof` does not make a file rejectable.
- Snapshot fields survive import/export if present.
- Snapshot fields may be absent without renderer crashes.

### Manual QA Runbook

Manual QA is not a substitute for tests, but it helps catch integration mistakes.

Prepare:

1. Pick one OpenCode team with snapshot evidence.
2. Pick one Codex-only or Anthropic-only team.
3. Record before counts for:
   - OpenCode metadata-only files.
   - OpenCode full-text files.
   - non-OpenCode full-text files.
   - task-boundary warnings.
   - snapshot proof diagnostics.

Run with `off`:

```bash
OPENCODE_SNAPSHOT_PROOF_UPGRADE=off pnpm test --run test/main/services/team/TaskChangeComputer.test.ts
```

Expected:

- No new upgraded OpenCode snapshot events.
- Existing exact toolpart-chain behavior unchanged.

Run with `shadow`:

```bash
OPENCODE_SNAPSHOT_PROOF_UPGRADE=shadow pnpm test --run test/main/services/team/TaskChangeComputer.test.ts
```

Expected:

- Snapshot proof stats are emitted.
- Would-upgrade counts are visible.
- Imported/reviewed changes are identical to `off`.
- Any difference from `off` outside diagnostics is a blocker.

Run with `single-change`:

```bash
OPENCODE_SNAPSHOT_PROOF_UPGRADE=single-change pnpm test --run test/main/services/team/TaskChangeComputer.test.ts
```

Expected:

- OpenCode full-text count may increase.
- OpenCode metadata-only count may decrease or stay equal.
- non-OpenCode counts are unchanged.
- Multi-change groups are skipped with diagnostics.

Run with `full` only after tests pass:

```bash
OPENCODE_SNAPSHOT_PROOF_UPGRADE=full pnpm test --run test/main/services/team/TaskChangeComputer.test.ts
```

Expected:

- Same guarantees as `single-change`.
- Multi-change upgrades appear only when diagnostics can explain the full chain.

UI spot check:

- Open a mixed task with one upgraded file and one metadata-only file.
- Verify the upgraded file shows a diff.
- Verify the metadata-only file still shows a warning.
- Verify `Reject All` skips metadata-only files.
- Verify current disk preview is not treated as baseline.
- Verify task boundary warnings remain if present.

Any mismatch is a blocker.

## Acceptance Criteria

The implementation is acceptable only if all are true:

- OpenCode-only behavior changed.
- Strict delivery remains required for snapshot full-text upgrades.
- Exact existing `toolpart-chain` behavior is unchanged.
- Metadata-only fallback still works.
- No current disk content is used as historical proof.
- No broad OpenCode session scan is introduced.
- Snapshot read limits are unchanged or narrower.
- Ambiguous chains keep warnings.
- Large and binary files keep warnings.
- Tests cover same-path multi-change chains.
- Real-data smoke shows no cross-task leakage.
- Feature flag can disable the upgrade.
- Repeated backfill does not duplicate review files.
- Warning removal is limited to known resolved warning predicates.
- Performance budgets pass.
- The implementation has an explicit fallback for unsupported OpenCode snapshot shapes.
- The implementation includes Phase 0 contract audit notes in the PR/commit
  description or test output.
- No warning is removed unless a unit test names that exact warning or predicate.
- No current-disk preview path is involved in a proof decision.
- No behavior change occurs when `OPENCODE_SNAPSHOT_PROOF_UPGRADE=off`.
- Smoke output includes attempted/upgraded/skipped counts.
- Full mode is not enabled while any known unknown remains unresolved.
- Existing metadata-only events are not rewritten unless source-key supersede is
  proven by tests.
- Cache behavior is documented in the Phase 0 audit.
- Composite proof identity is enforced before snapshot text is trusted.
- Toolpart ordering is explicitly verified before multi-change upgrades.
- `single-change` and `full` have separate definitions of done.
- Serialization preserves empty string versus absent file.
- `shadow` mode proves expected upgrades without changing imported review events.
- Exhaustive handling covers every proof decision and feature flag mode.
- Capability gates are checked per session, not inferred from config alone.
- Missing/pruned snapshot store objects preserve metadata-only fallback.
- Deterministic fingerprints prove non-OpenCode behavior is unchanged.
- Apply/reject execution safety still checks current disk state after review
  proof succeeds.
- Storage and memory budgets are enforced without duplicate blob storage.
- Malformed/truncated OpenCode rows cannot produce upgraded proof.
- First apply rollout stays within the minimum safe scope.
- Negative controls prove close-but-invalid cases remain metadata-only.
- Runtime postcondition failures preserve original changes.

## Verification Command Matrix

Use the narrowest useful commands first, then broader smoke.

| Layer | Command or check | Required result |
| --- | --- | --- |
| Typecheck | `pnpm typecheck` | passes |
| Enricher unit | targeted `OpenCodeChangeEvidenceEnricher` tests | passes |
| Snapshot provider | targeted `OpenCodeSnapshotEvidenceProvider` tests | passes |
| Ledger bridge | targeted `OpenCodeLedgerBridgeService` tests | passes |
| Desktop review safety | targeted review/rejectability tests | passes |
| Off mode | task-change tests with `OPENCODE_SNAPSHOT_PROOF_UPGRADE=off` | old behavior |
| Shadow mode | task-change tests with `OPENCODE_SNAPSHOT_PROOF_UPGRADE=shadow` | stats only |
| Single-change mode | task-change tests with `OPENCODE_SNAPSHOT_PROOF_UPGRADE=single-change` | only one-change upgrades |
| Full mode | task-change tests with `OPENCODE_SNAPSHOT_PROOF_UPGRADE=full` | only after chain tests |
| Real data | existing task-change smoke on OpenCode and non-OpenCode teams | no leakage |

Do not use `full` smoke as a substitute for single-change smoke. They prove
different safety boundaries.

## Code Review Checklist

Use this checklist before merging the implementation:

- Every upgraded change has a non-`metadata-only-fallback` proof.
- Every upgraded modify has both `beforeContent` and `afterContent`.
- Every upgraded create has `beforeState.exists === false` and `afterContent`.
- Every upgraded delete has `beforeContent` and `afterState.exists === false`.
- State hashes match emitted content.
- No branch reads current disk as proof.
- No branch catches an error and upgrades anyway.
- Every skipped branch preserves the original change.
- Warning stripping uses a central predicate.
- Multi-change mode can be disabled independently.
- Snapshot reader limits are unchanged or narrower.
- Tests include at least one negative case for every positive upgrade case.
- Real-data smoke includes at least one OpenCode team and one non-OpenCode team.
- No new IPC or filesystem read path bypasses existing workspace trust checks.
- No content appears in diagnostics, metrics, or thrown error messages.
- `off` mode is covered by a test and is easy to use during rollback.
- The proof logic is structured so forbidden state transitions are not possible
  without an obvious code review smell.
- `shadow` mode has been run on real data before any apply mode is enabled.
- Any new union member requires an exhaustive switch update, not a permissive
  default branch.
- Review-safe and execution-safe are checked separately.
- Large-file and total-byte budget tests prove metadata-only fallback.
- Minimum safe scope is visible in code structure, not only in tests.
- Negative controls exist for task, member, window, baseline, and operation
  mismatch.

## Implementation Anti-Patterns

Do not implement the feature using these patterns:

- A broad `try/catch` that returns an upgraded change on partial data.
- Mutating the original change object in place before proof has succeeded.
- Removing warnings before the final proof decision.
- Reading current disk to fill `beforeContent`.
- Comparing normalized line endings for proof.
- Treating a matching hash as content.
- Creating OpenCode-specific rejectability logic in the renderer.
- Appending upgraded duplicate events and expecting UI sorting to hide stale ones.
- Increasing snapshot limits to make a test pass.
- Falling back from strict delivery to compatible attribution for safety.
- Adding `full` mode as the default in the same change that introduces it.
- Treating empty string as missing content.
- Treating missing content as empty string.
- Sorting same-path chains by only one field.
- Retrying snapshot reads in a loop without a budget.
- Treating review-safe as automatically execution-safe.
- Adding a second blob store or cache for before/after content.
- Dereferencing Git LFS or submodule content outside the existing snapshot reader.
- Using malformed partial OpenCode JSON rows as proof context.
- Expanding the first apply mode to unsupported operations because the snapshot
  text happens to be available.
- Hiding uncertainty by changing user-facing wording from warning to success.

## Rollout Strategy

1. Land diagnostics and helper functions with no behavior change if practical.
2. Add the feature flag with default `off` in tests where needed.
3. Add snapshot-first upgrade for single-change same-path cases.
4. Run targeted tests and real-data smoke.
5. Enable `single-change` mode for local smoke.
6. Add multi-change chain upgrade only after tests are solid.
7. Move to `full` mode only if multi-change smoke is clean.
8. Inspect warnings before and after for OpenCode tasks.

If multi-change support looks risky during implementation, stop after
single-change mode. Single-change upgrade is already useful and lower risk.

Recommended shipping sequence:

```text
PR 1: diagnostics + eligibility helpers + no behavior change
PR 2: single-change snapshot proof upgrade behind flag
PR 3: enable single-change by default for OpenCode strict delivery
PR 4: multi-change chain upgrade behind flag
PR 5: enable full mode only after real-data smoke
```

If this stays as one PR, keep the same commit structure locally and verify each
step before moving to the next one.

## Abort Conditions

Do not continue implementation if any of these happens:

- Snapshot windows cannot be reliably matched to toolparts.
- Existing OpenCode snapshot shape differs from tests in real data.
- Real-data smoke shows any new cross-task file leakage.
- Performance smoke shows repeated timeouts.
- A change would require using current disk as proof.
- A change would require broad compatible attribution scanning.
- Warning stripping needs broad substring matching to pass tests.
- Multi-change support requires accepting ambiguous edit/apply-patch replacements.
- Source import key dedupe behavior is unclear.
- The only available validation is manual UI inspection.
- A test has to assert against current wall-clock timing without a stable budget.
- Formal proof predicates require exceptions to support the first implementation.
- Postconditions fail for any positive fixture.
- `single-change` mode needs multi-change assumptions to pass.
- `full` mode needs renderer-specific special cases to appear safe.
- Rollback with `OPENCODE_SNAPSHOT_PROOF_UPGRADE=off` does not restore old
  behavior for new backfills.
- Empty content and missing content cannot be distinguished at serialization.

## Open Questions Template For Implementation PR

Every implementation PR should answer these in its description:

```text
OpenCode snapshot proof PR checklist:
- Mode implemented: diagnostics | single-change | full
- Default mode:
- Phase 0 contract audit completed: yes | no
- Source import key duplicate policy:
- Review bundle dedupe key:
- Rejectability helper:
- Existing event policy: new-imports-only | supersede-by-source-key
- Snapshot shape fingerprint observed:
- Real-data teams tested:
- Non-OpenCode teams unchanged: yes | no
- Snapshot proof stats:
- Rollback tested with OPENCODE_SNAPSHOT_PROOF_UPGRADE=off: yes | no
- Known unknowns remaining:
```

If the PR cannot answer one of these, it should not enable new behavior by
default.

## Example Final Change Shape

Before upgrade, metadata-only edit:

```json
{
  "sourceTool": "edit",
  "before": {
    "exists": true,
    "unavailableReason": "opencode-edit-baseline-not-captured"
  },
  "after": {
    "exists": true,
    "unavailableReason": "opencode-edit-final-content-unavailable"
  },
  "evidenceProof": "metadata-only-fallback",
  "warnings": [
    "OpenCode edit was captured without a proven full-text baseline; apply/reject is manual-only."
  ]
}
```

After verified snapshot upgrade:

```json
{
  "sourceTool": "edit",
  "before": {
    "exists": true,
    "sha256": "before-hash",
    "sizeBytes": 128
  },
  "after": {
    "exists": true,
    "sha256": "after-hash",
    "sizeBytes": 128
  },
  "evidenceProof": "opencode-snapshot",
  "snapshotSource": "opencode",
  "warnings": []
}
```

If any proof check fails, the event must stay in the first shape.

## Notes for Future Maintainers

The important invariant is not "fewer warnings". The invariant is "warnings are
removed only when the system has stronger evidence than before".

Warnings are correct when historical full text is not proven. A warning is a
better outcome than an unsafe reject button.
