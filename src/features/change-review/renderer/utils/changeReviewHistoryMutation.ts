import { normalizeReviewPathForIdentity } from '@renderer/utils/reviewKey';

import type {
  FileChangeSummary,
  HunkDecision,
  RetryReviewMutationRecoveryResult,
  ReviewDiskUndoSnapshot,
  ReviewPersistedStateSnapshot,
  ReviewRedoAction,
  ReviewUndoAction,
} from '@shared/types';

function toCanonicalReviewValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(toCanonicalReviewValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, toCanonicalReviewValue(entry)])
  );
}

export function areReviewPersistedStatesEqual(
  left: ReviewPersistedStateSnapshot,
  right: ReviewPersistedStateSnapshot
): boolean {
  return (
    JSON.stringify(toCanonicalReviewValue(left)) === JSON.stringify(toCanonicalReviewValue(right))
  );
}

export type ReviewHistoryRecoveryDisposition =
  | 'retry-restore'
  | 'apply-selected-restore'
  | 'different-mutation-pending'
  | 'synchronize-latest';

export function classifyReviewHistoryRecovery(
  recovery: RetryReviewMutationRecoveryResult,
  currentRevision: number,
  plannedState: ReviewPersistedStateSnapshot
): ReviewHistoryRecoveryDisposition {
  if (recovery.differentMutationPending) return 'different-mutation-pending';
  if (!recovery.recoveredMutation && recovery.decisionRevision === currentRevision) {
    return 'retry-restore';
  }
  if (
    recovery.expectedRestoreCompleted &&
    recovery.persistedState &&
    areReviewPersistedStatesEqual(recovery.persistedState, plannedState)
  ) {
    return 'apply-selected-restore';
  }
  return 'synchronize-latest';
}

export function createReviewRedoAction(
  action: ReviewUndoAction,
  state: {
    hunkDecisions: Record<string, HunkDecision>;
    fileDecisions: Record<string, HunkDecision>;
    hunkContextHashesByFile: Record<string, Record<number, string>>;
  }
): ReviewRedoAction {
  return {
    action: structuredClone(action),
    decisionSnapshot: {
      hunkDecisions: { ...state.hunkDecisions },
      fileDecisions: { ...state.fileDecisions },
    },
    hunkContextHashesByFile: structuredClone(state.hunkContextHashesByFile),
  };
}

export function getReviewDiskMutationExpectedContent(
  snapshot: ReviewDiskUndoSnapshot,
  direction: 'undo' | 'redo'
): string | null {
  const restoreMode =
    snapshot.restoreMode ?? (snapshot.renameExpectation ? 'restore-rejected-rename' : 'content');
  if (direction === 'undo') {
    return restoreMode === 'delete-file' || restoreMode === 'reapply-rejected-rename'
      ? null
      : snapshot.beforeContent;
  }
  return restoreMode === 'create-file' || restoreMode === 'restore-rejected-rename'
    ? null
    : snapshot.afterContent;
}

export function getReviewActionAffectedPaths(
  action: ReviewUndoAction,
  files: readonly FileChangeSummary[]
): string[] {
  if (action.kind === 'bulk') {
    return action.descriptor && 'filePath' in action.descriptor
      ? [action.descriptor.filePath]
      : files.map((file) => file.filePath);
  }
  return [action.kind === 'disk' ? action.action.snapshot.filePath : action.action.filePath];
}

export function getReviewActionsAffectedPaths(
  actions: readonly ReviewUndoAction[],
  files: readonly FileChangeSummary[]
): string[] {
  const seenPaths = new Set<string>();
  const affectedPaths: string[] = [];
  for (const action of actions) {
    for (const filePath of getReviewActionAffectedPaths(action, files)) {
      const normalizedPath = normalizeReviewPathForIdentity(filePath);
      if (seenPaths.has(normalizedPath)) continue;
      seenPaths.add(normalizedPath);
      const currentFile = files.find(
        (file) => normalizeReviewPathForIdentity(file.filePath) === normalizedPath
      );
      affectedPaths.push(currentFile?.filePath ?? filePath);
    }
  }
  return affectedPaths;
}

export function resolveReviewFile(
  files: readonly FileChangeSummary[],
  filePath: string,
  action?: ReviewUndoAction
): FileChangeSummary | null {
  const path = normalizeReviewPathForIdentity(filePath);
  const candidates = files.filter(
    (candidate) => normalizeReviewPathForIdentity(candidate.filePath) === path
  );
  if (action?.kind === 'disk') {
    const persisted = [action.action.file, action.action.snapshot.file].filter(
      (file): file is FileChangeSummary => file !== undefined
    );
    if (persisted.some((file) => normalizeReviewPathForIdentity(file.filePath) !== path)) {
      return null;
    }
    const keys = new Set(persisted.flatMap((file) => (file.changeKey ? [file.changeKey] : [])));
    if (keys.size > 1) return null;
    const key = [...keys][0];
    if (key) return candidates.filter((file) => file.changeKey === key).at(0) ?? null;
  }
  return candidates.length === 1 ? candidates[0] : null;
}
