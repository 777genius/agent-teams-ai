import path from 'path';

import { isReadOnlyBoardTaskLogToolName } from './boardTaskLogToolNames';

import type { BoardTaskActivityRecord } from '../activity/BoardTaskActivityRecord';

export type TaskLogTranscriptCandidateReason =
  | 'direct_record_file'
  | 'same_session_non_read_record';

export interface TaskLogTranscriptCandidateFile {
  filePath: string;
  reason: TaskLogTranscriptCandidateReason;
  sessionId?: string;
  sourceRecordIds: string[];
}

export interface TaskLogTranscriptCandidateSelectionDiagnostics {
  recordFileCount: number;
  nonReadSessionCount: number;
  sameSessionFileCount: number;
  alreadyParsedCandidateCount: number;
  finalCandidateCount: number;
  reason: 'direct_record_files' | 'same_session_native_window' | 'no_candidates';
}

export interface TaskLogTranscriptCandidateSelection {
  filePaths: string[];
  candidates: TaskLogTranscriptCandidateFile[];
  diagnostics: TaskLogTranscriptCandidateSelectionDiagnostics;
}

export interface SelectInferredNativeTranscriptFilesInput {
  records: readonly BoardTaskActivityRecord[];
  transcriptFiles: readonly string[];
  projectDir?: string;
  alreadyParsedFilePaths?: ReadonlySet<string>;
}

interface TranscriptSessionIndex {
  filesBySessionId: Map<string, string[]>;
  sessionIdByFilePath: Map<string, string>;
}

function normalizeSessionId(value: string | undefined): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

function extractTranscriptSessionId(
  projectDir: string | undefined,
  filePath: string
): string | null {
  if (!projectDir) {
    return null;
  }

  const relativePath = path.relative(projectDir, filePath);
  if (!relativePath || relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
    return null;
  }

  const parts = relativePath.split(path.sep).filter(Boolean);
  if (parts.length === 1 && parts[0]?.endsWith('.jsonl')) {
    return parts[0].slice(0, -'.jsonl'.length);
  }

  if (parts.length >= 3 && parts[1] === 'subagents' && parts[2]?.endsWith('.jsonl')) {
    return parts[0] ?? null;
  }

  return null;
}

function buildTranscriptSessionIndex(
  transcriptFiles: readonly string[],
  projectDir: string | undefined
): TranscriptSessionIndex {
  const filesBySessionId = new Map<string, string[]>();
  const sessionIdByFilePath = new Map<string, string>();

  for (const filePath of transcriptFiles) {
    const sessionId = extractTranscriptSessionId(projectDir, filePath);
    if (!sessionId) {
      continue;
    }
    sessionIdByFilePath.set(filePath, sessionId);
    const files = filesBySessionId.get(sessionId) ?? [];
    files.push(filePath);
    filesBySessionId.set(sessionId, files);
  }

  for (const [sessionId, files] of filesBySessionId.entries()) {
    filesBySessionId.set(
      sessionId,
      [...new Set(files)].sort((left, right) => left.localeCompare(right))
    );
  }

  return { filesBySessionId, sessionIdByFilePath };
}

function isReadOnlyRecord(record: BoardTaskActivityRecord): boolean {
  return (
    record.action?.category === 'read' ||
    isReadOnlyBoardTaskLogToolName(record.action?.canonicalToolName)
  );
}

function addCandidate(
  candidatesByFilePath: Map<string, TaskLogTranscriptCandidateFile>,
  filePath: string,
  candidate: Omit<TaskLogTranscriptCandidateFile, 'filePath'>
): void {
  const existing = candidatesByFilePath.get(filePath);
  if (!existing) {
    candidatesByFilePath.set(filePath, {
      filePath,
      ...candidate,
      sourceRecordIds: [...new Set(candidate.sourceRecordIds)].sort((left, right) =>
        left.localeCompare(right)
      ),
    });
    return;
  }

  existing.sourceRecordIds = [
    ...new Set([...existing.sourceRecordIds, ...candidate.sourceRecordIds]),
  ].sort((left, right) => left.localeCompare(right));

  if (existing.reason !== 'direct_record_file' && candidate.reason === 'direct_record_file') {
    existing.reason = candidate.reason;
  }
  if (!existing.sessionId && candidate.sessionId) {
    existing.sessionId = candidate.sessionId;
  }
}

export class TaskLogTranscriptCandidateSelector {
  selectInferredNativeTranscriptFiles(
    input: SelectInferredNativeTranscriptFilesInput
  ): TaskLogTranscriptCandidateSelection {
    const alreadyParsedFilePaths = input.alreadyParsedFilePaths ?? new Set<string>();
    const sessionIndex = buildTranscriptSessionIndex(input.transcriptFiles, input.projectDir);
    const candidatesByFilePath = new Map<string, TaskLogTranscriptCandidateFile>();
    const recordFiles = new Set<string>();
    const nonReadSessionIds = new Set<string>();
    const sameSessionFiles = new Set<string>();

    for (const record of input.records) {
      if (record.source.filePath) {
        recordFiles.add(record.source.filePath);
        addCandidate(candidatesByFilePath, record.source.filePath, {
          reason: 'direct_record_file',
          sessionId:
            normalizeSessionId(record.actor.sessionId) ??
            sessionIndex.sessionIdByFilePath.get(record.source.filePath),
          sourceRecordIds: [record.id],
        });
      }

      if (isReadOnlyRecord(record)) {
        continue;
      }

      const sessionId =
        normalizeSessionId(record.actor.sessionId) ??
        sessionIndex.sessionIdByFilePath.get(record.source.filePath);
      if (!sessionId) {
        continue;
      }

      nonReadSessionIds.add(sessionId);
      for (const filePath of sessionIndex.filesBySessionId.get(sessionId) ?? []) {
        sameSessionFiles.add(filePath);
        addCandidate(candidatesByFilePath, filePath, {
          reason: 'same_session_non_read_record',
          sessionId,
          sourceRecordIds: [record.id],
        });
      }
    }

    const candidates = [...candidatesByFilePath.values()].sort((left, right) =>
      left.filePath.localeCompare(right.filePath)
    );
    const filePaths = candidates
      .map((candidate) => candidate.filePath)
      .filter((filePath) => !alreadyParsedFilePaths.has(filePath));

    const alreadyParsedCandidateCount = candidates.length - filePaths.length;
    const reason =
      candidates.length === 0
        ? 'no_candidates'
        : nonReadSessionIds.size > 0
          ? 'same_session_native_window'
          : 'direct_record_files';

    return {
      filePaths,
      candidates,
      diagnostics: {
        recordFileCount: recordFiles.size,
        nonReadSessionCount: nonReadSessionIds.size,
        sameSessionFileCount: sameSessionFiles.size,
        alreadyParsedCandidateCount,
        finalCandidateCount: filePaths.length,
        reason,
      },
    };
  }
}
