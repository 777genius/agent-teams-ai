import { isReviewFileFullyRejected } from '@renderer/components/team/review/reviewActionState';
import {
  isReviewAcceptDisabled,
  isReviewFileMissingOnDisk,
  isReviewRejectable,
  isReviewTextContentUnavailable,
} from '@renderer/components/team/review/reviewContentPreview';
import { getFileHunkCount } from '@renderer/store/slices/changeReviewSlice';
import { sortItemsAsTree } from '@renderer/utils/fileTreeBuilder';
import { displayMemberName } from '@renderer/utils/memberHelpers';
import { buildHunkDecisionKey, getFileReviewKey } from '@renderer/utils/reviewKey';
import { normalizePathForComparison } from '@shared/utils/platformPath';
import { classifyTaskChangeReviewability } from '@shared/utils/taskChangeReviewability';

import type {
  AgentChangeSet,
  FileChangeSummary,
  FileChangeWithContent,
  GlobalTask,
  HunkDecision,
  TaskChangeSet,
  TaskChangeSetV2,
} from '@shared/types';

export type ChangeReviewChangeSet = AgentChangeSet | TaskChangeSet | TaskChangeSetV2;

export interface GlobalDiffLoadingState {
  totalFilesCount: number;
  readyFilesCount: number;
  loadingFilesCount: number;
  snippetCount: number;
  activeFileName: string | undefined;
}

export interface ReviewStats {
  pending: number;
  accepted: number;
  rejected: number;
}

export interface ReviewChangeStats {
  linesAdded: number;
  linesRemoved: number;
  filesChanged: number;
}

export interface TaskChangesEmptyStatePresentation {
  icon: 'alert' | 'info' | 'file-search';
  tone: 'attention' | 'neutral';
  titleKey:
    | 'review.empty.noSafeDiff'
    | 'review.continuousScroll.empty'
    | 'review.empty.noFileChangesRecorded';
  descriptionKey:
    | 'review.empty.noSafeDiffDescription'
    | 'review.empty.noSafeDiffDiagnosticsDescription'
    | 'review.empty.noFileEventsYet'
    | 'review.empty.noFileEvents';
  messages: string[];
}

export function isTaskChangeSetV2(changeSet: { teamName: string }): changeSet is TaskChangeSetV2 {
  return 'scope' in changeSet;
}

export function sortChangeReviewFiles(files: readonly FileChangeSummary[]): FileChangeSummary[] {
  return sortItemsAsTree([...files], (file) => file.relativePath);
}

export function buildReviewFileLabels(
  files: readonly FileChangeSummary[]
): ReadonlyMap<string, string> {
  return new Map(
    files.map((file) => [
      normalizePathForComparison(file.filePath),
      file.relativePath || file.filePath,
    ])
  );
}

export function resolveReviewFileLabel(
  labels: ReadonlyMap<string, string>,
  filePath: string
): string {
  return labels.get(normalizePathForComparison(filePath)) ?? filePath;
}

export function buildWatchedReviewFilePathsKey(files: readonly FileChangeSummary[]): string {
  return files.map((file) => file.filePath).join('\0');
}

export function buildGlobalDiffLoadingState(input: {
  files: readonly FileChangeSummary[];
  activeFilePath: string | null;
  fileContentsLoading: Readonly<Record<string, boolean>>;
  fileContents: Readonly<Record<string, FileChangeWithContent>>;
}): GlobalDiffLoadingState | null {
  const loadingFiles = input.files.filter((file) => input.fileContentsLoading[file.filePath]);
  if (loadingFiles.length === 0) return null;

  const preferredFile =
    (input.activeFilePath
      ? loadingFiles.find((file) => file.filePath === input.activeFilePath)
      : undefined) ?? loadingFiles[0];

  return {
    totalFilesCount: input.files.length,
    readyFilesCount: input.files.filter((file) => file.filePath in input.fileContents).length,
    loadingFilesCount: loadingFiles.length,
    snippetCount: loadingFiles.reduce(
      (sum, file) => sum + file.snippets.filter((snippet) => !snippet.isError).length,
      0
    ),
    activeFileName: preferredFile?.relativePath ?? preferredFile?.filePath,
  };
}

export function getRejectablePendingReviewFiles(input: {
  files: readonly FileChangeSummary[];
  editedContents: Readonly<Record<string, string>>;
  fileChunkCounts: Readonly<Record<string, number>>;
  fileContents: Readonly<Record<string, FileChangeWithContent>>;
  fileDecisions: Readonly<Record<string, HunkDecision>>;
  hunkDecisions: Readonly<Record<string, HunkDecision>>;
}): FileChangeSummary[] {
  return input.files.filter((file) => {
    const reviewKey = getFileReviewKey(file);
    const fileDecision =
      input.fileDecisions[reviewKey] ?? input.fileDecisions[file.filePath] ?? 'pending';
    if (fileDecision !== 'pending') return false;
    if (file.filePath in input.editedContents) return false;
    const count = getFileHunkCount(file.filePath, file.snippets.length, input.fileChunkCounts);
    if (
      isReviewFileFullyRejected(file, count, {
        hunkDecisions: input.hunkDecisions,
        fileDecisions: input.fileDecisions,
      })
    ) {
      return false;
    }
    return isReviewRejectable(file, input.fileContents[file.filePath] ?? null);
  });
}

export function canAcceptAllReviewFiles(input: {
  files: readonly FileChangeSummary[];
  editedContents: Readonly<Record<string, string>>;
  fileContents: Readonly<Record<string, FileChangeWithContent>>;
  fileDecisions: Readonly<Record<string, HunkDecision>>;
}): boolean {
  return (
    input.files.length > 0 &&
    input.files.every((file) => {
      if (!(file.filePath in input.fileContents) || file.filePath in input.editedContents) {
        return false;
      }
      const content = input.fileContents[file.filePath] ?? null;
      const reviewKey = getFileReviewKey(file);
      const fileDecision = input.fileDecisions[reviewKey] ?? input.fileDecisions[file.filePath];
      return !isReviewAcceptDisabled({
        hasEdits: false,
        isMissingOnDisk: isReviewFileMissingOnDisk(content),
        isContentUnavailable: isReviewTextContentUnavailable(file, content),
        fileDecision,
      });
    })
  );
}

export function buildReviewStats(input: {
  changeSet: ChangeReviewChangeSet | null;
  hunkDecisions: Readonly<Record<string, HunkDecision>>;
  fileDecisions: Readonly<Record<string, HunkDecision>>;
  fileChunkCounts: Readonly<Record<string, number>>;
}): ReviewStats {
  if (!input.changeSet) return { pending: 0, accepted: 0, rejected: 0 };

  const stats: ReviewStats = { pending: 0, accepted: 0, rejected: 0 };
  for (const file of input.changeSet.files) {
    const reviewKey = getFileReviewKey(file);
    const fileDecision = input.fileDecisions[reviewKey] ?? input.fileDecisions[file.filePath];
    const count = getFileHunkCount(file.filePath, file.snippets.length, input.fileChunkCounts);

    if (fileDecision === 'accepted' || fileDecision === 'rejected') {
      stats[fileDecision] += count;
      continue;
    }

    for (let index = 0; index < count; index += 1) {
      const decision =
        input.hunkDecisions[buildHunkDecisionKey(reviewKey, index)] ??
        input.hunkDecisions[`${file.filePath}:${index}`] ??
        'pending';
      stats[decision] += 1;
    }
  }
  return stats;
}

export function buildReviewChangeStats(changeSet: ChangeReviewChangeSet | null): ReviewChangeStats {
  if (!changeSet) return { linesAdded: 0, linesRemoved: 0, filesChanged: 0 };
  return {
    linesAdded: changeSet.totalLinesAdded,
    linesRemoved: changeSet.totalLinesRemoved,
    filesChanged: changeSet.totalFiles,
  };
}

export function toTaskChangeSetV2(changeSet: ChangeReviewChangeSet | null): TaskChangeSetV2 | null {
  return changeSet && isTaskChangeSetV2(changeSet) ? changeSet : null;
}

export function shouldShowTaskScopeBanner(input: {
  mode: 'agent' | 'task';
  changeSet: TaskChangeSetV2 | null;
}): boolean {
  return (
    input.mode === 'task' &&
    !!input.changeSet &&
    (input.changeSet.provenance?.sourceKind !== 'ledger' ||
      classifyTaskChangeReviewability(input.changeSet).reviewability === 'attention_required' ||
      input.changeSet.scope.confidence.tier > 1)
  );
}

export function findActiveReviewFile(
  changeSet: ChangeReviewChangeSet | null,
  activeFilePath: string | null
): FileChangeSummary | null {
  if (!changeSet || !activeFilePath) return null;
  return changeSet.files.find((file) => file.filePath === activeFilePath) ?? null;
}

export function buildChangeReviewTitle(input: {
  mode: 'agent' | 'task';
  memberName?: string;
  taskId?: string;
  globalTasks: readonly GlobalTask[];
}): string {
  if (input.mode === 'agent') {
    return `Changes by ${displayMemberName(input.memberName ?? 'unknown')}`;
  }
  const task = input.taskId
    ? input.globalTasks.find((candidate) => candidate.id === input.taskId)
    : undefined;
  const shortId = task?.displayId ?? input.taskId?.slice(0, 8) ?? '?';
  return task?.subject
    ? `Changes for task #${shortId} - ${task.subject}`
    : `Changes for task #${shortId}`;
}

export function buildTaskChangesEmptyStatePresentation(
  changeSet: TaskChangeSetV2 | null
): TaskChangesEmptyStatePresentation {
  const status = changeSet ? classifyTaskChangeReviewability(changeSet) : null;
  const diagnosticMessages =
    status && status.diagnostics.length > 0
      ? status.diagnostics.map((diagnostic) => diagnostic.message)
      : (changeSet?.warnings ?? []);
  const messages = [...new Set(diagnosticMessages.filter((message) => message.trim().length > 0))];
  const isAttention = status?.reviewability === 'attention_required';
  const isDiagnosticOnly = status?.reviewability === 'diagnostic_only';
  const hasDiagnosticContext = messages.length > 0;

  return {
    icon: isAttention ? 'alert' : hasDiagnosticContext ? 'info' : 'file-search',
    tone: isAttention ? 'attention' : 'neutral',
    titleKey: isDiagnosticOnly
      ? 'review.empty.noSafeDiff'
      : isAttention
        ? 'review.continuousScroll.empty'
        : 'review.empty.noFileChangesRecorded',
    descriptionKey:
      isAttention || isDiagnosticOnly
        ? isDiagnosticOnly
          ? 'review.empty.noSafeDiffDescription'
          : 'review.empty.noSafeDiffDiagnosticsDescription'
        : hasDiagnosticContext
          ? 'review.empty.noFileEventsYet'
          : 'review.empty.noFileEvents',
    messages,
  };
}
