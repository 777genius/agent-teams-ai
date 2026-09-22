# Diff View Feature — Full Audit Report

Date: 2026-02-26
Verified: 2026-02-26 (4 parallel agents cross-checked every bug against actual source code)

Comprehensive audit of the changes/diff viewing feature covering line count reliability,
hunk parsing, stat-to-hunk consistency, and UI rendering.

---

## Architecture Overview

The app uses **two distinct diff strategies**:

1. **Chat Viewer Diffs** (read-only, simple display):
   - `DiffViewer.tsx` — custom LCS-based line-by-line diff
   - Pure string comparison, NO hunk structure

2. **Team Review Diffs** (interactive, hunk-aware):
   - CodeMirror Merge plugin (`@codemirror/merge`)
   - `ReviewDiffContent.tsx` — uses `diffLines` from `diff` package
   - `CodeMirrorDiffView.tsx` — full merge view with hunk navigation
   - `ReviewApplierService.ts` — applies/rejects hunks to disk

### Three independent stat computation paths:

| Service | Algorithm | Used For |
|---------|-----------|----------|
| `ChangeExtractorService` | `diffLines()` from npm `diff` | Team member changes (file badges) |
| `MemberStatsComputer` | `split('\n').length` arithmetic | Session analytics |
| `FileContentResolver` | `diffLines()` from npm `diff` | Full file content diffs (CodeMirror) |

---

## Evaluation Summary

| # | Bug | Real? | Confidence | Status |
|---|-----|-------|------------|--------|
| 1 | Two conflicting line-counting methods | **YES** | 9/10 | Open |
| 2 | Write never counts removals | **YES** | 10/10 | Open |
| 3 | Trailing newline off-by-one | **PARTIAL** | 6/10 | Resolves with #1 |
| 4 | FileContentResolver overwrites stats | **PARTIAL** | 5/10 | Design issue |
| 5 | computeHunkIndexAtPos → 0 fallback | **YES** | 10/10 | Open |
| 6 | Hunk ≠ snippet mapping | **YES** | 9/10 | Open |
| 7 | indexOf duplicates in rejection | **YES** | 10/10 | Open |
| 8 | Skeleton flash after save | **FIXED** | 9/10 | Done |
| 9 | CRLF → false diffs | **YES** | 9/10 | Open |
| 10 | OOM on large files (LCS) | **YES** | 8/10 | Open |
| 11 | Race condition disk vs cache | **YES** | 8/10 | Open |
| 12 | Empty string inconsistency | **YES** | 7/10 | Resolves with #1 |
| 13 | Bash estimation ~30-40% | **PARTIAL** | 6/10 | Design limitation |
| 14 | Echo escape handling wrong | **YES** | 8/10 | Open |
| 15 | portionCollapse edge case | **PARTIAL** | 5/10 | Needs testing |
| 16 | No-newline-at-EOF hidden | **YES** | 8/10 | Open |
| 17 | Three-way merge labels | **NO** | 9/10 | False positive |
| 18 | Zero-change files invisible | **YES** | 8/10 | Open |
| 19 | Viewed threshold mismatch | **YES** | 9/10 | Open |
| 20 | useEffect no deps array | **YES** | 10/10 | Open |
| 21 | Hunk count ≠ snippet count | **YES** | 8/10 | Open |
| 22 | Toolbar off-screen narrow viewport | **YES** | 7/10 | Open |
| 23 | Deleted files not marked | **YES** | 8/10 | Open |
| 24 | write-update reconstruction null | **YES** | 9/10 | Open |
| 25 | Bash relative paths | **YES** | 9/10 | Open |
| 26 | Empty line → space | **YES** | 7/10 | Open |
| 27 | No keyboard nav in tree | **YES** | 8/10 | Feature |
| 28 | Collapse state not persisted | **YES** | 9/10 | Open |
| 29 | No stats summary | **NO** | 3/10 | Feature request |
| 30 | Binary files not detected | **YES** | 8/10 | Open |
| 31 | No max file size | **YES** | 7/10 | Open |
| 32 | Whitespace changes not distinguished | **PARTIAL** | 6/10 | Optional feature |

**Totals**: 24 real bugs, 3 false positives (#4, #17, #29), 5 partial/design (#3, #13, #15, #32, #4), 1 fixed (#8)

---

## CRITICAL BUGS

### 1. Two Conflicting Line-Counting Methods

**Real bug: YES — Confidence: 9/10**

**Impact**: Line count badges in file tree may not match actual hunks in editor.

**Details**:
- `ChangeExtractorService` (`src/main/services/team/ChangeExtractorService.ts:463-473`) uses `diffLines()` — semantic line diffing
- `MemberStatsComputer` (`src/main/services/team/MemberStatsComputer.ts:193-196`) uses naive `split('\n').length` — `newLines - oldLines`

Example divergence:
```
File: 10 lines rewritten completely (same line count)
diffLines(): added=10, removed=10  (correct — all lines changed)
split arithmetic: added=0, removed=0  (wrong — same line count)
```

**Best fix**: Create unified line-counting utility using `diffLines()` as source of truth. Replace `MemberStatsComputer`'s arithmetic with shared utility.
**Risk**: Line count numbers will change post-fix; must test edge cases.

### 2. Write Operations Never Count Removals

**Real bug: YES — Confidence: 10/10**

**Location**: `MemberStatsComputer.ts:204-214`

```typescript
if (toolName === 'Write') {
  const writeContent = typeof input.content === 'string' ? input.content : '';
  if (writeContent) {
    const fileAdded = writeContent.split('\n').length;
    linesAdded += fileAdded;
    addFileLines(input.file_path, fileAdded, 0);  // Always 0 removals!
  }
}
```

**Impact**: Write replacing 100-line file with 50-line file shows `+50 / -0` instead of accurate counts.

**Best fix**: Use `FileContentResolver` to access original state before Write, calculate true delta.
**Risk**: Requires coordination with FileContentResolver; may introduce coupling.

### 3. Trailing Newline Off-by-One

**Real bug: PARTIAL — Confidence: 6/10**

Resolves automatically when #1 is fixed (migration to `diffLines()`). Within MemberStatsComputer's own logic, the delta arithmetic is roughly self-consistent (both old and new over-count by 1, so the difference is correct). The issue is only visible when comparing MemberStatsComputer output against ChangeExtractorService output.

### 4. FileContentResolver Overwrites Stats

**Real bug: PARTIAL (design issue) — Confidence: 5/10**

`FileContentResolver.getFileContent()` recalculates stats from full content using `diffLines()`, overwriting input stats. This is actually MORE ACCURATE than snippet-based counts. The "overwrite" is intentional improvement, not a bug. The inconsistency is that file tree badges (pre-CM load) use snippet counts, while CodeMirror view uses recalculated counts.

**Verdict**: Not a code bug. Design choice with minor visual inconsistency during loading.

### 5. `computeHunkIndexAtPos` Returns 0 as Fallback

**Real bug: YES — Confidence: 10/10**

**Location**: `CodeMirrorDiffView.tsx:129-143`

```typescript
function computeHunkIndexAtPos(state: EditorState, pos: number): number {
  const chunks = getChunks(state);
  if (!chunks) return 0;
  let index = 0;
  for (const chunk of chunks.chunks) {
    if (pos >= chunk.fromB && pos <= chunk.toB) {
      return index;
    }
    index++;
  }
  return 0;  // ← Always returns first hunk if no match!
}
```

**Impact**: Clicking Accept/Reject when cursor is between hunks applies action to the FIRST hunk, not the nearest one. Confirmed: callers at lines 416-420 and 432-435 trust this value unconditionally.

**Best fix**: Find nearest chunk by minimum distance: `Math.min(|pos - chunk.fromB|, |pos - chunk.toB|)` for each chunk, return index of nearest.
**Alternative**: Return -1 for "no match" and require caller handling.
**Risk**: Need tie-breaking rule when cursor is equidistant from two chunks.

### 6. Hunk Index ≠ Snippet Index (False 1:1 Assumption)

**Real bug: YES — Confidence: 9/10**

**Location**: `ReviewApplierService.ts:337-342`

```typescript
const snippetsToReject = hunkIndices
  .filter((idx) => idx >= 0 && idx < validSnippets.length)
  .map((idx) => validSnippets[idx]);
```

**Problem**: Assumes hunk #N corresponds to snippet #N. But:
- Multiple Edit calls can merge into one hunk in structuredPatch
- One Write call can produce multiple hunks
- MultiEdit creates 1 snippet with multiple logical changes

**Best fix**: Build hunk-to-snippet mapping using position matching. For each hunk, find snippets whose newString appears in that hunk region. Store `hunkIndex -> Set<snippetIndices>`.
**Risk**: Complex implementation, requires re-running diff analysis.

### 7. Snippet Rejection via indexOf — Duplicate Content Bug

**Real bug: YES — Confidence: 10/10**

**Location**: `ReviewApplierService.ts:353`

```typescript
const pos = content.indexOf(snippet.newString);
```

`indexOf()` finds FIRST occurrence only. If identical code patterns exist elsewhere in the file, rejection corrupts the wrong section.

**Best fix**: Position-aware matching: calculate approximate line/column of original edit, search for newString near that position (±5 lines tolerance), require context match.
**Risk**: More complex logic, false negatives if context too strict.

### 8. Skeleton Flash After File Save — FIXED

**Location**: `changeReviewSlice.ts:649-666`

After saving, `fileContents[filePath]` was deleted from cache, causing `hasContent = false` → skeleton placeholder shown until lazy re-fetch completes.

**Fix applied**: Instead of deleting, update `modifiedFullContent` with saved content in-place. `contentSource` set to `'disk-current'`.

---

## HIGH PRIORITY BUGS

### 9. CRLF Line Endings → False Diffs

**Real bug: YES — Confidence: 9/10**

**Location**: `DiffViewer.tsx:297`

```typescript
const oldLines = oldString.split('\n');
```

Windows files with `\r\n` leave trailing `\r` on each line. Every line shows as "changed" even if content is identical.

**Fix**: Use `split(/\r?\n/)` or normalize before diffing.
**Risk**: Very low. Standard regex, no side effects.

### 10. OOM on Large Files (DiffViewer LCS)

**Real bug: YES — Confidence: 8/10**

**Location**: `DiffViewer.tsx:50-68`

LCS algorithm is O(m×n) space. Two 5000-line files = 25M matrix entries ≈ 100MB RAM.
No safeguards, no fallback for large files.

**Best fix**: Add size check: if `m * n > MAX_CELLS` (e.g., 1M), fallback to `diffLines()` from npm `diff` package.
**Risk**: Fallback produces different visual output (semantic vs LCS). Need to test.

### 11. Race Condition: File Disk State vs Cache

**Real bug: YES — Confidence: 8/10**

Stats and hunks come from SEPARATE sources:
- Stats: JSONL tool_use blocks (snapshot at parse time)
- Hunks: current file on disk (read at view time)

3-minute cache TTL on both `ChangeExtractorService` and `FileContentResolver`.
If file changes on disk between fetches, stats and hunks desynchronize.

**No cache invalidation** on FileWatcher events → caches stay stale until TTL expires.

**Best fix**: Hook FileWatcher to evict caches when files change. Or reduce TTL to 30s.
**Risk**: Must ensure invalidation doesn't create new race conditions.

### 12. Empty String Handling Inconsistency

**Real bug: YES — Confidence: 7/10**

**Location**: `MemberStatsComputer.ts:193`

Empty string `''` is falsy → returns 0. But `''.split('\n').length === 1`.

**Resolves with #1** — migrating to `diffLines()` handles this correctly.

### 13. Bash Line Estimation Covers ~30-40% of Patterns

**Real bug: PARTIAL — Confidence: 6/10**

**Location**: `MemberStatsComputer.ts:314-416`

**Verdict**: Fundamental limitation, not a code bug. The JSONL only stores command strings, not execution output. Without running the shell, accurate counting is impossible. Code comments acknowledge this. Best approach: document limitation in UI with tooltip.

### 14. Echo Escape Sequence Handling Wrong

**Real bug: YES — Confidence: 8/10**

**Location**: `MemberStatsComputer.ts:371`

```typescript
added += content.split('\\n').length;
```

Splits on literal `\\n` in quoted string. But `echo "line1\nline2"` does NOT expand `\n` without `-e` flag. Counter is wrong for standard echo.

**Best fix**: Check for `-e` flag before splitting on `\\n`. Without `-e`, treat as single line.
**Risk**: Hacky logic, any change may break other cases. Conservative: don't count echo lines at all.

---

## MEDIUM PRIORITY BUGS

### 15. portionCollapse Line Position Edge Case

**Real bug: PARTIAL — Confidence: 5/10**

**Location**: `portionCollapse.ts:140`

Rare edge case at exact line boundaries. Needs unit tests with edge cases to confirm.
**Verdict**: Low probability, needs testing before fixing.

### 16. No-Newline-At-End-Of-File Not Shown

**Real bug: YES — Confidence: 8/10**

**Location**: `ReviewDiffContent.tsx:46-48`

```typescript
const lines = part.value.replace(/\n$/, '').split('\n');
```

Strips trailing newline. If original has no final newline but modified adds one, diff shows them as identical.

**Best fix**: Add visual indicator for no-newline-at-EOF.
**Risk**: Need to update rendering without breaking existing layout.

### 17. Three-Way Merge Labels Confusing — FALSE POSITIVE

**Confidence: 9/10 that this is NOT a bug**

Labels correctly follow diff3 semantics: `<<<<<<< current` = disk state, `>>>>>>> original` = pre-change state. This is standard and correct. The audit was wrong.

### 18. Zero-Change Files Invisible

**Real bug: YES — Confidence: 8/10**

**Location**: `ChangeStatsBadge.tsx`

```typescript
if (linesAdded === 0 && linesRemoved === 0) return null;
```

Files modified with equal adds/removes (e.g., 5 lines rewritten) show no badge. Missing `modified` boolean flag.

**Best fix**: Add `modified: boolean` flag to `FileChangeSummary`. Show neutral badge for zero-net-change files.
**Risk**: Requires data structure change, but straightforward.

### 19. Viewed File Threshold Mismatch

**Real bug: YES — Confidence: 9/10**

- `FileSectionDiff.tsx`: `threshold: 0.85`
- `CodeMirrorDiffView.tsx`: `threshold: 1.0`

**Best fix**: Standardize on 0.85 everywhere. One-line change.
**Risk**: None.

### 20. Missing Dependency Array in useEffect

**Real bug: YES — Confidence: 10/10**

**Location**: `FileSectionDiff.tsx:50-56`

```typescript
useEffect(() => {
  if (localEditorViewRef.current) {
    onEditorViewReady(file.filePath, localEditorViewRef.current);
  }
});  // ← No dependency array! Runs EVERY render.
```

**Best fix**: Add `[file.filePath, onEditorViewReady]` dependency array.
**Risk**: Low. Need to ensure `onEditorViewReady` is memoized with useCallback.

### 21. Hunk Counts Mismatch in UI

**Real bug: YES — Confidence: 8/10**

`snippets.length` used as fallback before CodeMirror loads, then replaced by `chunks.length`. User sees progress jump (e.g., "1 of 1" → "1 of 5").

**Best fix**: Pre-compute chunk count from `diffLines()` at load time, not from snippet count.
**Risk**: Medium — adds computation step, but improves correctness.

### 22. Merge Toolbar Off-Screen in Narrow Viewport

**Real bug: YES — Confidence: 7/10**

Buttons at `insetInlineEnd: '8px'` get clipped in narrow viewports.

**Best fix**: CSS-only: use `insetInlineStart` or add `maxWidth: '100%'` overflow handling.
**Risk**: None. CSS-only change.

### 23. Deleted Files Not Marked

**Real bug: YES — Confidence: 8/10**

No `isDeleted` flag in `FileChangeSummary`. Deleted files show as regular changes.

**Best fix**: Add `isDeleted: boolean` field. Set when original has content and modified is empty.
**Risk**: Medium — requires data structure change.

### 24. Snippet Reconstruction Returns null for Write-Update

**Real bug: YES — Confidence: 9/10**

**Location**: `FileContentResolver.ts:392-394`

`write-update` can't be reconstructed because JSONL doesn't include `oldString`. Falls back to disk-current which may differ from actual original.

**Best fix**: Store original content when detecting write-update during extraction.
**Risk**: Medium — requires data structure enrichment.

### 25. Bash Relative Paths Not Captured

**Real bug: YES — Confidence: 9/10**

**Location**: `MemberStatsComputer.ts:373-376`

Only captures absolute paths (`startsWith('/')`). Misses relative paths.

**Best fix**: Remove `startsWith('/')` check, just validate non-empty string.
**Risk**: Very low. 1-line fix.

---

## LOW PRIORITY

### 26. DiffViewer Empty Line Rendering

**Real bug: YES — Confidence: 7/10**

```typescript
{line.content || ' '}
```

Empty lines show as single space. Can't distinguish from space-only lines.

**Best fix**: `{line.content ?? ' '}` (only use space if truly undefined).
**Risk**: None. 1-line fix.

### 27. No Keyboard Navigation in File Tree

**Real bug: YES — Confidence: 8/10**

Mouse-only navigation. No WAI-ARIA tree widget support.

**Verdict**: UX feature, ~150 LOC. Not a correctness bug.

### 28. Folder Collapse State Not Persisted

**Real bug: YES — Confidence: 9/10**

State lost on dialog close. Uses `useState` with fresh `Set()`.

**Best fix**: Persist to localStorage or Zustand store.
**Risk**: Low-medium. localStorage has size limits but file tree data is tiny.

### 29. No Diff Stats Summary at Top — FALSE POSITIVE

**Confidence: 3/10 that this is a bug**

Missing feature, not a bug. File-by-file stats are visible. Aggregate summary would be nice UX but isn't a correctness issue.

### 30. Binary Files Not Detected

**Real bug: YES — Confidence: 8/10**

`diffLines()` called on binary content without check. Can cause corrupted display.

**Best fix**: Check for null bytes (`content.includes('\0')`) before diffing. Skip binary files.
**Risk**: Very low. Simple guard.

### 31. No Maximum File Size Handling

**Real bug: YES — Confidence: 7/10**

No progress indicator for large files. Browser freezes for 2-3s on 1MB+ files.

**Best fix**: Add size check, show "file too large" fallback for >5MB.
**Risk**: Low. Graceful degradation.

### 32. Whitespace-Only Changes Not Distinguished

**Real bug: PARTIAL — Confidence: 6/10**

No visual distinction between content vs whitespace-only changes.

**Verdict**: Optional enhancement. Add `ignoreWhitespace` toggle. Not a correctness bug.

---

## Race Condition Severity Matrix

| Scenario | Probability | Severity |
|----------|-------------|----------|
| Disk modification between stat cache and hunk fetch | Medium | High |
| File deletion after stats cached | Low-Medium | High |
| JSONL appended while parsing | Low | Medium |
| Git repo state change (checkout, rebase) | Low | Medium |
| Snippet reconstruction chain broken | Medium | High |

---

## Fix Categories

### Safe to Fix Now (isolated, low-risk, clear approach)
- **#5**: computeHunkIndexAtPos → nearest hunk (local function change)
- **#9**: CRLF normalization `split(/\r?\n/)` (1-line regex change)
- **#19**: Threshold 0.85 vs 1.0 → standardize (1-line constant)
- **#20**: useEffect dependency array (1-line addition)
- **#25**: Bash relative paths (remove `startsWith('/')` check)
- **#26**: Empty line rendering (`||` → `??`)

### Need More Research Before Fixing (multi-file, complex, risky)
- **#1**: Unify line counting (affects 3 services, all consumers)
- **#2**: Write removals (needs original file content during stats)
- **#6**: Hunk↔snippet mapping (algorithm redesign)
- **#7**: indexOf → position-aware matching (could break existing logic)
- **#10**: OOM safeguard (need to test fallback visual consistency)
- **#11**: Cache invalidation (FileWatcher integration complexity)
- **#23**: Deleted files flag (data structure change, migration)
- **#24**: write-update reconstruction (data enrichment needed)

### Feature Requests / Won't Fix
- **#13**: Bash estimation — fundamental limitation
- **#17**: Three-way labels — NOT a bug
- **#27**: Keyboard nav — UX feature
- **#29**: Stats summary — UX feature
- **#32**: Whitespace toggle — optional enhancement

---

## Key Files Reference

| File | Role |
|------|------|
| `src/main/services/team/ChangeExtractorService.ts` | Parses JSONL, aggregates per-file changes |
| `src/main/services/team/MemberStatsComputer.ts` | Session analytics, line counting |
| `src/main/services/team/FileContentResolver.ts` | Full file content resolution |
| `src/main/services/team/ReviewApplierService.ts` | Apply/reject hunks, save files |
| `src/renderer/components/chat/viewers/DiffViewer.tsx` | Simple LCS diff viewer |
| `src/renderer/components/team/review/CodeMirrorDiffView.tsx` | Advanced CodeMirror merge view |
| `src/renderer/components/team/review/ReviewDiffContent.tsx` | Fallback snippet-based diff |
| `src/renderer/components/team/review/FileSectionDiff.tsx` | Diff section wrapper |
| `src/renderer/components/team/review/FileSectionHeader.tsx` | File header with Save button |
| `src/renderer/components/team/review/ContinuousScrollView.tsx` | Scroll container, skeleton logic |
| `src/renderer/components/team/review/portionCollapse.ts` | Smart collapse of unchanged regions |
| `src/renderer/components/team/review/ReviewFileTree.tsx` | File tree with stats badges |
| `src/renderer/store/slices/changeReviewSlice.ts` | Store: file contents, save, decisions |
| `src/renderer/hooks/useDiffNavigation.ts` | Keyboard navigation between hunks |
| `src/shared/types/review.ts` | Shared types: FileChangeSummary, FileChangeWithContent |
