# Diff View + Accept/Reject -- Plan

## Overview

4-phase plan. Phase 1 -> self-contained MVP (read-only diff view per agent).
Phase 2 -> accept/reject per hunk with disk writes. Phase 3 -> per-task scoping.
Phase 4 -> polish features.

---

## Phase 1: MVP -- Read-Only Diff View Per Agent

**Goal**: show all file changes made by a team member in a diff review panel,
using data from JSONL files. No accept/reject yet.

### 1.1 Packages to Install

```bash
pnpm add diff          # jsdiff v8 -- structuredPatch, applyPatch, parsePatch
```

`@codemirror/merge` + `react-codemirror-merge` deferred to Phase 2.
`diff` is needed immediately for programmatic hunk computation from `tool_use.input`.

### 1.2 Types to Define

**File: `src/shared/types/review.ts`** (NEW ~120 LOC)

```typescript
/** Represents one file edit extracted from JSONL */
export interface FileChange {
  filePath: string;          // Absolute path on disk
  toolName: 'Edit' | 'Write' | 'NotebookEdit' | 'Bash';
  toolUseId: string;         // For linking back to JSONL
  timestamp: string;          // ISO timestamp of the tool_use
  memberName: string;         // Agent who made the change
  sessionId: string;
  subagentId?: string;        // null for lead session

  // For Edit tool (main session with toolUseResult)
  originalFile?: string;       // Full file content BEFORE edit (from toolUseResult)
  structuredPatch?: Hunk[];    // Ready-made unified diff hunks (from toolUseResult)

  // For Edit tool (subagent -- no toolUseResult, only tool_use.input)
  oldString?: string;          // tool_use.input.old_string
  newString?: string;          // tool_use.input.new_string
  replaceAll?: boolean;

  // For Write tool
  writeContent?: string;       // Full new file content
  writeType?: 'create' | 'overwrite';

  // Reliability indicator
  confidence: 'high' | 'medium' | 'low';
}

export interface Hunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[];   // Each line prefixed with ' ', '+', '-'
}

/** A file with all its changes aggregated */
export interface ReviewFile {
  filePath: string;
  relativePath: string;       // Relative to project root
  language: string;            // Inferred from extension
  changes: FileChange[];       // Ordered by timestamp
  stats: { added: number; removed: number };
  status: 'added' | 'modified' | 'deleted';
}

/** Complete review data for an agent */
export interface AgentReviewData {
  teamName: string;
  memberName: string;
  files: ReviewFile[];
  totalStats: { added: number; removed: number; filesChanged: number };
  extractedAt: string;
  confidence: 'high' | 'medium' | 'low';  // Lowest confidence of all changes
}
```

Re-export from `src/shared/types/index.ts`.

### 1.3 IPC Channels

**File: `src/preload/constants/ipcChannels.ts`** (MODIFY -- add 2 lines)

```typescript
/** Get file changes for a team member (diff review) */
export const REVIEW_GET_MEMBER_CHANGES = 'review:getMemberChanges';

/** Read current file content from disk (for conflict detection) */
export const REVIEW_READ_FILE = 'review:readFile';
```

### 1.4 Backend Service

**File: `src/main/services/team/FileChangeExtractor.ts`** (NEW ~350 LOC)

Main service that parses JSONL files and extracts `FileChange[]`.

Responsibilities:
- Uses `TeamMemberLogsFinder.findMemberLogPaths()` to get JSONL paths
- For MAIN session JSONL: extracts `toolUseResult` objects with `originalFile` + `structuredPatch` (high confidence)
- For SUBAGENT JSONL: extracts `tool_use.input` (old_string, new_string, file_path) from Edit blocks (medium confidence)
- For Write tools: extracts `tool_use.input.content` + `file_path` (medium confidence for overwrite, high for create)
- Uses `diff` package's `structuredPatch()` to compute hunks when `structuredPatch` is not present in JSONL
- Caches results with 2-minute TTL (like MemberStatsComputer)
- Error filtering: skips entries where `typeof toolUseResult === 'string'` or `is_error: true`

**File: `src/main/services/team/ReviewAggregator.ts`** (NEW ~150 LOC)

Transforms `FileChange[]` into `AgentReviewData`:
- Groups changes by `filePath`
- Computes per-file stats (lines added/removed)
- Infers file status (added/modified/deleted)
- Computes relative paths from project root
- Infers language from file extension (reuse shared utility)

### 1.5 IPC Handler

**File: `src/main/ipc/review.ts`** (NEW ~120 LOC)

Follows exact same pattern as `teams.ts`:
- `let fileChangeExtractor: FileChangeExtractor | null = null;`
- `let reviewAggregator: ReviewAggregator | null = null;`
- `initializeReviewHandlers(extractor, aggregator)`
- `registerReviewHandlers(ipcMain)` / `removeReviewHandlers(ipcMain)`
- `wrapReviewHandler<T>()` -- same as `wrapTeamHandler`
- Handlers:
  - `handleGetMemberChanges(event, teamName, memberName)` -> `IpcResult<AgentReviewData>`
  - `handleReadFile(event, filePath)` -> `IpcResult<string>` (reads current file from disk, with path validation)

**File: `src/main/ipc/handlers.ts`** (MODIFY)
- Import and register review handlers

**File: `src/main/ipc/guards.ts`** (MODIFY -- if needed for new validations)

### 1.6 Preload Bridge

**File: `src/preload/index.ts`** (MODIFY)
- Add `review` namespace to exposed API:
```typescript
review: {
  getMemberChanges: (teamName: string, memberName: string) =>
    invokeIpcWithResult(REVIEW_GET_MEMBER_CHANGES, teamName, memberName),
  readFile: (filePath: string) =>
    invokeIpcWithResult(REVIEW_READ_FILE, filePath),
}
```

**File: `src/shared/types/api.ts`** (MODIFY)
- Add `ReviewAPI` interface
- Add `review: ReviewAPI` to `ElectronAPI`

**File: `src/renderer/api/httpClient.ts`** (MODIFY)
- Add review HTTP fallback stubs

### 1.7 Zustand Store

**File: `src/renderer/store/slices/reviewSlice.ts`** (NEW ~120 LOC)

```typescript
export interface ReviewSlice {
  // State
  reviewData: AgentReviewData | null;
  reviewLoading: boolean;
  reviewError: string | null;
  selectedReviewFile: string | null;   // filePath

  // Actions
  fetchMemberChanges: (teamName: string, memberName: string) => Promise<void>;
  selectReviewFile: (filePath: string | null) => void;
  clearReview: () => void;
}
```

**File: `src/renderer/store/index.ts`** (MODIFY -- add slice)
**File: `src/renderer/store/types.ts`** (MODIFY -- add to AppState)

### 1.8 UI Components

**File: `src/renderer/components/team/review/ReviewPanel.tsx`** (NEW ~180 LOC)

Main container component. Layout:
```
+----------------------------------+
| ReviewPanel                       |
| [member-name] +142 -38  [Close]  |
+----------+-----------------------+
| FileTree | DiffContent            |
|          |                        |
| src/     | file: auth.ts          |
|   auth.ts| @@ -1,5 +1,42 @@      |
|   +87 -2 | + import jwt ...       |
|          |                        |
| test/    | @@ -42,3 +42,8 @@     |
|   auth.. | - const OLD = ...      |
|   +42 -0 | + const NEW = ...      |
+----------+-----------------------+
```

Props: `teamName: string, memberName: string, onClose: () => void`

**File: `src/renderer/components/team/review/ReviewFileTree.tsx`** (NEW ~150 LOC)

Left sidebar with file list:
- Grouped by directory
- Per-file stats (+added / -removed)
- Active file highlight
- Click to select file
- Collapsible directory groups

**File: `src/renderer/components/team/review/ReviewDiffContent.tsx`** (NEW ~120 LOC)

Right panel showing the diff for selected file:
- Header with filename, language badge, stats
- Uses improved DiffViewer (Phase 1 keeps the LCS approach but adds useMemo + proper line numbers)
- Handles multiple changes to same file (shows them sequentially)
- Shows confidence indicator for low/medium confidence changes
- Collapse/expand unchanged code regions

**File: `src/renderer/components/team/review/ReviewEmptyState.tsx`** (NEW ~30 LOC)

Empty state when no changes found.

### 1.9 Integration Point

**File: `src/renderer/components/team/members/MemberCard.tsx`** (MODIFY)

Add "Review Changes" button to member card:
```tsx
<button onClick={() => openReviewPanel(memberName)}>
  <GitCompareArrows className="size-4" /> Review
</button>
```

**File: `src/renderer/components/team/TeamDetailView.tsx`** (MODIFY)

Add ReviewPanel rendering (slide-in panel or dialog). Wire up state:
```tsx
{reviewMember && (
  <ReviewPanel
    teamName={teamName}
    memberName={reviewMember}
    onClose={() => setReviewMember(null)}
  />
)}
```

### 1.10 Existing DiffViewer -- Migration Strategy

The existing `DiffViewer.tsx` in `src/renderer/components/chat/viewers/` is used for
inline Edit tool display in chat history. It stays UNCHANGED in Phase 1.

The new review components are in a separate `team/review/` directory and do NOT modify DiffViewer.
In Phase 2, when CodeMirror is introduced, both surfaces will be migrated.

### 1.11 Service Registration

**File: `src/main/services/team/index.ts`** (MODIFY -- add 2 exports)
**File: `src/main/services/index.ts`** (MODIFY -- re-export)

### 1.12 Language Detection Utility

**File: `src/shared/utils/languageDetection.ts`** (NEW ~50 LOC)

Extract the `EXTENSION_LANGUAGE_MAP` and `inferLanguage()` from `DiffViewer.tsx` into
a shared utility. Both DiffViewer and ReviewDiffContent will import from here.
DiffViewer.tsx gets modified to import instead of duplicating.

### 1.13 Testing Strategy

**File: `test/main/services/team/FileChangeExtractor.test.ts`** (NEW ~250 LOC)
- Test parsing Edit tool_use with toolUseResult (main session)
- Test parsing Edit tool_use without toolUseResult (subagent)
- Test parsing Write create / overwrite
- Test error filtering (failed edits, rejected edits)
- Test caching behavior

**File: `test/main/services/team/ReviewAggregator.test.ts`** (NEW ~100 LOC)
- Test grouping changes by file
- Test stats computation
- Test relative path calculation
- Test file status inference

**File: `test/main/ipc/review.test.ts`** (NEW ~80 LOC)
- Test input validation (teamName, memberName)
- Test error wrapping

**File: `test/shared/utils/languageDetection.test.ts`** (NEW ~40 LOC)

### 1.14 Phase 1 Summary

| Category | New Files | Modified Files | Estimated LOC |
|----------|-----------|----------------|---------------|
| Types | 1 | 2 | ~120 |
| Backend services | 2 | 2 | ~500 |
| IPC handler | 1 | 2 | ~120 |
| Preload/API | 0 | 3 | ~40 |
| Store | 1 | 2 | ~120 |
| UI components | 4 | 2 | ~480 |
| Shared utils | 1 | 1 | ~50 |
| Tests | 4 | 0 | ~470 |
| **Total** | **14** | **14** | **~1,900** |

### 1.15 Risks

| Risk | Probability | Mitigation |
|------|-------------|------------|
| Subagent JSONL lacks toolUseResult -- hunks inaccurate | HIGH (known) | Use `diff.structuredPatch(old_string, new_string)` for subagents; show confidence badge |
| Large files slow LCS diff | MEDIUM | Phase 1 uses `diff` package (Myers algorithm), not hand-rolled LCS; add useMemo |
| Write tool missing originalFile | HIGH (known) | Show "file created" or "file overwritten" without diff; add note |
| Multiple JSONL files per member | LOW | Already handled by `findMemberLogPaths()` |

### 1.16 Dependencies

Phase 1 is self-contained. No dependency on other phases.

---

## Phase 2: Accept/Reject Per Hunk

**Goal**: interactive diff UI with per-hunk Accept/Reject buttons. Reject writes
modified file back to disk.

### 2.1 Packages to Install

```bash
pnpm add @codemirror/merge          # Diff UI with acceptChunk/rejectChunk
pnpm add react-codemirror-merge     # React wrapper
pnpm add @codemirror/state          # Core dependency
pnpm add @codemirror/view           # Core dependency
pnpm add @codemirror/lang-javascript  # Syntax highlight
pnpm add @codemirror/lang-python
pnpm add @codemirror/lang-css
pnpm add @codemirror/lang-html
pnpm add @codemirror/lang-json
pnpm add @codemirror/lang-markdown
pnpm add @codemirror/lang-rust
pnpm add @codemirror/lang-sql
pnpm add @codemirror/theme-one-dark   # Dark theme matching our palette
pnpm add node-diff3                   # Three-way merge for conflict detection
```

### 2.2 New Types

**File: `src/shared/types/review.ts`** (MODIFY -- add ~80 LOC)

```typescript
/** Per-hunk review decision */
export type HunkDecision = 'accepted' | 'rejected' | 'pending';

/** Review state for a single file */
export interface FileReviewState {
  filePath: string;
  hunkDecisions: HunkDecision[];  // One per hunk, indexed
  viewed: boolean;
  hasConflict: boolean;
  conflictDetails?: string;
}

/** Request to apply review decisions to disk */
export interface ApplyReviewRequest {
  teamName: string;
  memberName: string;
  filePath: string;
  hunkDecisions: HunkDecision[];
  originalFile: string;          // Base version for patch computation
  currentDiskContent: string;    // For conflict detection
}

export interface ApplyReviewResult {
  success: boolean;
  conflictDetected: boolean;
  conflictDetails?: string;
  newContent?: string;
}
```

### 2.3 IPC Channels

**File: `src/preload/constants/ipcChannels.ts`** (MODIFY)

```typescript
/** Apply review decisions (write to disk) */
export const REVIEW_APPLY_DECISIONS = 'review:applyDecisions';

/** Get file-history backup content */
export const REVIEW_GET_BACKUP = 'review:getBackup';
```

### 2.4 Backend Services

**File: `src/main/services/team/ReviewApplier.ts`** (NEW ~200 LOC)

Core logic for writing accepted/rejected hunks to disk:

```
Accept hunk:   No-op (file already has the change)
Reject hunk:   Compute reverse patch for that hunk, apply to current file
Reject all:    Write originalFile to disk
Partial:       Apply only accepted hunks from originalFile base
```

Implementation:
1. Read current file from disk
2. If current != expected (agent version), run 3-way merge:
   - base = originalFile (before agent edit)
   - ours = result of applying only accepted hunks to originalFile
   - theirs = current disk content
   - Use `node-diff3.diff3Merge()` for conflict detection
3. If no conflict: write merged result
4. If conflict: return conflict details to UI, do NOT write

**File: `src/main/services/team/BackupReader.ts`** (NEW ~60 LOC)

Reads `~/.claude/file-history/{sessionId}/{backupFileName}` backup files.
Used as fallback when `originalFile` is not in JSONL (Write tool case).

### 2.5 IPC Handler

**File: `src/main/ipc/review.ts`** (MODIFY -- add 2 handlers)

- `handleApplyDecisions(event, request: ApplyReviewRequest)` -> `IpcResult<ApplyReviewResult>`
  - Validates all fields
  - Calls ReviewApplier
  - Path traversal validation (prevent writing outside project dir)
- `handleGetBackup(event, sessionId, backupFileName)` -> `IpcResult<string>`
  - Validates sessionId format
  - Reads backup file content

### 2.6 Preload / API

**File: `src/preload/index.ts`** (MODIFY)
**File: `src/shared/types/api.ts`** (MODIFY -- extend ReviewAPI)
**File: `src/renderer/api/httpClient.ts`** (MODIFY)

### 2.7 Zustand Store

**File: `src/renderer/store/slices/reviewSlice.ts`** (MODIFY -- add ~80 LOC)

```typescript
// Additional state
fileReviewStates: Record<string, FileReviewState>;
applyingReview: boolean;
applyError: string | null;

// Additional actions
setHunkDecision: (filePath: string, hunkIndex: number, decision: HunkDecision) => void;
acceptAllHunks: (filePath: string) => void;
rejectAllHunks: (filePath: string) => void;
acceptAllFiles: () => void;
rejectAllFiles: () => void;
applyReviewDecisions: (filePath: string) => Promise<ApplyReviewResult>;
markFileViewed: (filePath: string) => void;
```

### 2.8 UI Components

**File: `src/renderer/components/team/review/CodeMirrorDiffView.tsx`** (NEW ~250 LOC)

Replaces the simple DiffViewer in the review panel with CodeMirror merge view:
- `MergeView` from `@codemirror/merge` with `mergeControls: true`
- Theme integration with CSS variables (dark/light)
- `collapseUnchanged` for hiding unchanged regions
- `allowInlineDiffs` for character-level highlighting
- Custom `mergeControls` renderer for Accept/Reject buttons matching our design system
- `goToNextChunk`/`goToPreviousChunk` wired to keyboard shortcuts
- Read-only mode (user cannot edit the code, only accept/reject)
- Emits `onHunkDecision(hunkIndex, decision)` callback

**File: `src/renderer/components/team/review/ReviewToolbar.tsx`** (NEW ~80 LOC)

Bottom toolbar:
- "Reject All" / "Accept All" buttons
- Unified / Split toggle
- Stats summary (e.g. "3/7 hunks accepted")
- Apply button (writes to disk)

**File: `src/renderer/components/team/review/ConflictDialog.tsx`** (NEW ~80 LOC)

Dialog shown when conflict is detected:
- Shows conflict details
- Options: "Force reject (overwrite)", "Skip this file", "Cancel"

**File: `src/renderer/components/team/review/ReviewFileTree.tsx`** (MODIFY)

Add per-file status indicators:
- Checkmark (all accepted)
- X (all rejected)
- Partial (mixed)
- Warning (conflict detected)
- Eye icon (viewed/unviewed)

**File: `src/renderer/components/team/review/ReviewDiffContent.tsx`** (MODIFY)

Replace inline diff rendering with `CodeMirrorDiffView` component.

### 2.9 CodeMirror Theme

**File: `src/renderer/components/team/review/codemirrorTheme.ts`** (NEW ~80 LOC)

Custom CodeMirror theme that maps to our CSS variables:
- `--diff-added-bg`, `--diff-removed-bg`
- `--code-bg`, `--code-border`
- Font family matching our monospace stack
- Accept/Reject button styling

### 2.10 Existing DiffViewer Migration

At this point, the chat viewer's `DiffViewer.tsx` can optionally be migrated to use
CodeMirror as well. This is NOT required for the review feature but improves consistency.
If done:
- `DiffViewer.tsx` becomes a thin wrapper around CodeMirror (read-only, no accept/reject)
- LCS algorithm removed
- Bundle size increase ~130KB (CodeMirror core) -- acceptable since already loaded for review

Recommended: keep old DiffViewer in chat view for now (it works, it's lightweight).
Only the review panel uses CodeMirror.

### 2.11 Testing Strategy

**File: `test/main/services/team/ReviewApplier.test.ts`** (NEW ~200 LOC)
- Test reject single hunk
- Test reject all hunks
- Test partial accept/reject
- Test conflict detection (file changed after agent edit)
- Test three-way merge resolution
- Test path traversal prevention

**File: `test/main/services/team/BackupReader.test.ts`** (NEW ~60 LOC)
- Test reading backup files
- Test missing backup graceful handling

### 2.12 Phase 2 Summary

| Category | New Files | Modified Files | Estimated LOC |
|----------|-----------|----------------|---------------|
| Types | 0 | 1 | ~80 |
| Backend services | 2 | 0 | ~260 |
| IPC handler | 0 | 1 | ~60 |
| Preload/API | 0 | 3 | ~30 |
| Store | 0 | 1 | ~80 |
| UI components | 4 | 2 | ~490 |
| Theme | 1 | 0 | ~80 |
| Tests | 2 | 0 | ~260 |
| **Total** | **9** | **8** | **~1,340** |

### 2.13 Risks

| Risk | Probability | Mitigation |
|------|-------------|------------|
| CodeMirror bundle size (~130KB) | LOW | Lazy import; only loaded when review panel opens |
| Three-way merge conflicts hard to resolve | MEDIUM | Show clear conflict UI; always offer "force" option |
| originalFile missing for some edits | MEDIUM | Fall back to file-history backups; show warning |
| CodeMirror theme integration complex | LOW | Start with `one-dark` theme, customize incrementally |
| react-codemirror-merge API changes | LOW | Pin version; wrapper is thin |

### 2.14 Dependencies

- Requires Phase 1 (review data extraction)
- Phase 2 review decisions are per-agent only (not per-task)

---

## Phase 3: Per-Task Scoping

**Goal**: show diffs scoped to a specific task, not just an agent.
Integrate review into the kanban board task cards.

### 3.1 No New Packages

All needed packages installed in Phases 1-2.

### 3.2 Types

**File: `src/shared/types/review.ts`** (MODIFY -- add ~50 LOC)

```typescript
/** Time window for task-scoped change extraction */
export interface TaskTimeWindow {
  taskId: string;
  memberName: string;
  startTimestamp: string | null;   // First activity related to task
  endTimestamp: string | null;     // Task completion or latest activity
  confidence: 'high' | 'medium' | 'low';
  markers: TaskMarker[];
}

export interface TaskMarker {
  type: 'task_start' | 'task_complete' | 'task_create' | 'task_update' | 'mention';
  timestamp: string;
  source: string;  // JSONL line info
}

/** Review scoped to a task */
export interface TaskReviewData extends AgentReviewData {
  taskId: string;
  taskSubject: string;
  timeWindow: TaskTimeWindow;
}
```

### 3.3 IPC Channels

**File: `src/preload/constants/ipcChannels.ts`** (MODIFY)

```typescript
/** Get file changes scoped to a task */
export const REVIEW_GET_TASK_CHANGES = 'review:getTaskChanges';
```

### 3.4 Backend Service

**File: `src/main/services/team/TaskTimeWindowResolver.ts`** (NEW ~250 LOC)

Resolves the time window for a task by scanning JSONL files:

1. Use `TeamMemberLogsFinder.findLogsForTask()` to find relevant JSONL files
2. Scan each file for task markers:
   - `TaskCreate` with matching task ID -> start marker
   - `TaskUpdate` with status `in_progress` -> start marker
   - `TaskUpdate` with status `completed` -> end marker
   - `SendMessage` referencing task ID -> activity marker
   - Comment mentioning `#taskId` -> activity marker
3. Build `TaskTimeWindow` from earliest start to latest end
4. Confidence levels:
   - HIGH: both explicit start + end markers found
   - MEDIUM: only start OR end found, other inferred from timestamps
   - LOW: no explicit markers, only mentions -- wide time window

**File: `src/main/services/team/FileChangeExtractor.ts`** (MODIFY -- add ~80 LOC)

New method: `extractChangesForTask(teamName, taskId, timeWindow)`
- Same JSONL parsing as per-agent
- Filters `tool_use` blocks by timestamp within `timeWindow`
- Additional heuristic: if task owner is known, only include that member's changes

### 3.5 IPC Handler

**File: `src/main/ipc/review.ts`** (MODIFY)

Add `handleGetTaskChanges(event, teamName, taskId)` handler.

### 3.6 Preload / API

Same pattern: extend `ReviewAPI`, update `preload/index.ts`, update `httpClient.ts`.

### 3.7 Zustand Store

**File: `src/renderer/store/slices/reviewSlice.ts`** (MODIFY)

```typescript
// Additional state
taskReviewData: TaskReviewData | null;
taskReviewLoading: boolean;

// Additional action
fetchTaskChanges: (teamName: string, taskId: string) => Promise<void>;
```

### 3.8 UI Components

**File: `src/renderer/components/team/review/TaskReviewPanel.tsx`** (NEW ~100 LOC)

Wraps ReviewPanel with task-specific header:
- Task subject + ID
- Time window visualization (start -> end)
- Confidence badge
- Same file tree + diff content as ReviewPanel (reuses components)

**File: `src/renderer/components/team/kanban/KanbanTaskCard.tsx`** (MODIFY)

Add "Review Changes" button on task cards that are in `review` or `done` columns:
```tsx
{(task.kanbanColumn === 'review' || task.status === 'completed') && (
  <button onClick={() => openTaskReview(task.id)}>
    <GitCompareArrows className="size-3.5" /> Changes
  </button>
)}
```

**File: `src/renderer/components/team/dialogs/TaskDetailDialog.tsx`** (MODIFY)

Add "View Changes" tab/section to task detail dialog.

### 3.9 Testing Strategy

**File: `test/main/services/team/TaskTimeWindowResolver.test.ts`** (NEW ~200 LOC)
- Test finding task markers in JSONL
- Test HIGH confidence (both markers)
- Test MEDIUM confidence (partial markers)
- Test LOW confidence (only mentions)
- Test multiple sessions contributing to same task

**File: `test/main/services/team/FileChangeExtractor.task.test.ts`** (NEW ~120 LOC)
- Test time-window filtering
- Test cross-session task changes

### 3.10 Phase 3 Summary

| Category | New Files | Modified Files | Estimated LOC |
|----------|-----------|----------------|---------------|
| Types | 0 | 1 | ~50 |
| Backend services | 1 | 1 | ~330 |
| IPC handler | 0 | 1 | ~30 |
| Preload/API | 0 | 3 | ~20 |
| Store | 0 | 1 | ~30 |
| UI components | 1 | 2 | ~100 |
| Tests | 2 | 0 | ~320 |
| **Total** | **4** | **9** | **~880** |

### 3.11 Risks

| Risk | Probability | Mitigation |
|------|-------------|------------|
| Time window too wide (catches unrelated changes) | MEDIUM | Use confidence levels; show warning for LOW confidence |
| Task timestamps not in JSONL | HIGH (known) | Rely on tool_use timestamps from JSONL, not task JSON file |
| Multiple agents working on same task | LOW | Show all contributing agents, grouped by member |
| Task markers hard to find in large JSONL | MEDIUM | Reuse `fileMentionsTaskId()` for fast scanning |

### 3.12 Dependencies

- Requires Phase 1 (FileChangeExtractor)
- Optionally uses Phase 2 (accept/reject) but works without it (read-only task review)

---

## Phase 4: Enhanced Features

**Goal**: polish, keyboard navigation, "viewed" tracking, multi-edit timeline,
git fallback for Bash changes.

### 4.1 Packages to Install

```bash
pnpm add simple-git    # Git operations for Bash change detection
```

### 4.2 Feature A: Multiple Edits to Same File (Timeline View)

**File: `src/renderer/components/team/review/FileEditTimeline.tsx`** (NEW ~120 LOC)

When a file has multiple `FileChange` entries:
- Show a horizontal timeline of edits
- Each node = one edit (with timestamp, agent name)
- Click node to see that specific diff
- "Final" shows cumulative diff

### 4.3 Feature B: Keyboard Navigation

**File: `src/renderer/hooks/useReviewKeyboardNav.ts`** (NEW ~80 LOC)

Keyboard shortcuts (while review panel is focused):
- `j` / `k` -- next/previous file
- `n` / `p` -- next/previous hunk
- `a` -- accept current hunk
- `r` -- reject current hunk
- `A` (shift+a) -- accept all hunks in file
- `R` (shift+r) -- reject all hunks in file
- `v` -- toggle viewed
- `Escape` -- close review panel

Integrates with CodeMirror's `goToNextChunk` / `goToPreviousChunk`.

### 4.4 Feature C: "Viewed" File Tracking

**File: `src/renderer/store/slices/reviewSlice.ts`** (MODIFY -- ~20 LOC)

Persistent "viewed" state per file (stored in IndexedDB via `idb-keyval`):
- Key: `review:{teamName}:{memberName}:{filePath}`
- Value: `{ viewed: boolean, viewedAt: string }`
- Badge in file tree: eye icon / number of unviewed files

### 4.5 Feature D: Git Fallback for Bash Changes

**File: `src/main/services/team/GitDiffProvider.ts`** (NEW ~150 LOC)

For changes made via Bash (git apply, sed, etc.):
1. Get project's git repo path from team config
2. Use `simple-git` to run `git log --author --since --until --stat` filtered by session timestamps
3. For each changed file: `git diff <before-sha>..<after-sha> -- <file>`
4. Convert to `FileChange[]` with `confidence: 'medium'`

Integration: called by `FileChangeExtractor` when `toolName === 'Bash'` and git is available.

### 4.6 Feature E: Split/Unified View Toggle

**File: `src/renderer/components/team/review/CodeMirrorDiffView.tsx`** (MODIFY)

Add `orientation` prop:
- `'a-b'` (side-by-side / split view)
- Unified view via custom rendering

Store user preference in localStorage.

### 4.7 Testing Strategy

**File: `test/main/services/team/GitDiffProvider.test.ts`** (NEW ~100 LOC)
**File: `test/renderer/hooks/useReviewKeyboardNav.test.ts`** (NEW ~80 LOC)

### 4.8 Phase 4 Summary

| Category | New Files | Modified Files | Estimated LOC |
|----------|-----------|----------------|---------------|
| Backend services | 1 | 1 | ~150 |
| UI components | 1 | 1 | ~120 |
| Hooks | 1 | 0 | ~80 |
| Store | 0 | 1 | ~20 |
| Tests | 2 | 0 | ~180 |
| **Total** | **5** | **3** | **~550** |

### 4.9 Risks

| Risk | Probability | Mitigation |
|------|-------------|------------|
| simple-git not available on all systems | MEDIUM | Feature is optional fallback; graceful degradation |
| Git diff timestamps don't match JSONL exactly | MEDIUM | Use wide time window (+/- 60s) for matching |
| Keyboard navigation conflicts with existing shortcuts | LOW | Scope to review panel focus only |

### 4.10 Dependencies

- Requires Phase 2 (CodeMirror for split/unified toggle, keyboard nav)
- Git fallback can be done independently

---

## Complete File Manifest

### All New Files (32 total)

| Phase | File | LOC |
|-------|------|-----|
| 1 | `src/shared/types/review.ts` | ~120 |
| 1 | `src/shared/utils/languageDetection.ts` | ~50 |
| 1 | `src/main/services/team/FileChangeExtractor.ts` | ~350 |
| 1 | `src/main/services/team/ReviewAggregator.ts` | ~150 |
| 1 | `src/main/ipc/review.ts` | ~120 |
| 1 | `src/renderer/store/slices/reviewSlice.ts` | ~120 |
| 1 | `src/renderer/components/team/review/ReviewPanel.tsx` | ~180 |
| 1 | `src/renderer/components/team/review/ReviewFileTree.tsx` | ~150 |
| 1 | `src/renderer/components/team/review/ReviewDiffContent.tsx` | ~120 |
| 1 | `src/renderer/components/team/review/ReviewEmptyState.tsx` | ~30 |
| 1 | `test/main/services/team/FileChangeExtractor.test.ts` | ~250 |
| 1 | `test/main/services/team/ReviewAggregator.test.ts` | ~100 |
| 1 | `test/main/ipc/review.test.ts` | ~80 |
| 1 | `test/shared/utils/languageDetection.test.ts` | ~40 |
| 2 | `src/main/services/team/ReviewApplier.ts` | ~200 |
| 2 | `src/main/services/team/BackupReader.ts` | ~60 |
| 2 | `src/renderer/components/team/review/CodeMirrorDiffView.tsx` | ~250 |
| 2 | `src/renderer/components/team/review/ReviewToolbar.tsx` | ~80 |
| 2 | `src/renderer/components/team/review/ConflictDialog.tsx` | ~80 |
| 2 | `src/renderer/components/team/review/codemirrorTheme.ts` | ~80 |
| 2 | `test/main/services/team/ReviewApplier.test.ts` | ~200 |
| 2 | `test/main/services/team/BackupReader.test.ts` | ~60 |
| 3 | `src/main/services/team/TaskTimeWindowResolver.ts` | ~250 |
| 3 | `src/renderer/components/team/review/TaskReviewPanel.tsx` | ~100 |
| 3 | `test/main/services/team/TaskTimeWindowResolver.test.ts` | ~200 |
| 3 | `test/main/services/team/FileChangeExtractor.task.test.ts` | ~120 |
| 4 | `src/main/services/team/GitDiffProvider.ts` | ~150 |
| 4 | `src/renderer/components/team/review/FileEditTimeline.tsx` | ~120 |
| 4 | `src/renderer/hooks/useReviewKeyboardNav.ts` | ~80 |
| 4 | `test/main/services/team/GitDiffProvider.test.ts` | ~100 |
| 4 | `test/renderer/hooks/useReviewKeyboardNav.test.ts` | ~80 |

### All Modified Files (across all phases)

| File | Phases | Changes |
|------|--------|---------|
| `src/shared/types/review.ts` | 1,2,3 | Type additions |
| `src/shared/types/index.ts` | 1 | Re-export |
| `src/shared/types/api.ts` | 1,2,3 | ReviewAPI interface |
| `src/preload/constants/ipcChannels.ts` | 1,2,3 | Channel constants |
| `src/preload/index.ts` | 1,2,3 | Bridge methods |
| `src/main/ipc/handlers.ts` | 1 | Register review handlers |
| `src/main/ipc/review.ts` | 2,3 | Additional handlers |
| `src/main/services/team/index.ts` | 1,2,3,4 | Barrel exports |
| `src/main/services/index.ts` | 1 | Re-export |
| `src/renderer/api/httpClient.ts` | 1,2,3 | HTTP fallback |
| `src/renderer/store/index.ts` | 1 | Add slice |
| `src/renderer/store/types.ts` | 1 | AppState type |
| `src/renderer/store/slices/reviewSlice.ts` | 2,3,4 | State extensions |
| `src/renderer/components/team/members/MemberCard.tsx` | 1 | Review button |
| `src/renderer/components/team/TeamDetailView.tsx` | 1 | Panel integration |
| `src/renderer/components/team/review/ReviewFileTree.tsx` | 2 | Status indicators |
| `src/renderer/components/team/review/ReviewDiffContent.tsx` | 2 | CodeMirror swap |
| `src/renderer/components/team/kanban/KanbanTaskCard.tsx` | 3 | Review button |
| `src/renderer/components/team/dialogs/TaskDetailDialog.tsx` | 3 | Changes tab |
| `src/renderer/components/chat/viewers/DiffViewer.tsx` | 1 | Extract languageDetection |
| `src/main/services/team/FileChangeExtractor.ts` | 3,4 | Task scope + git fallback |
| `src/renderer/components/team/review/CodeMirrorDiffView.tsx` | 4 | Split/unified toggle |

---

## Estimated Total

| Phase | New Files | Modified Files | LOC | Packages |
|-------|-----------|----------------|-----|----------|
| 1 MVP | 14 | 14 | ~1,900 | `diff` |
| 2 Accept/Reject | 9 | 8 | ~1,340 | `@codemirror/*`, `node-diff3` |
| 3 Per-Task | 4 | 9 | ~880 | -- |
| 4 Enhanced | 5 | 3 | ~550 | `simple-git` |
| **Total** | **32** | **34** | **~4,670** | 14 packages |

---

## Implementation Order Recommendation

```
Week 1:  Phase 1 (MVP read-only diff view)
         - Day 1-2: Types + FileChangeExtractor + ReviewAggregator + tests
         - Day 3: IPC handler + preload bridge
         - Day 4-5: UI components + store + integration

Week 2:  Phase 2 (Accept/Reject)
         - Day 1-2: CodeMirror integration + theme
         - Day 3: ReviewApplier + conflict detection + tests
         - Day 4: Toolbar + ConflictDialog
         - Day 5: Polish + testing

Week 3:  Phase 3 (Per-Task) + Phase 4 start
         - Day 1-2: TaskTimeWindowResolver + tests
         - Day 3: Task review UI + kanban integration
         - Day 4-5: Phase 4 features (keyboard nav, viewed tracking)

Week 4:  Phase 4 completion + polish
         - Day 1-2: Git fallback
         - Day 3: File edit timeline
         - Day 4-5: Integration testing, edge cases, performance tuning
```

---

## Architecture Decision Records

### ADR-1: Separate `review:*` IPC namespace vs extending `team:*`

**Decision**: Separate `review:*` namespace.
**Reason**: Review is a distinct concern with its own service lifecycle. Mixing into
`teams.ts` (already 1400+ LOC) would make it harder to maintain. Following the
existing pattern where `team:*` channels are for team CRUD/messaging and new domains
get their own namespace.

### ADR-2: `diff` (jsdiff) for hunk computation vs raw structured patch from JSONL

**Decision**: Use JSONL `structuredPatch` when available (main session Edit), fall back
to `diff.structuredPatch()` for subagents.
**Reason**: JSONL data is most reliable (computed by CLI at edit time). But subagent
JSONL lacks it, so we need programmatic fallback. `diff` v8 has 47M weekly downloads
and proven reliability.

### ADR-3: CodeMirror vs @pierre/diffs

**Decision**: `@codemirror/merge`.
**Reason**: Native `acceptChunk()` / `rejectChunk()` API, mature ecosystem (580K
downloads), MIT license, TypeScript support, active maintenance. `@pierre/diffs` is
newer (Sep 2025), has no explicit license, and Shadow DOM complicates theme integration.

### ADR-4: Keep existing DiffViewer in chat view

**Decision**: Do NOT replace chat DiffViewer with CodeMirror in Phase 2.
**Reason**: Chat DiffViewer is read-only and lightweight (~370 LOC). Adding CodeMirror
bundle to every chat view is unnecessary. Review panel loads CodeMirror lazily only when
opened. Migration can be done later if needed.

### ADR-5: Per-agent first, per-task second

**Decision**: Phase 1-2 are per-agent only. Per-task added in Phase 3.
**Reason**: Per-agent is 100% reliable (each agent has its own JSONL). Per-task
requires time-window inference (~85% reliability). Ship reliable feature first,
add task scoping as enhancement.
