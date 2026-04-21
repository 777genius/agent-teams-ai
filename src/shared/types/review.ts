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
  fileDecision: HunkDecision;
  hunkDecisions: Record<number, HunkDecision>;
  /** Optional stable hunk fingerprints (index → contextHash). Used to map decisions when indices drift. */
  hunkContextHashes?: Record<number, string>;
  /**
   * Optional context to apply decisions without re-resolving content in main process.
   * When present, main can use these values directly (safer in task mode where memberName may be unknown).
   */
  snippets?: SnippetDiff[];
  originalFullContent?: string | null;
  modifiedFullContent?: string | null;
  isNewFile?: boolean;
}

/** Запрос на применение review */
export interface ApplyReviewRequest {
  teamName: string;
  taskId?: string;
  memberName?: string;
  decisions: FileReviewDecision[];
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
}

/** Полный file content для CodeMirror */
export interface FileChangeWithContent extends FileChangeSummary {
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
  phaseSet?: Array<'work' | 'review'>;
  executionSeqRange?: { start: number; end: number };
  confidenceBreakdown?: {
    capture: 'exact' | 'high' | 'medium' | 'low';
    attribution: 'high' | 'medium' | 'low' | 'ambiguous';
    reviewability: 'full-text' | 'mixed' | 'metadata-only';
  };
  contributors?: Array<{
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
  }>;
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
  diffStatCompleteness?: 'complete' | 'partial';
  provenance?: TaskChangeProvenance;
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
