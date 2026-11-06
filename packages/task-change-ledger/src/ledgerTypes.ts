import {
  TASK_CHANGE_FRESHNESS_SCHEMA_VERSION,
  TASK_CHANGE_JOURNAL_SCHEMA_VERSION,
  TASK_CHANGE_SUMMARY_SCHEMA_VERSION,
} from './artifactPaths.js';
import type {
  LedgerChangeRelation,
  LedgerContentState,
  TaskChangeJournalStamp,
  TaskChangeProvenance,
  TaskChangeScope,
} from './contracts.js';

export type LedgerConfidence = 'exact' | 'high' | 'medium' | 'low' | 'ambiguous';

export interface LedgerContentRef {
  sha256: string;
  sizeBytes: number;
  blobRef?: string;
  unavailableReason?: string;
}

export interface LedgerEvent {
  schemaVersion: typeof TASK_CHANGE_JOURNAL_SCHEMA_VERSION;
  eventId: string;
  taskId: string;
  taskRef: string;
  taskRefKind: 'canonical' | 'display' | 'unknown';
  phase: 'work' | 'review';
  executionSeq: number;
  sessionId: string;
  agentId?: string;
  memberName?: string;
  toolUseId: string;
  source:
    | 'file_edit'
    | 'file_write'
    | 'notebook_edit'
    | 'bash_simulated_sed'
    | 'shell_snapshot'
    | 'powershell_snapshot'
    | 'post_tool_hook_snapshot'
    | 'opencode_toolpart_write'
    | 'opencode_toolpart_edit'
    | 'opencode_toolpart_apply_patch';
  operation: 'create' | 'modify' | 'delete';
  confidence: LedgerConfidence;
  workspaceRoot: string;
  worktreePath?: string;
  worktreeBranch?: string;
  baseWorkspaceRoot?: string;
  dirtyLeaderWarning?: string;
  filePath: string;
  relativePath: string;
  timestamp: string;
  toolStatus: 'succeeded' | 'failed' | 'killed' | 'backgrounded';
  before: LedgerContentRef | null;
  after: LedgerContentRef | null;
  beforeState?: LedgerContentState;
  afterState?: LedgerContentState;
  relation?: LedgerChangeRelation;
  oldString?: string;
  newString?: string;
  linesAdded?: number;
  linesRemoved?: number;
  replaceAll?: boolean;
  warnings?: string[];
  sourceRuntime?: 'opencode';
  sourceProvider?: 'opencode';
  sourceImportKey?: string;
  evidenceProof?: string;
  /** Host-native rows without a validated file proof are metadata only. */
  causalBinding?: unknown;
  nativeCaptureProof?: unknown;
  supersedesEventId?: string;
  suppressed?: true;
  suppressionReason?: string;
  suppressedAt?: string;
  snapshotId?: string;
  snapshotSource?: string;
}

export interface LedgerNotice {
  schemaVersion: typeof TASK_CHANGE_JOURNAL_SCHEMA_VERSION;
  noticeId: string;
  taskId: string;
  taskRef: string;
  taskRefKind: 'canonical' | 'display' | 'unknown';
  phase: 'work' | 'review';
  executionSeq: number;
  sessionId: string;
  agentId?: string;
  memberName?: string;
  toolUseId?: string;
  timestamp: string;
  severity: 'warning';
  message: string;
  code?: 'multi-scope-skipped' | 'journal-recovered' | 'writer-lock-stolen';
}

export interface LedgerBundleFileV1 {
  filePath: string;
  relativePath: string;
  eventIds: string[];
  linesAdded: number;
  linesRemoved: number;
  isNewFile: boolean;
  latestAfterHash: string | null;
}

export interface LedgerBundleV1 {
  schemaVersion: 1;
  source: 'task-change-ledger';
  taskId: string;
  generatedAt: string;
  eventCount: number;
  files: LedgerBundleFileV1[];
  totalLinesAdded: number;
  totalLinesRemoved: number;
  totalFiles: number;
  confidence: 'high' | 'medium' | 'low';
  warnings: string[];
  events: LedgerEvent[];
  notices?: LedgerNotice[];
}

export interface LedgerSummaryContributorV2 {
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
}

export interface LedgerSummaryScopeV2 {
  confidence: TaskChangeScope['confidence'];
  primaryActorKey?: string;
  primaryAgentId?: string;
  primaryMemberName?: string;
  memberName: string;
  agentIds?: string[];
  memberNames?: string[];
  startTimestamp: string;
  endTimestamp: string;
  toolUseIds: string[];
  toolUseCount: number;
  toolUseIdsTruncated?: boolean;
  phaseSet: ('work' | 'review')[];
  executionSeqRange?: { start: number; end: number };
  confidenceBreakdown?: TaskChangeScope['confidenceBreakdown'];
  visibleFileCount: number;
  contributors: LedgerSummaryContributorV2[];
  worktreePaths?: string[];
  worktreeBranches?: string[];
  baseWorkspaceRoots?: string[];
  dirtyLeaderWarnings?: string[];
}

export interface LedgerSummaryFileV2 {
  changeKey: string;
  filePath: string;
  relativePath: string;
  displayPath?: string;
  linesAdded: number;
  linesRemoved: number;
  diffStatKnown: boolean;
  eventCount: number;
  firstTimestamp: string;
  lastTimestamp: string;
  latestOperation: 'create' | 'modify' | 'delete';
  createdInTask: boolean;
  deletedInTask: boolean;
  baselineExists?: boolean;
  finalExists?: boolean;
  latestBeforeHash: string | null;
  latestAfterHash: string | null;
  latestBeforeState?: LedgerContentState;
  latestAfterState?: LedgerContentState;
  contentAvailability: 'full-text' | 'hash-only' | 'metadata-only';
  reviewability: 'full-text' | 'partial-text' | 'metadata-only';
  relation?: LedgerChangeRelation;
  worktreePath?: string;
  worktreeBranch?: string;
  baseWorkspaceRoot?: string;
  dirtyLeaderWarning?: string;
  primaryActorKey?: string;
  agentIds: string[];
  memberNames?: string[];
  executionSeqRange?: { start: number; end: number };
  warnings?: string[];
}

export interface LedgerSummaryBundleV2 {
  schemaVersion: typeof TASK_CHANGE_SUMMARY_SCHEMA_VERSION;
  source: 'task-change-ledger';
  bundleKind: 'summary';
  taskId: string;
  generatedAt: string;
  journalStamp: TaskChangeJournalStamp;
  integrity: 'ok' | 'recovered' | 'partial';
  eventCount: number;
  noticeCount: number;
  scope: LedgerSummaryScopeV2;
  files: LedgerSummaryFileV2[];
  totalLinesAdded: number;
  totalLinesRemoved: number;
  diffStatCompleteness: 'complete' | 'partial';
  totalFiles: number;
  confidence: 'high' | 'medium' | 'low';
  warningCount: number;
  warnings: string[];
}

export interface LedgerFreshnessV2 {
  schemaVersion: typeof TASK_CHANGE_FRESHNESS_SCHEMA_VERSION;
  source: 'task-change-ledger';
  taskId: string;
  updatedAt: string;
  journalStamp: TaskChangeJournalStamp;
  eventCount: number;
  noticeCount: number;
  integrity: 'ok' | 'recovered' | 'partial';
  bundleSchemaVersion: 2;
  bundleKind: 'summary';
}

export interface JournalReadResult<T> {
  entries: T[];
  recovered: boolean;
  rejected: boolean;
}

export interface JournalData {
  events: LedgerEvent[];
  notices: LedgerNotice[];
  recovered: boolean;
}

export interface SummaryBundleRead {
  bundle: LedgerSummaryBundleV2;
  provenance: TaskChangeProvenance;
  mode: 'validated' | 'degraded';
  degradedWarning?: string;
}

/** Generic input evidence shares the Task event payload and blob namespace, without Task identity. */
export type AgentLedgerEvent = Omit<LedgerEvent, 'taskId' | 'taskRef' | 'taskRefKind'> & {
  artifactKind: 'agent-input';
  agentId: string;
  inputId: string;
  messageId: string;
};
export type AgentLedgerNotice = Omit<LedgerNotice, 'taskId' | 'taskRef' | 'taskRefKind'> & {
  artifactKind: 'agent-input';
  agentId: string;
  inputId: string;
  messageId: string;
};
export type EvidenceEvent = LedgerEvent | AgentLedgerEvent;
export type EvidenceNotice = LedgerNotice | AgentLedgerNotice;
