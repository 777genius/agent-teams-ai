# Diff View — Detailed Fix Plans from Deep Research

Date: 2026-02-26
Source: 4 parallel research agents analyzing actual source code

---

## Fix #11: Cache TTL 3min → 30sec

**Confidence: 10/10**
**Effort: 2 lines**

### Files to Change

1. `src/main/services/team/ChangeExtractorService.ts:40`
```typescript
// OLD
private readonly CACHE_TTL = 3 * 60 * 1000; // 3 мин

// NEW
private readonly CACHE_TTL = 30 * 1000; // 30 sec
```

2. `src/main/services/team/FileContentResolver.ts:32`
```typescript
// OLD
private readonly cacheTtl = 3 * 60 * 1000; // 3 мин

// NEW
private readonly cacheTtl = 30 * 1000; // 30 sec
```

### Cache Architecture Details

Both services use `Map<string, CacheEntry>` with TTL:
- `ChangeExtractorService`: key = `${teamName}:${memberName}`, stores `AgentChangeSet` + `mtime` + `expiresAt`
- `FileContentResolver`: key = file path, stores `original | modified | source` + `expiresAt`
- `ChangeExtractorService` stores file `mtime` but NEVER uses it for validation
- `FileContentResolver` has `invalidateFile(filePath)` but only called in ONE place: `review.ts:265` after save

### FileWatcher Coverage

FileWatcher ALREADY watches the right directories:
- `~/.claude/projects/` (JSONL session files)
- `~/.claude/todos/` (todo JSON files)
- `~/.claude/teams/` (team config files)
- `~/.claude/tasks/` (task JSON files)

But NO service-level cache invalidation hooks exist beyond the single `invalidateFile()` call.

### Thundering Herd Risk: NONE

- Each cache entry expires independently, staggered by client refresh timing
- 30sec = 120 cache refreshes/hour per user, negligible CPU
- Each team member has separate cache key; concurrent misses don't cascade

### Future Phase (Optional): FileWatcher Integration

Would require:
1. Add `ChangeExtractorService` and `FileContentResolver` to ServiceContext
2. Wire FileWatcher events to precise cache invalidation
3. Map `${teamName}:${memberName}` cache keys to affected files
4. Complex wiring, not worth it until TTL proves insufficient

---

## Fix #10: OOM Safeguard for DiffViewer LCS

**Confidence: 9/10**
**Effort: ~30 LOC**

### Memory Analysis

LCS matrix: `(m+1) × (n+1)` entries, each number = ~8 bytes in V8:
- 1000×1000 = 1M entries ≈ 8MB ✓ Safe
- 3000×3000 = 9M entries ≈ 72MB ⚠️ Manageable
- 5000×5000 = 25M entries ≈ 200MB ✗ Dangerous
- 10000×10000 = 100M entries ≈ 800MB ✗ OOM

**Recommended threshold: `MAX_CELLS = 1_000_000`** (~1000×1000 lines)

### `diffLines()` Return Format

From npm `diff` package:
```typescript
Array<{
  value: string;       // The actual line(s) + newline
  count?: number;      // Number of lines
  added?: boolean;     // true = new lines
  removed?: boolean;   // true = removed lines
  // If neither added/removed: unchanged context lines
}>
```

### DiffLine Type (DiffViewer)

```typescript
interface DiffLine {
  type: 'removed' | 'added' | 'context';
  content: string;
  lineNumber: number;
}
```

### Implementation

**Import to add** (DiffViewer.tsx top):
```typescript
import { diffLines as semanticDiffLines } from 'diff';
```

**New constant**:
```typescript
/** Max LCS matrix cells before falling back to semantic diff.
 *  1M cells ≈ 8MB RAM — safe for all platforms. */
const MAX_LCS_CELLS = 1_000_000;
```

**Fallback function**:
```typescript
/**
 * Fallback diff using semantic line-diffing from npm `diff` package.
 * Used when LCS matrix would exceed memory threshold.
 * Output format matches LCS-based generateDiff().
 */
function generateDiffFallback(oldLines: string[], newLines: string[]): DiffLine[] {
  const oldText = oldLines.join('\n');
  const newText = newLines.join('\n');
  const changes = semanticDiffLines(oldText, newText);

  const result: DiffLine[] = [];
  let lineNumber = 1;

  for (const change of changes) {
    // Split change value into individual lines, removing trailing newline
    const changeLines = change.value.replace(/\r?\n$/, '').split(/\r?\n/);

    for (const content of changeLines) {
      if (change.added) {
        result.push({ type: 'added', content, lineNumber: lineNumber++ });
      } else if (change.removed) {
        result.push({ type: 'removed', content, lineNumber: lineNumber++ });
      } else {
        result.push({ type: 'context', content, lineNumber: lineNumber++ });
      }
    }
  }

  return result;
}
```

**Modified `generateDiff()`**:
```typescript
function generateDiff(oldLines: string[], newLines: string[]): DiffLine[] {
  // Fallback to semantic diffing for large files to prevent OOM
  if (oldLines.length * newLines.length > MAX_LCS_CELLS) {
    return generateDiffFallback(oldLines, newLines);
  }

  // Original LCS-based algorithm
  const matrix = computeLCSMatrix(oldLines, newLines);
  // ... rest unchanged ...
}
```

### Visual Behavior Difference

| File Pair | Strategy | Visual Quality |
|-----------|----------|---------------|
| < 1000×1000 | LCS | Precise character-level alignment |
| > 1000×1000 | Semantic | Groups consecutive changes differently, but correct |

The fallback is semantically correct but may group consecutive changes differently.
For most real code diffs, the visual difference is negligible.

### Precedent in Codebase

`ReviewDiffContent.tsx` already uses `diffLines()` successfully:
```typescript
const diffResult = diffLines(original ?? '', modified ?? '');
```

---

## Fix #1+#2: Unified Line Counting

**Confidence: 7/10**
**Effort: ~4-6 hours**

### Current State: 3 Independent Algorithms

#### MemberStatsComputer (`src/main/services/team/MemberStatsComputer.ts`)

**Edit** (lines 189-202):
```typescript
const oldLines = oldStr ? oldStr.split('\n').length : 0;
const newLines = newStr ? newStr.split('\n').length : 0;
const fileAdded = newLines > oldLines ? newLines - oldLines : 0;
const fileRemoved = oldLines > newLines ? oldLines - newLines : 0;
```
- WRONG when content changes but line count stays same

**Write** (lines 204-214):
```typescript
const fileAdded = writeContent.split('\n').length;
linesAdded += fileAdded;
addFileLines(input.file_path, fileAdded, 0);  // Always removals = 0!
```
- NEVER counts removals

**MultiEdit** (lines 216-229):
- Same pattern as Write: only additions, no removals

**Bash** (lines 232-243):
- Heuristic `estimateBashLinesChanged()` (~30-40% coverage)

#### ChangeExtractorService (`src/main/services/team/ChangeExtractorService.ts`)

**countLines** (lines 463-473): Uses `diffLines()` — CORRECT
**buildTimeline** (lines 426-427): Uses `split('\n').length` — INCONSISTENT with own countLines!

#### FileContentResolver (`src/main/services/team/FileContentResolver.ts`)

Lines 141-156: Uses `diffLines()` — CORRECT

### Who Consumes These Counts

| Source | Consumer | UI |
|--------|----------|-----|
| MemberStatsComputer | MemberStatsTab.tsx | Session analytics "+X / -Y" |
| ChangeExtractorService | ChangeStatsBadge.tsx | File tree badges |
| ChangeExtractorService | ReviewApplierService.ts | Diff hunks |
| FileContentResolver | CodeMirrorDiffView.tsx | Full file diff display |

### Proposed Fix

**Phase 1: Create UnifiedLineCounter**

```typescript
// src/main/services/team/UnifiedLineCounter.ts
import { diffLines } from 'diff';

export class UnifiedLineCounter {
  static countLines(oldStr: string, newStr: string): { added: number; removed: number } {
    if (!oldStr && !newStr) return { added: 0, removed: 0 };
    const changes = diffLines(oldStr, newStr);
    let added = 0;
    let removed = 0;
    for (const c of changes) {
      if (c.added) added += c.count ?? 0;
      if (c.removed) removed += c.count ?? 0;
    }
    return { added, removed };
  }
}
```

**Phase 2: Migrate MemberStatsComputer Edit**

```typescript
// Replace lines 189-202
const { added: fileAdded, removed: fileRemoved } = UnifiedLineCounter.countLines(oldStr, newStr);
```

**Phase 3: Fix Write Operations (Bug #2)**

Track file creation vs update during JSONL parse:

```typescript
const filesSeen = new Set<string>();

// In Write handler:
if (toolName === 'Write') {
  const filePath = typeof input.file_path === 'string' ? input.file_path : '';
  const writeContent = typeof input.content === 'string' ? input.content : '';

  const isNewFile = !filesSeen.has(filePath);
  filesSeen.add(filePath);

  if (writeContent) {
    if (isNewFile) {
      // New file creation — all lines are additions
      const { added } = UnifiedLineCounter.countLines('', writeContent);
      linesAdded += added;
      if (filePath) addFileLines(filePath, added, 0);
    } else {
      // File replacement — assume full rewrite (conservative estimate)
      const { added } = UnifiedLineCounter.countLines('', writeContent);
      linesAdded += added;
      linesRemoved += added; // Assume ~same amount removed
      if (filePath) addFileLines(filePath, added, added);
    }
  }
}
```

**Phase 4: Fix buildTimeline in ChangeExtractorService**

```typescript
// Replace lines 426-427
const { added, removed } = UnifiedLineCounter.countLines(s.oldString, s.newString);
// Use `added` and `removed` instead of split('\n').length arithmetic
```

**Phase 5: Keep Bash As-Is**

Fundamental limitation — command string has no execution output.

### Risk Assessment

| Risk | Level | Mitigation |
|------|-------|-----------|
| Write removals estimation inaccurate | HIGH | `filesSeen` Set tracks if file existed before; conservative "full rewrite" estimate |
| Line count numbers change in UI | MEDIUM | Expected — numbers become MORE accurate |
| Historical data shows different numbers | LOW | Accept as one-time correction |
| Circular dependency (MemberStatsComputer → FileContentResolver) | NONE | UnifiedLineCounter is independent utility |

### Open Questions

1. **Write-update without oldString**: `filesSeen` approach assumes sequential JSONL parsing. If messages are out of order, may misclassify. Need to verify JSONL ordering.
2. **Performance**: `diffLines()` is heavier than `split().length`. For sessions with 1000+ Edit calls, could add latency. Need to benchmark.
3. **Bash estimation**: Keep as-is or drop entirely? Current tooltip says "Approximate" — may be enough.

---

## Fix #6+#7: Hunk↔Snippet Mapping + indexOf

**Confidence: 5/10**
**Effort: ~150 LOC**

### Current Architecture Flow

```
CodeMirrorDiffView.tsx (lines 427, 443)
  ↓
computeHunkIndexAtPos(state, pos) → hunkIndex: number
  ↓
onRejectRef.current?.(idx)  // onHunkRejected callback
  ↓
IPC: team:applyReviewDecisions
  ↓
ReviewApplierService.rejectHunks(filePath, original, modified, hunkIndices, snippets)
  ↓
trySnippetLevelReject(modified, hunkIndices, snippets)
  ↓
snippetsToReject = hunkIndices.map(idx => validSnippets[idx])  // ← BUG: 1:1 assumption
  ↓
content.indexOf(snippet.newString)  // ← BUG: first occurrence only
```

### Data Available in Snippets

From `ChangeExtractorService` (SnippetDiff type):
- `oldString` / `newString` — actual content
- `toolName` — Edit, Write, MultiEdit
- `toolUseId` — unique ID
- `timestamp` — when it happened
- `type` — 'edit' | 'write-new' | 'write-update' | 'multi-edit'
- `isError` — whether tool errored
- `replaceAll` — for Edit with replace_all flag
- **NO line numbers** — this is the core problem

### Data Available in Hunks

From `structuredPatch()` (npm `diff` package):
```typescript
interface StructuredPatchHunk {
  oldStart: number;     // Line number in original (1-based)
  oldLines: number;     // Line count in original
  newStart: number;     // Line number in modified (1-based)
  newLines: number;     // Line count in modified
  lines: string[];      // Actual diff lines (+, -, space context)
}
```

From CodeMirror's `getChunks()`:
```typescript
chunks: {
  fromA: number  // Original doc character position
  toA: number    // Original doc character position
  fromB: number  // Modified doc character position
  toB: number    // Modified doc character position
}[]
```

### Proposed Fix: 3 Phases

#### Phase 1: `buildHunkToSnippetMapping()`

Build explicit mapping using content overlap detection:

```typescript
private buildHunkToSnippetMapping(
  original: string,
  modified: string,
  hunkIndices: number[],
  snippets: SnippetDiff[]
): Map<number, Set<number>> {
  const patch = structuredPatch('file', 'file', original, modified);
  if (!patch.hunks || patch.hunks.length === 0) return new Map();

  const mapping = new Map<number, Set<number>>();

  for (const hunkIdx of hunkIndices) {
    if (hunkIdx < 0 || hunkIdx >= patch.hunks.length) continue;
    const hunk = patch.hunks[hunkIdx];
    const snippetSet = new Set<number>();

    // Extract added/removed content from hunk
    const addedLines = hunk.lines.filter(l => l.startsWith('+')).map(l => l.slice(1));
    const removedLines = hunk.lines.filter(l => l.startsWith('-')).map(l => l.slice(1));
    const addedContent = addedLines.join('\n');
    const removedContent = removedLines.join('\n');

    for (let sIdx = 0; sIdx < snippets.length; sIdx++) {
      const snippet = snippets[sIdx];
      if (snippet.isError) continue;

      const matchesNew = addedContent.includes(snippet.newString);
      const matchesOld = removedContent.includes(snippet.oldString);

      if (snippet.type === 'write-new' || snippet.type === 'write-update') {
        if (matchesNew) snippetSet.add(sIdx);
      } else {
        // For edits: require both old AND new match for higher confidence
        if (matchesNew && matchesOld) {
          snippetSet.add(sIdx);
        } else if (matchesNew) {
          snippetSet.add(sIdx); // Lower confidence fallback
        }
      }
    }

    mapping.set(hunkIdx, snippetSet);
  }

  return mapping;
}
```

#### Phase 2: Position-Aware `findSnippetPosition()`

Replace indexOf with context-aware search:

```typescript
private findSnippetPosition(
  snippet: SnippetDiff,
  content: string
): number {
  const { newString, oldString } = snippet;

  // Fast path: newString is unique in content
  const firstPos = content.indexOf(newString);
  if (firstPos === -1) return -1;

  const lastPos = content.lastIndexOf(newString);
  if (firstPos === lastPos) return firstPos; // Only one occurrence — safe

  // Multiple occurrences — use oldString context to disambiguate
  // Search for each occurrence and check if surrounding context matches oldString
  const positions: number[] = [];
  let searchStart = 0;
  while (true) {
    const pos = content.indexOf(newString, searchStart);
    if (pos === -1) break;
    positions.push(pos);
    searchStart = pos + 1;
  }

  // For each candidate position, check if oldString context is nearby
  if (oldString) {
    for (const pos of positions) {
      // Look for oldString within ±1000 chars of this position
      // (in the original document, oldString would be at roughly the same position)
      const nearbyStart = Math.max(0, pos - 1000);
      const nearbyEnd = Math.min(content.length, pos + newString.length + 1000);
      const nearby = content.substring(nearbyStart, nearbyEnd);

      // If any unique token from oldString appears nearby, this is likely correct
      const oldTokens = oldString.split(/\s+/).filter(t => t.length > 3);
      const matchScore = oldTokens.filter(t => nearby.includes(t)).length;

      if (matchScore > oldTokens.length * 0.5) {
        return pos; // >50% of oldString tokens found nearby
      }
    }
  }

  // Last resort: return first position with warning
  return firstPos;
}
```

#### Phase 3: Update `trySnippetLevelReject()` Signature

```typescript
// Pass `original` through to enable mapping and context matching
private trySnippetLevelReject(
  modified: string,
  hunkIndices: number[],
  snippets: SnippetDiff[],
  original: string  // NEW parameter
): RejectResult | null {
  const validSnippets = snippets.filter(s => !s.isError);
  if (validSnippets.length === 0) return null;

  // NEW: Build mapping instead of assuming 1:1
  const hunkToSnippets = this.buildHunkToSnippetMapping(
    original, modified, hunkIndices, validSnippets
  );

  // Collect all snippets to reject
  const snippetIndices = new Set<number>();
  for (const indices of hunkToSnippets.values()) {
    indices.forEach(idx => snippetIndices.add(idx));
  }

  const snippetsToReject = Array.from(snippetIndices)
    .map(idx => validSnippets[idx])
    .filter(Boolean);

  // NEW: Position-aware matching
  const positioned = snippetsToReject
    .map(snippet => ({
      snippet,
      pos: this.findSnippetPosition(snippet, modified)
    }))
    .filter(item => item.pos !== -1)
    .sort((a, b) => b.pos - a.pos); // Descending for safe replacement

  if (positioned.length !== snippetsToReject.length) {
    return null; // Fallback to hunk-level
  }

  let content = modified;
  for (const { snippet, pos } of positioned) {
    if (snippet.type === 'write-new') continue;
    if (snippet.replaceAll) {
      content = content.split(snippet.newString).join(snippet.oldString);
    } else {
      content = content.substring(0, pos) + snippet.oldString +
                content.substring(pos + snippet.newString.length);
    }
  }

  return { success: true, newContent: content, hadConflicts: false };
}
```

### Edge Cases & Concerns

| Case | Current Behavior | After Fix |
|------|------------------|-----------|
| Multiple Edit → 1 Hunk | Assumes hunkIdx = snippetIdx (WRONG) | Content overlap mapping (CORRECT) |
| 1 Write → 2 Hunks | Maps to wrong snippet | Maps via content match |
| Duplicate code in file | Corrupts first occurrence | Context-aware disambiguation |
| Short snippet (1 line) | indexOf works | May still match wrong occurrence if context is ambiguous |
| No oldString context | N/A | Falls back to first indexOf match (same as before) |
| replaceAll snippets | Works (replaces all) | Still works (replaceAll logic unchanged) |

### Open Questions

1. **Short snippets**: If `newString` is `"return true;"` and appears 10 times — context matching may fail. Need hunk line range to narrow search.
2. **Performance**: `structuredPatch()` is called again in `buildHunkToSnippetMapping` (already called in `rejectHunks`). Should cache the patch result.
3. **MultiEdit**: Creates 1 snippet but may affect multiple non-contiguous regions. `buildHunkToSnippetMapping` should handle this but needs testing.
4. **Overlapping snippets**: Two snippets touching the same line range. Position-aware replacement from end (descending sort) handles this, but still fragile.
5. **`original` parameter**: Need to thread it through from all callers: `rejectHunks()`, `previewReject()`, `acceptHunks()`.

### Why Confidence is Only 5/10

The core issue is that **snippets have NO line numbers**. All matching is content-based (heuristic). For short/common snippets, disambiguation may fail. A truly robust fix would require:
1. Adding line number tracking to `SnippetDiff` during extraction
2. Or using `structuredPatch` bidirectionally to map hunks to file regions

Both are larger architectural changes that go beyond the current fix scope.

---

## Summary: Implementation Priority

| Fix | Confidence | Effort | Do When |
|-----|-----------|--------|---------|
| #11 Cache TTL | 10/10 | 2 lines | NOW |
| #10 OOM safeguard | 9/10 | ~30 LOC | NOW |
| #1+#2 Line counting | 7/10 | ~4-6h | After tests written |
| #6+#7 Hunk mapping | 5/10 | ~150 LOC | After architectural review |
