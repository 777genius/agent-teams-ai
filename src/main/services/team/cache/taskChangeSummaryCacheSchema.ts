import { TASK_CHANGE_SUMMARY_CACHE_SCHEMA_VERSION } from './taskChangeSummaryCacheTypes';

import type { FileChangeSummary, TaskChangeSetV2 } from '@shared/types';
import type { PersistedTaskChangeSummaryEntry } from './taskChangeSummaryCacheTypes';

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
