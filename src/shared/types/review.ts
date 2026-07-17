/** Один snippet-level дифф от одного tool_use */
export interface LedgerContentState {
  exists?: boolean;
  sha256?: string;
  sizeBytes?: number;
  contentKind?: 'text' | 'binary' | 'unknown';
  blobRef?: string;
  unavailableCode?: 'binary' | 'too-large' | 'read-error' | 'not-captured' | 'blob-missing';
  unavailableReason?: string;
}

export interface LedgerChangeRelation {
  kind: 'rename' | 'copy';
  oldPath: string;
  newPath: string;
}

export interface SnippetDiff {
  toolUseId: string;
  filePath: string;
  toolName: 'Edit' | 'Write' | 'MultiEdit' | 'NotebookEdit' | 'Bash' | 'PowerShell' | 'PostToolUse';
  type:
    | 'edit'
    | 'write-new'
    | 'write-update'
    | 'multi-edit'
    | 'notebook-edit'
    | 'shell-snapshot'
    | 'hook-snapshot';
  oldString: string;
  newString: string;
  replaceAll: boolean;
  timestamp: string;
  isError: boolean;
  /** Hash of ±3 surrounding context lines for reliable hunk↔snippet matching */
  contextHash?: string;
  /** Exact content captured by the orchestrator task-change ledger. */
  ledger?: {
    eventId: string;
    source: 'ledger-exact' | 'ledger-snapshot';
    confidence: 'exact' | 'high' | 'medium' | 'low' | 'ambiguous';
    originalFullContent: string | null;
    modifiedFullContent: string | null;
    beforeHash: string | null;
    afterHash: string | null;
    operation?: 'create' | 'modify' | 'delete';
    beforeState?: LedgerContentState;
    afterState?: LedgerContentState;
    relation?: LedgerChangeRelation;
    executionSeq?: number;
    linesAdded?: number;
    linesRemoved?: number;
    textAvailability?: 'patch-text' | 'full-text' | 'unavailable';
    worktreePath?: string;
    worktreeBranch?: string;
    baseWorkspaceRoot?: string;
    dirtyLeaderWarning?: string;
  };
}

export interface TaskChangeJournalFileStamp {
  bytes: number;
  mtimeMs: number;
  tailSha256: string | null;
}

export interface TaskChangeJournalStamp {
  events?: TaskChangeJournalFileStamp;
  notices?: TaskChangeJournalFileStamp;
}

export interface TaskChangeProvenance {
  sourceKind: 'ledger' | 'legacy';
  sourceFingerprint: string;
  journalStamp?: TaskChangeJournalStamp;
  bundleSchemaVersion?: number;
  integrity?: 'ok' | 'recovered' | 'partial';
}

/** Агрегированные изменения по файлу */
export interface FileChangeSummary {
  filePath: string;
  relativePath: string;
  snippets: SnippetDiff[];
  linesAdded: number;
  linesRemoved: number;
  isNewFile: boolean;
  changeKey?: string;
  diffStatKnown?: boolean;
  ledgerSummary?: {
    latestOperation?: 'create' | 'modify' | 'delete';
    createdInTask?: boolean;
    deletedInTask?: boolean;
    contentAvailability?: 'full-text' | 'hash-only' | 'metadata-only';
    reviewability?: 'full-text' | 'partial-text' | 'metadata-only';
    relation?: LedgerChangeRelation;
    beforeState?: LedgerContentState;
    afterState?: LedgerContentState;
    primaryActorKey?: string;
    agentIds?: string[];
    memberNames?: string[];
    executionSeqRange?: { start: number; end: number };
    worktreePath?: string;
    worktreeBranch?: string;
    baseWorkspaceRoot?: string;
    dirtyLeaderWarning?: string;
  };
  /** Edit timeline for this file (Phase 4) */
  timeline?: FileEditTimeline;
}

/** Полный набор изменений агента */
export interface AgentChangeSet {
  teamName: string;
  memberName: string;
  files: FileChangeSummary[];
  totalLinesAdded: number;
  totalLinesRemoved: number;
  totalFiles: number;
  computedAt: string;
}

/** Полный набор изменений задачи */
export interface TaskChangeSet {
  teamName: string;
  taskId: string;
  files: FileChangeSummary[];
  totalLinesAdded: number;
  totalLinesRemoved: number;
  totalFiles: number;
  confidence: 'high' | 'medium' | 'low' | 'fallback';
  computedAt: string;
}

export const TASK_CHANGE_DIAGNOSTIC_CODES = [
  'multi_scope_no_safe_diff',
  'active_task_no_edits_yet',
  'summary_timeout',
  'summary_reconstructed',
  'journal_unavailable',
  'ledger_integrity_recovered',
  'ledger_integrity_partial',
  'ledger_freshness_mismatch',
  'diff_stat_partial',
  'tool_failed_after_edit',
  'tool_killed_after_edit',
  'unsafe_or_untrusted_evidence',
  'legacy_warning',
] as const;

export type TaskChangeDiagnosticCode = (typeof TASK_CHANGE_DIAGNOSTIC_CODES)[number];

export type TaskChangeDiagnosticSeverity = 'info' | 'warning' | 'error';

export interface TaskChangeReviewDiagnostic {
  code: TaskChangeDiagnosticCode;
  severity: TaskChangeDiagnosticSeverity;
  reviewBlocking: boolean;
  message: string;
  source?: 'ledger' | 'legacy' | 'summary' | 'runtime';
}

export type TaskChangeReviewability =
  | 'reviewable'
  | 'attention_required'
  | 'diagnostic_only'
  | 'none'
  | 'unknown';

export type TaskChangeReviewAction =
  | 'review_diff'
  | 'inspect_diagnostics'
  | 'wait_or_refresh'
  | 'nothing';

export type TaskChangeReviewReasonCode =
  | 'files_changed'
  | 'files_changed_with_non_blocking_diagnostics'
  | 'diagnostic_only'
  | 'confirmed_no_changes'
  | 'pending_no_edits_yet'
  | 'blocking_diagnostics'
  | 'low_confidence';

export interface TaskChangeReviewabilityStatus {
  reviewability: TaskChangeReviewability;
  reasonCode: TaskChangeReviewReasonCode;
  userAction: TaskChangeReviewAction;
  severity: 'success' | 'warning' | 'info' | 'none';
  message: string;
  diagnostics: TaskChangeReviewDiagnostic[];
}

/** Краткая статистика для badge */
export interface ChangeStats {
  linesAdded: number;
  linesRemoved: number;
  filesChanged: number;
}

// ── Phase 2: Diff View types ──

/** Результат проверки конфликтов */
export interface ConflictCheckResult {
  hasConflict: boolean;
  conflictContent: string | null;
  currentContent: string;
  originalContent: string;
}

/** Результат операции reject */
export interface RejectResult {
  success: boolean;
  newContent: string;
  hadConflicts: boolean;
  conflictDescription?: string;
}

/** Решение по hunk */
export type HunkDecision = 'accepted' | 'rejected' | 'pending';

/** Решение по файлу */
export interface FileReviewDecision {
  filePath: string;
  /** Stable renderer decision key (changeKey for grouped ledger changes, otherwise filePath). */
  reviewKey?: string;
  fileDecision: HunkDecision;
  hunkDecisions: Record<number, HunkDecision>;
  /** Main-issued token for the exact full-content snapshot displayed by the renderer. */
  contentSnapshotToken?: string;
  /** Optional stable hunk fingerprints (index → contextHash). Used to map decisions when indices drift. */
  hunkContextHashes?: Record<number, string>;
}

export interface ReviewDecisionPersistenceScope {
  scopeKey: string;
  scopeToken: string;
}

/** Exact renderer state committed by main only after the related disk mutation. */
export interface ReviewPersistedStateSnapshot {
  hunkDecisions: Record<string, HunkDecision>;
  fileDecisions: Record<string, HunkDecision>;
  hunkContextHashesByFile?: Record<string, Record<number, string>>;
  reviewActionHistory: ReviewUndoAction[];
  reviewRedoHistory: ReviewRedoAction[];
}

/** Complete inverse decision state carried by a durable review action. */
export interface ReviewDecisionSnapshot {
  hunkDecisions: Record<string, HunkDecision>;
  fileDecisions: Record<string, HunkDecision>;
}

export type ReviewDiskRestoreMode =
  | 'content'
  | 'create-file'
  | 'delete-file'
  | 'restore-rejected-rename'
  | 'reapply-rejected-rename';

/** Exact disk pre/post-image required to retry an interrupted review Undo safely. */
export interface ReviewDiskUndoSnapshot {
  filePath: string;
  beforeContent: string;
  afterContent: string | null;
  file?: FileChangeSummary;
  fileIndex?: number;
  restoreConflict?: string;
  restoreMode?: ReviewDiskRestoreMode;
  renameExpectation?: ReviewRenameRecoveryExpectation;
}

export interface ReviewDiskUndoAction {
  snapshot: ReviewDiskUndoSnapshot;
  originalIndex?: number;
  file?: FileChangeSummary;
  decisionSnapshot?: ReviewDecisionSnapshot;
}

interface ReviewUndoActionBase {
  /** Stable identity used to prevent a stale async Undo from popping a newer action. */
  id: string;
  createdAt: string;
}

/** Self-contained, ordered Accept/Reject history persisted with the decision snapshot. */
export type ReviewUndoAction =
  | (ReviewUndoActionBase & {
      kind: 'bulk';
      decisionSnapshot: ReviewDecisionSnapshot;
      diskSnapshots: ReviewDiskUndoSnapshot[];
    })
  | (ReviewUndoActionBase & { kind: 'disk'; action: ReviewDiskUndoAction })
  | (ReviewUndoActionBase & {
      kind: 'hunk';
      action: { filePath: string; originalIndex: number };
    });

/** Durable forward state captured when an Accept/Reject action is undone. */
export interface ReviewRedoAction {
  /** The original action moves back to the Undo stack after Redo commits. */
  action: ReviewUndoAction;
  /** Exact decision state produced by the original action. */
  decisionSnapshot: ReviewDecisionSnapshot;
  /** Stable hunk fingerprints from the original post-action state. */
  hunkContextHashesByFile?: Record<string, Record<number, string>>;
}

/** Запрос на применение review */
export interface ApplyReviewRequest {
  teamName: string;
  taskId?: string;
  memberName?: string;
  /** Exact durable decision scope used to close disk/decision crash windows. */
  decisionPersistenceScope?: ReviewDecisionPersistenceScope;
  /**
   * Full post-operation state. Main persists it only after every requested disk
   * effect reaches its postimage. Required for durable mutations.
   */
  persistedState?: ReviewPersistedStateSnapshot;
  /** CAS guard for the exact decision snapshot the renderer hydrated. */
  expectedDecisionRevision?: number;
  decisions: FileReviewDecision[];
}

export type ReviewDirectDiskMutationStep =
  | {
      id: string;
      type: 'write';
      filePath: string;
      expectedContent: string | null;
      content: string;
    }
  | {
      id: string;
      type: 'delete';
      filePath: string;
      expectedContent: string;
    }
  | {
      id: string;
      type: 'restore-rejected-rename' | 'reapply-rejected-rename';
      filePath: string;
      expectation: ReviewRenameRecoveryExpectation;
    };

/** Main-authoritative Restore/Rename/Undo transaction. */
export interface ExecuteReviewMutationRequest {
  scope: ReviewFileScope;
  decisionPersistenceScope: ReviewDecisionPersistenceScope;
  kind: 'restore' | 'rename' | 'undo' | 'redo';
  diskSteps: ReviewDirectDiskMutationStep[];
  persistedState: ReviewPersistedStateSnapshot;
  /** CAS guard preventing an old renderer from overwriting newer durable state. */
  expectedDecisionRevision: number;
  /** Required for Undo so a stale renderer cannot pop a newer durable action. */
  expectedTopActionId?: string;
  /** Required for Redo so a stale renderer cannot replay a different durable branch. */
  expectedTopRedoActionId?: string;
}

/** Authoritative team/task scope used by main to resolve a review file root. */
export interface ReviewFileScope {
  teamName: string;
  taskId?: string;
  memberName?: string;
}

/** Immutable ledger identity used to reject stale rename recovery requests. */
export interface ReviewRenameRecoveryExpectation {
  eventId: string;
  beforeHash: string | null;
  afterHash: string | null;
  relation: LedgerChangeRelation;
}

/** Результат применения review */
export interface ApplyReviewResult {
  applied: number;
  skipped: number;
  conflicts: number;
  errors: {
    filePath: string;
    error: string;
    code?: 'conflict' | 'unavailable' | 'manual-review-required' | 'io-error';
  }[];
  /** Revision committed together with the disk mutation. */
  decisionRevision?: number;
}

/** Полный file content для CodeMirror */
export interface FileChangeWithContent extends FileChangeSummary {
  /** Opaque main-process identity for this exact displayed content generation. */
  reviewSnapshotToken?: string;
  originalFullContent: string | null;
  modifiedFullContent: string | null;
  contentSource:
    | 'ledger-exact'
    | 'ledger-snapshot'
    | 'file-history'
    | 'snippet-reconstruction'
    | 'disk-current'
    | 'git-fallback'
    | 'unavailable';
}

// ── Phase 3: Per-Task Scoping types ──

/** Обнаруженная граница задачи в JSONL */
export interface TaskBoundary {
  taskId: string;
  event: 'start' | 'complete';
  lineNumber: number;
  timestamp: string;
  mechanism: 'TaskUpdate' | 'mcp';
  toolUseId?: string;
}

/** Детализированный уровень уверенности */
export interface TaskScopeConfidence {
  tier: 1 | 2 | 3 | 4;
  label: 'high' | 'medium' | 'low' | 'fallback';
  reason: string;
}

/** Scope изменений для одной задачи */
export interface TaskChangeScope {
  taskId: string;
  memberName: string;
  startLine: number;
  endLine: number;
  startTimestamp: string;
  endTimestamp: string;
  toolUseIds: string[];
  filePaths: string[];
  confidence: TaskScopeConfidence;
  primaryActorKey?: string;
  primaryAgentId?: string;
  primaryMemberName?: string;
  agentIds?: string[];
  memberNames?: string[];
  toolUseCount?: number;
  toolUseIdsTruncated?: boolean;
  phaseSet?: ('work' | 'review')[];
  executionSeqRange?: { start: number; end: number };
  confidenceBreakdown?: {
    capture: 'exact' | 'high' | 'medium' | 'low';
    attribution: 'high' | 'medium' | 'low' | 'ambiguous';
    reviewability: 'full-text' | 'mixed' | 'metadata-only';
  };
  contributors?: {
    actorKey: string;
    agentId?: string;
    memberName?: string;
    eventCount: number;
    noticeCount: number;
    touchedFileCount: number;
    visibleFileCount: number;
    toolUseCount: number;
    cumulativeLinesAdded: number;
    cumulativeLinesRemoved: number;
    firstTimestamp: string;
    lastTimestamp: string;
  }[];
  worktreePaths?: string[];
  worktreeBranches?: string[];
  baseWorkspaceRoots?: string[];
  dirtyLeaderWarnings?: string[];
}

/** Результат парсинга всех границ задач из JSONL файла */
export interface TaskBoundariesResult {
  boundaries: TaskBoundary[];
  scopes: TaskChangeScope[];
  isSingleTaskSession: boolean;
  detectedMechanism: 'TaskUpdate' | 'mcp' | 'none';
}

/** Расширенный TaskChangeSet с confidence деталями (backwards compatible) */
export interface TaskChangeSetV2 extends TaskChangeSet {
  scope: TaskChangeScope;
  warnings: string[];
  reviewDiagnostics?: TaskChangeReviewDiagnostic[];
  diffStatCompleteness?: 'complete' | 'partial';
  provenance?: TaskChangeProvenance;
}

export interface TaskChangeRequestOptions {
  owner?: string;
  status?: string;
  /** Persisted work intervals (preferred for reliable owner-log attribution). */
  intervals?: { startedAt: string; completedAt?: string }[];
  /** Back-compat: single since timestamp (deprecated). */
  since?: string;
  /** Derived task lifecycle bucket used for safe summary caching. */
  stateBucket?: 'approved' | 'review' | 'completed' | 'active';
  /** Lightweight response for summary UIs; skips snippets/timeline details. */
  summaryOnly?: boolean;
  /** Force a fresh recompute and overwrite any cache snapshot. */
  forceFresh?: boolean;
}

export interface TeamTaskChangeSummaryRequest {
  taskId: string;
  options?: TaskChangeRequestOptions;
}

export interface TeamTaskChangeSummaryItem {
  taskId: string;
  changeSet: TaskChangeSetV2 | null;
  error?: string;
}

export interface TeamTaskChangeSummariesResponse {
  teamName: string;
  items: TeamTaskChangeSummaryItem[];
  computedAt: string;
  truncated?: boolean;
}

// ── Phase 4: Enhanced Features types ──

/** Одно событие в timeline файла */
export interface FileEditEvent {
  /** tool_use.id */
  toolUseId: string;
  /** Тип операции */
  toolName: 'Edit' | 'Write' | 'MultiEdit' | 'NotebookEdit' | 'Bash' | 'PowerShell' | 'PostToolUse';
  /** Timestamp из JSONL */
  timestamp: string;
  /** Краткое описание: "Edited 3 lines", "Created new file", etc */
  summary: string;
  /** +/- строк */
  linesAdded: number;
  linesRemoved: number;
  /** Индекс snippet в FileChangeSummary.snippets[] */
  snippetIndex: number;
}

/** Timeline для файла */
export interface FileEditTimeline {
  filePath: string;
  events: FileEditEvent[];
  /** Общая длительность (first event → last event) */
  durationMs: number;
}
