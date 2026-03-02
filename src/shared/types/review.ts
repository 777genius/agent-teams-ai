/** Один snippet-level дифф от одного tool_use */
export interface SnippetDiff {
  toolUseId: string;
  filePath: string;
  toolName: 'Edit' | 'Write' | 'MultiEdit';
  type: 'edit' | 'write-new' | 'write-update' | 'multi-edit';
  oldString: string;
  newString: string;
  replaceAll: boolean;
  timestamp: string;
  isError: boolean;
  /** Hash of ±3 surrounding context lines for reliable hunk↔snippet matching */
  contextHash?: string;
}

/** Агрегированные изменения по файлу */
export interface FileChangeSummary {
  filePath: string;
  relativePath: string;
  snippets: SnippetDiff[];
  linesAdded: number;
  linesRemoved: number;
  isNewFile: boolean;
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
  errors: { filePath: string; error: string }[];
}

/** Полный file content для CodeMirror */
export interface FileChangeWithContent extends FileChangeSummary {
  originalFullContent: string | null;
  modifiedFullContent: string | null;
  contentSource:
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
  mechanism: 'TaskUpdate' | 'teamctl';
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
}

/** Результат парсинга всех границ задач из JSONL файла */
export interface TaskBoundariesResult {
  boundaries: TaskBoundary[];
  scopes: TaskChangeScope[];
  isSingleTaskSession: boolean;
  detectedMechanism: 'TaskUpdate' | 'teamctl' | 'none';
}

/** Расширенный TaskChangeSet с confidence деталями (backwards compatible) */
export interface TaskChangeSetV2 extends TaskChangeSet {
  scope: TaskChangeScope;
  warnings: string[];
}

// ── Phase 4: Enhanced Features types ──

/** Одно событие в timeline файла */
export interface FileEditEvent {
  /** tool_use.id */
  toolUseId: string;
  /** Тип операции */
  toolName: 'Edit' | 'Write' | 'MultiEdit' | 'NotebookEdit';
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
