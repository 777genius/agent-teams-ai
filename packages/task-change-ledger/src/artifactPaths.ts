import { createHash } from 'node:crypto';
import * as path from 'node:path';

export const TASK_CHANGE_JOURNAL_SCHEMA_VERSION = 1;
export const TASK_CHANGE_SUMMARY_SCHEMA_VERSION = 2;
export const TASK_CHANGE_FRESHNESS_SCHEMA_VERSION = 2;
export const TASK_CHANGE_LEDGER_DIRNAME = '.board-task-changes';
export const TASK_CHANGE_FRESHNESS_DIRNAME = '.board-task-change-freshness';
export const MAX_TASK_ID_ARTIFACT_SEGMENT_LENGTH = 120;
export const TASK_CHANGE_LEDGER_READ_LIMITS = Object.freeze({
  metadataBytes: 16 * 1024 * 1024,
  journalBytes: 32 * 1024 * 1024,
  journalEntries: 10_000,
  blobBytes: 8 * 1024 * 1024,
  blobConcurrency: 8,
});

export function isWindowsReservedArtifactSegment(segment: string): boolean {
  const stem = segment.split('.')[0]?.toUpperCase() ?? '';
  return (
    !segment ||
    stem === 'CON' ||
    stem === 'PRN' ||
    stem === 'AUX' ||
    stem === 'NUL' ||
    /^COM[1-9]$/.test(stem) ||
    /^LPT[1-9]$/.test(stem)
  );
}

export function encodeTaskId(taskId: string): string {
  const encoded = encodeURIComponent(taskId);
  return isWindowsReservedArtifactSegment(encoded) ||
    encoded.length > MAX_TASK_ID_ARTIFACT_SEGMENT_LENGTH
    ? `task-id-${createHash('sha256').update(taskId).digest('hex').slice(0, 32)}`
    : encoded;
}

export function taskIdArtifactSegments(taskId: string): string[] {
  const safe = encodeTaskId(taskId);
  const legacy = encodeURIComponent(taskId);
  return safe === legacy ? [safe] : [safe, legacy];
}

export function taskArtifactPathCandidates(
  projectDir: string,
  taskId: string,
  dirName: string,
  fileSuffix: string
): string[] {
  return taskIdArtifactSegments(taskId).map((segment) =>
    path.join(projectDir, dirName, `${segment}${fileSuffix}`)
  );
}

export function isPathWithinLedgerRoot(targetPath: string, rootPath: string): boolean {
  const relative = path.relative(rootPath, targetPath);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}
