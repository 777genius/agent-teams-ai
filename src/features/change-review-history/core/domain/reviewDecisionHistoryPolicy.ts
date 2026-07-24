import { buildReviewUndoDecisionState, isDurableReviewEqual } from '@features/review-mutations';

import type {
  LoadedReviewDecisionState,
  ReviewDecisionAuthorization,
} from '../application/ReviewDecisionHistoryPorts';
import type {
  FileChangeSummary,
  ReviewDecisionSnapshot,
  ReviewPersistedStateSnapshot,
  ReviewRedoAction,
  ReviewUndoAction,
} from '@shared/types/review';

function getCanonicalFiles(
  authorization: ReviewDecisionAuthorization
): Map<string, FileChangeSummary> {
  if (!authorization.files) {
    throw new Error('Authoritative review file set is unavailable');
  }
  const canonicalFiles = new Map<string, FileChangeSummary>();
  for (const file of authorization.files) {
    canonicalFiles.set(file.changeKey ?? file.filePath, file);
  }
  return canonicalFiles;
}

function isAuthorizedReviewDecisionKey(
  canonicalFiles: ReadonlyMap<string, FileChangeSummary>,
  key: string,
  hunk: boolean
): boolean {
  if (!hunk) return canonicalFiles.has(key);
  for (const reviewKey of canonicalFiles.keys()) {
    const prefix = `${reviewKey}:`;
    if (key.startsWith(prefix) && /^\d+$/.test(key.slice(prefix.length))) return true;
  }
  return false;
}

export function hasNewReviewDiskHistory(
  state: ReviewPersistedStateSnapshot,
  current: LoadedReviewDecisionState | null
): boolean {
  const trustedIds = new Set<string>();
  for (const action of current?.reviewActionHistory ?? []) trustedIds.add(action.id);
  for (const entry of current?.reviewRedoHistory ?? []) trustedIds.add(entry.action.id);
  const hasDisk = (action: ReviewUndoAction): boolean =>
    action.kind === 'disk' || (action.kind === 'bulk' && action.diskSnapshots.length > 0);
  return [
    ...(state.reviewActionHistory ?? []),
    ...(state.reviewRedoHistory ?? []).map((entry) => entry.action),
  ].some((action) => !trustedIds.has(action.id) && hasDisk(action));
}

export function getNewReviewHistoryActions(
  state: ReviewPersistedStateSnapshot,
  current: LoadedReviewDecisionState | null
): ReviewUndoAction[] {
  const trustedIds = new Set<string>();
  for (const action of current?.reviewActionHistory ?? []) trustedIds.add(action.id);
  for (const entry of current?.reviewRedoHistory ?? []) trustedIds.add(entry.action.id);
  return [
    ...(state.reviewActionHistory ?? []),
    ...(state.reviewRedoHistory ?? []).map((entry) => entry.action),
  ].filter((action) => !trustedIds.has(action.id));
}

export function bindTrustedReviewHistory(
  state: ReviewPersistedStateSnapshot,
  current: LoadedReviewDecisionState | null
): ReviewPersistedStateSnapshot {
  const trustedActions = new Map<string, ReviewUndoAction>();
  const trustedRedo = new Map<string, ReviewRedoAction>();
  for (const action of current?.reviewActionHistory ?? []) trustedActions.set(action.id, action);
  for (const entry of current?.reviewRedoHistory ?? []) {
    trustedActions.set(entry.action.id, entry.action);
    trustedRedo.set(entry.action.id, entry);
  }
  const bindAction = (action: ReviewUndoAction): ReviewUndoAction =>
    trustedActions.get(action.id) ?? action;
  return {
    ...state,
    reviewActionHistory: (state.reviewActionHistory ?? []).map(bindAction),
    reviewRedoHistory: (state.reviewRedoHistory ?? []).map(
      (entry) => trustedRedo.get(entry.action.id) ?? { ...entry, action: bindAction(entry.action) }
    ),
  };
}

export function isGenericReviewSnapshotContainedByCurrent(
  incoming: ReviewPersistedStateSnapshot,
  current: LoadedReviewDecisionState | null,
  authorization: ReviewDecisionAuthorization
): boolean {
  if (!current || incoming.reviewActionHistory.length === 0) return false;
  if (incoming.reviewRedoHistory.length > 0 || current.reviewRedoHistory.length > 0) return false;
  if (
    current.reviewActionHistory.length < incoming.reviewActionHistory.length ||
    !isDurableReviewEqual(
      current.reviewActionHistory.slice(0, incoming.reviewActionHistory.length),
      incoming.reviewActionHistory
    )
  ) {
    return false;
  }
  let expectedDecisions: ReviewDecisionSnapshot = {
    hunkDecisions: current.hunkDecisions,
    fileDecisions: current.fileDecisions,
  };
  for (
    let index = current.reviewActionHistory.length - 1;
    index >= incoming.reviewActionHistory.length;
    index--
  ) {
    const action = current.reviewActionHistory[index];
    if (!action) return false;
    const previous = buildReviewUndoDecisionState(action, expectedDecisions, (filePath) =>
      authorization.resolveFile(filePath)
    );
    if (!previous) return false;
    expectedDecisions = previous;
  }
  const recordIsContained = <T>(
    expected: Readonly<Record<string, T>>,
    observed: Readonly<Record<string, T>>
  ): boolean =>
    Object.entries(expected).every(([key, value]) => isDurableReviewEqual(value, observed[key]));
  return (
    isDurableReviewEqual(incoming.hunkDecisions, expectedDecisions.hunkDecisions) &&
    isDurableReviewEqual(incoming.fileDecisions, expectedDecisions.fileDecisions) &&
    recordIsContained(incoming.hunkContextHashesByFile ?? {}, current.hunkContextHashesByFile ?? {})
  );
}

export function assertReviewCandidateWithinAuthorization(
  state: ReviewPersistedStateSnapshot,
  authorization: ReviewDecisionAuthorization
): void {
  const canonicalFiles = getCanonicalFiles(authorization);
  if (
    Object.keys(state.hunkDecisions).some(
      (key) => !isAuthorizedReviewDecisionKey(canonicalFiles, key, true)
    ) ||
    Object.keys(state.fileDecisions).some(
      (key) => !isAuthorizedReviewDecisionKey(canonicalFiles, key, false)
    ) ||
    Object.keys(state.hunkContextHashesByFile ?? {}).some((key) => !canonicalFiles.has(key))
  ) {
    throw new Error('Review recovery branch contains decisions outside the active review');
  }

  const actions = [
    ...(state.reviewActionHistory ?? []),
    ...(state.reviewRedoHistory ?? []).map((entry) => entry.action),
  ];
  for (const action of actions) {
    if (action.kind === 'hunk') {
      const file = authorization.resolveFile(action.action.filePath);
      const key = `${file.changeKey ?? file.filePath}:${action.action.originalIndex}`;
      if (!isAuthorizedReviewDecisionKey(canonicalFiles, key, true)) {
        throw new Error('Review recovery branch contains an unauthorized hunk action');
      }
      continue;
    }
    if (action.kind === 'bulk') {
      if (
        Object.keys(action.decisionSnapshot.hunkDecisions).some(
          (key) => !isAuthorizedReviewDecisionKey(canonicalFiles, key, true)
        ) ||
        Object.keys(action.decisionSnapshot.fileDecisions).some(
          (key) => !isAuthorizedReviewDecisionKey(canonicalFiles, key, false)
        )
      ) {
        throw new Error('Review recovery branch contains an unauthorized bulk snapshot');
      }
    }
  }

  const isGenericAction = (action: ReviewUndoAction): boolean =>
    action.kind === 'hunk' || (action.kind === 'bulk' && action.diskSnapshots.length === 0);
  if (actions.every(isGenericAction)) {
    const undoHistory = state.reviewActionHistory ?? [];
    if (undoHistory.length > 0) {
      assertExactGenericReviewHistoryTransition(
        { ...state, reviewRedoHistory: [] },
        null,
        authorization,
        undoHistory
      );
    } else if (
      Object.keys(state.hunkDecisions).length > 0 ||
      Object.keys(state.fileDecisions).length > 0
    ) {
      throw new Error('Review recovery branch decisions have no matching Undo history');
    }
    let workingState: ReviewDecisionSnapshot = {
      hunkDecisions: state.hunkDecisions,
      fileDecisions: state.fileDecisions,
    };
    let workingHistory = [...undoHistory];
    const redoHistory = state.reviewRedoHistory ?? [];
    for (let index = redoHistory.length - 1; index >= 0; index--) {
      const redo = redoHistory[index];
      const nextHistory = [...workingHistory, redo.action];
      assertExactGenericReviewHistoryTransition(
        {
          hunkDecisions: redo.decisionSnapshot.hunkDecisions,
          fileDecisions: redo.decisionSnapshot.fileDecisions,
          reviewActionHistory: nextHistory,
          reviewRedoHistory: [],
        },
        {
          ...workingState,
          hunkContextHashesByFile: {},
          reviewActionHistory: workingHistory,
          reviewRedoHistory: [],
          revision: 0,
        },
        authorization,
        [redo.action]
      );
      workingState = redo.decisionSnapshot;
      workingHistory = nextHistory;
    }
  }
}

export function assertExactGenericReviewHistoryTransition(
  state: ReviewPersistedStateSnapshot,
  current: LoadedReviewDecisionState | null,
  authorization: ReviewDecisionAuthorization,
  newActions: readonly ReviewUndoAction[]
): void {
  const previousHistory = current?.reviewActionHistory ?? [];
  const nextHistory = state.reviewActionHistory ?? [];
  if (
    newActions.length === 0 ||
    newActions.some((action) =>
      (state.reviewRedoHistory ?? []).some((entry) => entry.action.id === action.id)
    ) ||
    nextHistory.length !== previousHistory.length + newActions.length ||
    !isDurableReviewEqual(nextHistory.slice(0, previousHistory.length), previousHistory) ||
    !isDurableReviewEqual(nextHistory.slice(previousHistory.length), newActions) ||
    (state.reviewRedoHistory?.length ?? 0) !== 0
  ) {
    throw new Error('Generic review history transition is not an exact append');
  }

  const canonicalFiles = getCanonicalFiles(authorization);
  const resolveHunkKey = (filePath: string, originalIndex: number): string => {
    const file = authorization.resolveFile(filePath);
    return `${file.changeKey ?? file.filePath}:${originalIndex}`;
  };
  const resolveHunkReviewKey = (key: string): string | null => {
    for (const reviewKey of canonicalFiles.keys()) {
      const prefix = `${reviewKey}:`;
      if (key.startsWith(prefix) && /^\d+$/.test(key.slice(prefix.length))) return reviewKey;
    }
    return null;
  };
  let working = {
    hunkDecisions: { ...state.hunkDecisions },
    fileDecisions: { ...state.fileDecisions },
  };
  const touchedHunkKeys = new Set<string>();
  for (let index = newActions.length - 1; index >= 0; index--) {
    const action = newActions[index];
    if (!action) continue;
    if (action.kind === 'disk') {
      throw new Error('Disk review history must be committed atomically with its mutation');
    }
    if (action.kind === 'hunk') {
      const key = resolveHunkKey(action.action.filePath, action.action.originalIndex);
      const value = working.hunkDecisions[key];
      if (touchedHunkKeys.has(key) || (value !== 'accepted' && value !== 'rejected')) {
        throw new Error('Generic hunk history does not match its decision transition');
      }
      if (action.descriptor) {
        const descriptor = action.descriptor;
        if (
          !('hunkIndex' in descriptor) ||
          descriptor.intent !== (value === 'accepted' ? 'accept-hunk' : 'reject-hunk') ||
          authorization.normalizePath(descriptor.filePath) !==
            authorization.normalizePath(action.action.filePath) ||
          descriptor.hunkIndex !== action.action.originalIndex
        ) {
          throw new Error('Generic hunk history descriptor does not match its decision transition');
        }
      }
      touchedHunkKeys.add(key);
      delete working.hunkDecisions[key];
      continue;
    }
    if (action.diskSnapshots.length > 0) {
      throw new Error('Disk review history must be committed atomically with its mutation');
    }

    const snapshot = action.decisionSnapshot;
    const hunkKeys = new Set([
      ...Object.keys(snapshot.hunkDecisions),
      ...Object.keys(working.hunkDecisions),
    ]);
    const fileKeys = new Set([
      ...Object.keys(snapshot.fileDecisions),
      ...Object.keys(working.fileDecisions),
    ]);
    const changedHunks = [...hunkKeys].filter(
      (key) => snapshot.hunkDecisions[key] !== working.hunkDecisions[key]
    );
    const changedFiles = [...fileKeys].filter(
      (key) => snapshot.fileDecisions[key] !== working.fileDecisions[key]
    );
    if (
      changedHunks.length + changedFiles.length === 0 ||
      changedHunks.some(
        (key) =>
          !isAuthorizedReviewDecisionKey(canonicalFiles, key, true) ||
          working.hunkDecisions[key] !== 'accepted'
      ) ||
      changedFiles.some(
        (key) =>
          !isAuthorizedReviewDecisionKey(canonicalFiles, key, false) ||
          working.fileDecisions[key] !== 'accepted'
      )
    ) {
      throw new Error('Generic bulk history does not match an authoritative Accept transition');
    }
    if (action.descriptor) {
      const affectedReviewKeys = new Set<string>(changedFiles);
      for (const key of changedHunks) {
        const reviewKey = resolveHunkReviewKey(key);
        if (reviewKey) affectedReviewKeys.add(reviewKey);
      }
      const descriptorMatches =
        action.descriptor.intent === 'accept-all'
          ? action.descriptor.fileCount === affectedReviewKeys.size
          : action.descriptor.intent === 'accept-file' &&
            affectedReviewKeys.size === 1 &&
            authorization.normalizePath(action.descriptor.filePath) ===
              authorization.normalizePath(
                canonicalFiles.get([...affectedReviewKeys][0])?.filePath ?? ''
              );
      if (!descriptorMatches) {
        throw new Error('Generic bulk history descriptor does not match its Accept transition');
      }
    }
    working = {
      hunkDecisions: { ...snapshot.hunkDecisions },
      fileDecisions: { ...snapshot.fileDecisions },
    };
  }

  if (
    !isDurableReviewEqual(working.hunkDecisions, current?.hunkDecisions ?? {}) ||
    !isDurableReviewEqual(working.fileDecisions, current?.fileDecisions ?? {})
  ) {
    throw new Error('Generic review history does not invert to the persisted decision state');
  }
}
