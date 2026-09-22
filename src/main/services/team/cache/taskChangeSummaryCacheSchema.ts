import { TASK_CHANGE_DIAGNOSTIC_CODES } from '@shared/types/review';

import { TASK_CHANGE_SUMMARY_CACHE_SCHEMA_VERSION } from './taskChangeSummaryCacheTypes';

import type { PersistedTaskChangeSummaryEntry } from './taskChangeSummaryCacheTypes';
import type {
  FileChangeSummary,
  TaskChangeJournalFileStamp,
  TaskChangeJournalStamp,
  TaskChangeProvenance,
  TaskChangeReviewDiagnostic,
  TaskChangeSetV2,
} from '@shared/types';

const TASK_CHANGE_DIAGNOSTIC_CODE_SET = new Set<string>(TASK_CHANGE_DIAGNOSTIC_CODES);

function isTaskChangeDiagnosticCode(value: unknown): value is TaskChangeReviewDiagnostic['code'] {
  return typeof value === 'string' && TASK_CHANGE_DIAGNOSTIC_CODE_SET.has(value);
}

function isTaskChangeDiagnosticSeverity(
  value: unknown
): value is TaskChangeReviewDiagnostic['severity'] {
  return value === 'info' || value === 'warning' || value === 'error';
}

function isTaskChangeDiagnosticSource(
  value: unknown
): value is NonNullable<TaskChangeReviewDiagnostic['source']> {
  return value === 'ledger' || value === 'legacy' || value === 'summary' || value === 'runtime';
}

function normalizeIsoString(value: unknown): string | null {
  if (typeof value !== 'string' || value.trim() === '') return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

function normalizeString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function normalizeFileSummary(value: unknown): FileChangeSummary | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Partial<FileChangeSummary>;
  if (typeof candidate.filePath !== 'string' || typeof candidate.relativePath !== 'string') {
    return null;
  }

  return {
    filePath: candidate.filePath,
    relativePath: candidate.relativePath,
    snippets: [],
    linesAdded: Number.isFinite(candidate.linesAdded) ? Number(candidate.linesAdded) : 0,
    linesRemoved: Number.isFinite(candidate.linesRemoved) ? Number(candidate.linesRemoved) : 0,
    isNewFile: candidate.isNewFile === true,
  };
}

function normalizeReviewDiagnostic(value: unknown): TaskChangeReviewDiagnostic | null {
  if (typeof value === 'string') {
    const message = value.trim();
    return message
      ? {
          code: 'legacy_warning',
          severity: 'warning',
          reviewBlocking: true,
          message,
          source: 'legacy',
        }
      : null;
  }

  if (!value || typeof value !== 'object') return null;
  const candidate = value as Partial<TaskChangeReviewDiagnostic>;
  const message = typeof candidate.message === 'string' ? candidate.message.trim() : '';
  if (!message) {
    return null;
  }

  const source = isTaskChangeDiagnosticSource(candidate.source) ? { source: candidate.source } : {};
  if (
    isTaskChangeDiagnosticCode(candidate.code) &&
    isTaskChangeDiagnosticSeverity(candidate.severity) &&
    typeof candidate.reviewBlocking === 'boolean'
  ) {
    return {
      code: candidate.code,
      severity: candidate.severity,
      reviewBlocking: candidate.reviewBlocking,
      message,
      ...source,
    };
  }

  return {
    code: 'legacy_warning',
    severity: 'warning',
    reviewBlocking: true,
    message,
    ...source,
  };
}

function normalizeJournalFileStamp(value: unknown): TaskChangeJournalFileStamp | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Partial<TaskChangeJournalFileStamp>;
  if (!Number.isFinite(candidate.bytes) || !Number.isFinite(candidate.mtimeMs)) {
    return null;
  }

  return {
    bytes: Number(candidate.bytes),
    mtimeMs: Number(candidate.mtimeMs),
    tailSha256: typeof candidate.tailSha256 === 'string' ? candidate.tailSha256 : null,
  };
}

function normalizeJournalStamp(value: unknown): TaskChangeJournalStamp | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const candidate = value as Partial<TaskChangeJournalStamp>;
  const events = normalizeJournalFileStamp(candidate.events);
  const notices = normalizeJournalFileStamp(candidate.notices);
  if (!events && !notices) return undefined;
  return {
    ...(events ? { events } : {}),
    ...(notices ? { notices } : {}),
  };
}

function normalizeProvenance(value: unknown): TaskChangeProvenance | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const candidate = value as Partial<TaskChangeProvenance>;
  if (
    (candidate.sourceKind !== 'ledger' && candidate.sourceKind !== 'legacy') ||
    typeof candidate.sourceFingerprint !== 'string' ||
    candidate.sourceFingerprint.trim() === ''
  ) {
    return undefined;
  }

  const journalStamp = normalizeJournalStamp(candidate.journalStamp);
  return {
    sourceKind: candidate.sourceKind,
    sourceFingerprint: candidate.sourceFingerprint,
    ...(journalStamp ? { journalStamp } : {}),
    ...(Number.isFinite(candidate.bundleSchemaVersion)
      ? { bundleSchemaVersion: Number(candidate.bundleSchemaVersion) }
      : {}),
    ...(candidate.integrity === 'ok' ||
    candidate.integrity === 'recovered' ||
    candidate.integrity === 'partial'
      ? { integrity: candidate.integrity }
      : {}),
  };
}

function normalizeSummary(
  value: unknown,
  teamName: string,
  taskId: string
): TaskChangeSetV2 | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Partial<TaskChangeSetV2>;
  const files = Array.isArray(candidate.files)
    ? candidate.files
        .map(normalizeFileSummary)
        .filter((file): file is FileChangeSummary => file !== null)
    : null;
  const confidence =
    candidate.confidence === 'high' || candidate.confidence === 'medium'
      ? candidate.confidence
      : null;
  const computedAt = normalizeIsoString(candidate.computedAt);
  const reviewDiagnostics = Array.isArray(candidate.reviewDiagnostics)
    ? candidate.reviewDiagnostics
        .map(normalizeReviewDiagnostic)
        .filter((diagnostic): diagnostic is TaskChangeReviewDiagnostic => diagnostic !== null)
    : undefined;
  const diffStatCompleteness =
    candidate.diffStatCompleteness === 'complete' || candidate.diffStatCompleteness === 'partial'
      ? candidate.diffStatCompleteness
      : undefined;
  const provenance = normalizeProvenance(candidate.provenance);
  if (
    !files ||
    !confidence ||
    !computedAt ||
    !candidate.scope ||
    !Array.isArray(candidate.warnings)
  ) {
    return null;
  }

  return {
    teamName,
    taskId,
    files,
    totalFiles: Number.isFinite(candidate.totalFiles) ? Number(candidate.totalFiles) : files.length,
    totalLinesAdded: Number.isFinite(candidate.totalLinesAdded)
      ? Number(candidate.totalLinesAdded)
      : files.reduce((sum, file) => sum + file.linesAdded, 0),
    totalLinesRemoved: Number.isFinite(candidate.totalLinesRemoved)
      ? Number(candidate.totalLinesRemoved)
      : files.reduce((sum, file) => sum + file.linesRemoved, 0),
    confidence,
    computedAt,
    scope: candidate.scope,
    warnings: candidate.warnings.filter(
      (warning): warning is string => typeof warning === 'string'
    ),
    ...(reviewDiagnostics ? { reviewDiagnostics } : {}),
    ...(diffStatCompleteness ? { diffStatCompleteness } : {}),
    ...(provenance ? { provenance } : {}),
  };
}

export function toPersistedSummary(
  entry: PersistedTaskChangeSummaryEntry
): PersistedTaskChangeSummaryEntry {
  return {
    ...entry,
    version: TASK_CHANGE_SUMMARY_CACHE_SCHEMA_VERSION,
    summary: {
      ...entry.summary,
      files: entry.summary.files.map((file) => ({
        ...file,
        snippets: [],
        timeline: undefined,
      })),
    },
  };
}

export function normalizePersistedTaskChangeSummaryEntry(
  value: unknown
): PersistedTaskChangeSummaryEntry | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Partial<PersistedTaskChangeSummaryEntry>;
  if (candidate.version !== TASK_CHANGE_SUMMARY_CACHE_SCHEMA_VERSION) {
    return null;
  }

  const teamName = normalizeString(candidate.teamName);
  const taskId = normalizeString(candidate.taskId);
  const taskSignature = normalizeString(candidate.taskSignature);
  const sourceFingerprint = normalizeString(candidate.sourceFingerprint);
  const projectFingerprint = normalizeString(candidate.projectFingerprint);
  const writtenAt = normalizeIsoString(candidate.writtenAt);
  const expiresAt = normalizeIsoString(candidate.expiresAt);
  const stateBucket =
    candidate.stateBucket === 'approved' || candidate.stateBucket === 'completed'
      ? candidate.stateBucket
      : null;
  const extractorConfidence =
    candidate.extractorConfidence === 'high' || candidate.extractorConfidence === 'medium'
      ? candidate.extractorConfidence
      : null;

  if (
    !teamName ||
    !taskId ||
    !taskSignature ||
    !sourceFingerprint ||
    !projectFingerprint ||
    !writtenAt ||
    !expiresAt ||
    !stateBucket ||
    !extractorConfidence
  ) {
    return null;
  }

  const summary = normalizeSummary(candidate.summary, teamName, taskId);
  if (!summary) {
    return null;
  }

  return {
    version: TASK_CHANGE_SUMMARY_CACHE_SCHEMA_VERSION,
    teamName,
    taskId,
    stateBucket,
    taskSignature,
    sourceFingerprint,
    projectFingerprint,
    writtenAt,
    expiresAt,
    extractorConfidence,
    summary,
    debugMeta:
      candidate.debugMeta && typeof candidate.debugMeta === 'object'
        ? candidate.debugMeta
        : undefined,
  };
}
