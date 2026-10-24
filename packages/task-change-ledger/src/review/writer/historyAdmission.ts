import type {
  ReviewPersistedStateSnapshot,
  ReviewUndoAction,
  FileChangeSummary,
  ExecuteReviewMutationRequest,
  ReviewFileScope,
  ReviewDiskUndoSnapshot,
} from '../../contracts.js';
import type { ReviewDecisionStore } from '../storage/ReviewDecisionStore.js';
import type { ReviewPathAuthorization } from './displayedSnapshots.js';
import { isDurableReviewEqual } from './decisionBatch.js';
import {
  getAuthoritativeReviewedFile,
  normalizeReviewPathForIdentity,
  validateAuthorizedReviewFilePath,
  resolveAuthoritativeFileContent,
} from './scopeAuthorization.js';
import {
  isAuthorizedReviewDecisionKey,
  assertAuthoritativelyBoundReviewAction,
  isAuthoritativelyBoundReviewSnapshot,
  bindNewReviewDiskSnapshot,
  rebindReviewActionDescriptorPath,
  readAuthorizedReviewDiskContent,
  hashReviewPreimage,
} from './historyBinding.js';
import {
  getReviewActionDiskSnapshots,
  buildForwardDiskMutationSteps,
  buildUndoDiskMutationSteps,
  buildRedoDiskMutationSteps,
} from './reviewHistoryDiskSteps.js';
import {
  buildReviewExternalReloadState,
  buildReviewRestoreDecisionState,
  buildReviewUndoDecisionState,
} from './reviewHistoryDecisions.js';
import type { ReviewWriterContext } from './ports.js';
import { threeWayTextMerge } from '../apply/threeWayTextMerge.js';

export function assertExactGenericReviewHistoryTransition(
  state: ReviewPersistedStateSnapshot,
  current: Awaited<ReturnType<ReviewDecisionStore['load']>>,
  authorization: ReviewPathAuthorization,
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
  const canonicalFiles = new Map<string, FileChangeSummary>();
  if (!authorization.reviewedFiles) {
    throw new Error('Authoritative review file set is unavailable');
  }
  for (const file of authorization.reviewedFiles.values()) {
    canonicalFiles.set(file.changeKey ?? file.filePath, file);
  }
  const resolveHunkKey = (filePath: string, originalIndex: number): string => {
    const file = getAuthoritativeReviewedFile(authorization, filePath);
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
          normalizeReviewPathForIdentity(descriptor.filePath) !==
            normalizeReviewPathForIdentity(action.action.filePath) ||
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
            normalizeReviewPathForIdentity(action.descriptor.filePath) ===
              normalizeReviewPathForIdentity(
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

export function assertExactReviewDiskSteps(
  request: ExecuteReviewMutationRequest,
  action: ReviewUndoAction,
  direction: 'forward' | 'undo' | 'redo'
): void {
  const snapshots = getReviewActionDiskSnapshots(action);
  const expectedSteps =
    direction === 'forward'
      ? buildForwardDiskMutationSteps(action.id, snapshots)
      : direction === 'undo'
        ? buildUndoDiskMutationSteps(action.id, snapshots)
        : buildRedoDiskMutationSteps(action.id, snapshots);
  if (!isDurableReviewEqual(request.diskSteps, expectedSteps)) {
    const label = direction === 'forward' ? request.kind : direction;
    throw new Error(
      `Review ${label[0]?.toUpperCase()}${label.slice(1)} disk mutation does not match durable history`
    );
  }
}

export function assertExactReviewHistoryTransition(
  request: ExecuteReviewMutationRequest,
  current: Awaited<ReturnType<ReviewDecisionStore['load']>>,
  authorization: ReviewPathAuthorization
): void {
  const next = request.persistedState;
  if (!Array.isArray(next.reviewActionHistory) || !Array.isArray(next.reviewRedoHistory)) {
    throw new Error('Review history transition is incomplete');
  }
  if (request.kind === 'reload-external') {
    if (typeof request.externalFilePath !== 'string' || request.diskSteps.length !== 0) {
      throw new Error('External review reload requires one reviewed file and no disk mutation');
    }
    const file = getAuthoritativeReviewedFile(authorization, request.externalFilePath);
    const expected = buildReviewExternalReloadState(file, {
      hunkDecisions: current?.hunkDecisions ?? {},
      fileDecisions: current?.fileDecisions ?? {},
      hunkContextHashesByFile: current?.hunkContextHashesByFile ?? {},
      reviewActionHistory: current?.reviewActionHistory ?? [],
      reviewRedoHistory: current?.reviewRedoHistory ?? [],
    });
    if (!isDurableReviewEqual(next, expected)) {
      throw new Error('Invalid durable external file reload transition');
    }
    return;
  }
  if (request.kind === 'restore' || request.kind === 'rename') {
    const previousActions = current?.reviewActionHistory ?? [];
    const action = next.reviewActionHistory.at(-1);
    const snapshot = action?.kind === 'disk' ? action.action.snapshot : null;
    const restoreMode =
      snapshot?.restoreMode ??
      (snapshot?.renameExpectation ? 'restore-rejected-rename' : 'content');
    const isRenameSnapshot =
      restoreMode === 'restore-rejected-rename' || restoreMode === 'reapply-rejected-rename';
    const authoritativeFile = snapshot
      ? getAuthoritativeReviewedFile(authorization, snapshot.filePath)
      : null;
    const expectedDecisions = authoritativeFile
      ? buildReviewRestoreDecisionState(authoritativeFile, {
          hunkDecisions: current?.hunkDecisions ?? {},
          fileDecisions: current?.fileDecisions ?? {},
        })
      : null;
    const transitionMatches =
      action?.kind === 'disk' &&
      authoritativeFile !== null &&
      action.action.file?.filePath === authoritativeFile.filePath &&
      action.action.file.changeKey === authoritativeFile.changeKey &&
      snapshot?.file?.filePath === authoritativeFile.filePath &&
      snapshot.file.changeKey === authoritativeFile.changeKey &&
      (action.descriptor === undefined ||
        (action.descriptor.intent ===
          (request.kind === 'rename' ? 'restore-rename' : 'restore-file') &&
          normalizeReviewPathForIdentity(action.descriptor.filePath) ===
            normalizeReviewPathForIdentity(snapshot.filePath))) &&
      isDurableReviewEqual(next.reviewActionHistory.slice(0, -1), previousActions) &&
      next.reviewRedoHistory.length === 0 &&
      isDurableReviewEqual(action.action.decisionSnapshot, {
        hunkDecisions: current?.hunkDecisions ?? {},
        fileDecisions: current?.fileDecisions ?? {},
      }) &&
      isDurableReviewEqual(
        next.hunkContextHashesByFile ?? {},
        current?.hunkContextHashesByFile ?? {}
      ) &&
      isDurableReviewEqual(next.hunkDecisions, expectedDecisions?.hunkDecisions) &&
      isDurableReviewEqual(next.fileDecisions, expectedDecisions?.fileDecisions) &&
      (request.kind === 'rename') === isRenameSnapshot;
    if (!transitionMatches || !action) {
      throw new Error(
        `Invalid durable ${request.kind === 'rename' ? 'Rename' : 'Restore'} history transition`
      );
    }
    assertExactReviewDiskSteps(request, action, 'forward');
    return;
  }
  if (!current) {
    throw new Error(
      `Review history changed; refusing stale ${request.kind === 'undo' ? 'Undo' : 'Redo'}`
    );
  }
  if (request.kind === 'undo') {
    const action = current.reviewActionHistory.at(-1);
    if (!request.expectedTopActionId) {
      throw new Error('Review Undo requires the expected durable action id');
    }
    if (!action || action.id !== request.expectedTopActionId) {
      throw new Error('Review history changed; refusing stale Undo');
    }
    assertAuthoritativelyBoundReviewAction(action);
    const redoEntry = next.reviewRedoHistory.at(-1);
    const expectedDecisions = buildReviewUndoDecisionState(
      action,
      { hunkDecisions: current.hunkDecisions, fileDecisions: current.fileDecisions },
      (filePath) => getAuthoritativeReviewedFile(authorization, filePath)
    );
    const transitionMatches =
      expectedDecisions !== null &&
      isDurableReviewEqual(next.reviewActionHistory, current.reviewActionHistory.slice(0, -1)) &&
      isDurableReviewEqual(next.reviewRedoHistory.slice(0, -1), current.reviewRedoHistory) &&
      isDurableReviewEqual(redoEntry?.action, action) &&
      isDurableReviewEqual(redoEntry?.decisionSnapshot, {
        hunkDecisions: current.hunkDecisions,
        fileDecisions: current.fileDecisions,
      }) &&
      isDurableReviewEqual(
        redoEntry?.hunkContextHashesByFile ?? {},
        current.hunkContextHashesByFile ?? {}
      ) &&
      isDurableReviewEqual(next.hunkDecisions, expectedDecisions.hunkDecisions) &&
      isDurableReviewEqual(next.fileDecisions, expectedDecisions.fileDecisions) &&
      isDurableReviewEqual(
        next.hunkContextHashesByFile ?? {},
        current.hunkContextHashesByFile ?? {}
      );
    if (!transitionMatches) {
      throw new Error('Invalid durable Undo history transition');
    }
    assertExactReviewDiskSteps(request, action, 'undo');
    return;
  }
  const redoEntry = current.reviewRedoHistory.at(-1);
  if (!request.expectedTopRedoActionId) {
    throw new Error('Review Redo requires the expected durable action id');
  }
  if (!redoEntry || redoEntry.action.id !== request.expectedTopRedoActionId) {
    throw new Error('Review history changed; refusing stale Redo');
  }
  assertAuthoritativelyBoundReviewAction(redoEntry.action);
  const transitionMatches =
    isDurableReviewEqual(next.reviewRedoHistory, current.reviewRedoHistory.slice(0, -1)) &&
    isDurableReviewEqual(next.reviewActionHistory, [
      ...current.reviewActionHistory,
      redoEntry.action,
    ]) &&
    isDurableReviewEqual(next.hunkDecisions, redoEntry.decisionSnapshot.hunkDecisions) &&
    isDurableReviewEqual(next.fileDecisions, redoEntry.decisionSnapshot.fileDecisions) &&
    isDurableReviewEqual(
      next.hunkContextHashesByFile ?? {},
      redoEntry.hunkContextHashesByFile ?? current.hunkContextHashesByFile ?? {}
    );
  if (!transitionMatches) {
    throw new Error('Invalid durable Redo history transition');
  }
  assertExactReviewDiskSteps(request, redoEntry.action, 'redo');
}

export function findLatestRestorableDiskSnapshot(
  current: Awaited<ReturnType<ReviewDecisionStore['load']>>,
  filePath: string
): ReturnType<typeof getReviewActionDiskSnapshots>[number] | null {
  if (!current) return null;
  const normalizedPath = normalizeReviewPathForIdentity(filePath);
  for (let index = current.reviewActionHistory.length - 1; index >= 0; index--) {
    const action = current.reviewActionHistory[index];
    if (!action) continue;
    const matchingSnapshot = [...getReviewActionDiskSnapshots(action)]
      .reverse()
      .find((candidate) => normalizeReviewPathForIdentity(candidate.filePath) === normalizedPath);
    if (!matchingSnapshot) continue;
    if (matchingSnapshot.restoreConflict) throw new Error(matchingSnapshot.restoreConflict);
    if (!isAuthoritativelyBoundReviewSnapshot(matchingSnapshot)) {
      throw new Error('Review history predates authoritative disk snapshots; reload Changes');
    }
    if (matchingSnapshot.renameExpectation) return null;
    if (action.kind === 'disk' && action.action.originalIndex !== undefined) continue;
    return matchingSnapshot;
  }
  return null;
}

export function isAuthoritativeReviewDeletion(file: FileChangeSummary): boolean {
  if (file.ledgerSummary?.latestOperation) {
    return file.ledgerSummary.latestOperation === 'delete';
  }
  if (file.ledgerSummary?.afterState?.exists !== undefined) {
    return !file.ledgerSummary.afterState.exists;
  }
  const latestLedger = file.snippets
    .filter((snippet) => snippet.ledger && !snippet.isError)
    .at(-1)?.ledger;
  return (
    latestLedger?.operation === 'delete' ||
    latestLedger?.afterState?.exists === false ||
    file.ledgerSummary?.deletedInTask === true
  );
}

export async function assertAuthoritativeForwardReviewMutation(
  env: Pick<ReviewWriterContext, 'assertActive' | 'content'>,
  request: ExecuteReviewMutationRequest,
  current: Awaited<ReturnType<ReviewDecisionStore['load']>>,
  scope: ReviewFileScope,
  authorization: ReviewPathAuthorization
): Promise<ReviewPersistedStateSnapshot> {
  if (request.kind !== 'restore' && request.kind !== 'rename') return request.persistedState;
  const action = request.persistedState.reviewActionHistory.at(-1);
  if (action?.kind !== 'disk' || action.action.originalIndex !== undefined) {
    throw new Error(`Invalid durable ${request.kind === 'rename' ? 'Rename' : 'Restore'} action`);
  }
  const snapshot = action.action.snapshot;
  const filePath = await validateAuthorizedReviewFilePath(authorization, snapshot.filePath, {
    requireReviewedFile: true,
    rejectHardlinks: true,
  });
  const authoritativeFile = getAuthoritativeReviewedFile(authorization, snapshot.filePath);
  const restoreMode =
    snapshot.restoreMode ?? (snapshot.renameExpectation ? 'restore-rejected-rename' : 'content');
  if (request.kind === 'rename') {
    if (restoreMode !== 'reapply-rejected-rename' || !snapshot.renameExpectation) {
      throw new Error('Review Rename mode does not match authoritative rename recovery');
    }
    const boundSnapshot = await bindNewReviewDiskSnapshot(env, snapshot, scope, authorization);
    return {
      ...request.persistedState,
      reviewActionHistory: [
        ...request.persistedState.reviewActionHistory.slice(0, -1),
        {
          ...action,
          descriptor: rebindReviewActionDescriptorPath(action, boundSnapshot.filePath),
          action: { ...action.action, snapshot: boundSnapshot, file: authoritativeFile },
        },
      ],
    };
  }
  if (snapshot.renameExpectation || restoreMode.includes('rename')) {
    throw new Error('Review Restore cannot use rename recovery metadata');
  }
  const authoritativeContent = await resolveAuthoritativeFileContent(
    env,
    scope,
    authorization,
    filePath
  );
  const previous = findLatestRestorableDiskSnapshot(current, filePath);
  const observedBeforeContent = await readAuthorizedReviewDiskContent(filePath);
  let expectedAfterContent: string | null;
  if (isAuthoritativeReviewDeletion(authoritativeFile)) {
    if (restoreMode !== 'create-file' || observedBeforeContent === null) {
      throw new Error('Review Restore deletion preimage or mode is not authoritative');
    }
    expectedAfterContent = null;
  } else if (authoritativeContent.isNewFile) {
    if (!previous || previous.afterContent === null) {
      if (restoreMode !== 'delete-file' || observedBeforeContent !== null) {
        throw new Error('A file now exists at this reviewed new-file path; refusing Restore');
      }
      expectedAfterContent = previous?.beforeContent ?? authoritativeContent.modifiedFullContent;
      if (expectedAfterContent === null) {
        throw new Error('Authoritative agent content is unavailable; refusing Restore');
      }
    } else {
      if (restoreMode !== 'content' || observedBeforeContent === null) {
        throw new Error('Review Restore new-file preimage or mode is not authoritative');
      }
      const merged = threeWayTextMerge(
        previous.afterContent,
        observedBeforeContent,
        previous.beforeContent
      );
      if (merged.hasConflicts) {
        throw new Error('Agent changes conflict with edits made after rejection.');
      }
      expectedAfterContent = merged.content;
    }
  } else {
    if (restoreMode !== 'content' || observedBeforeContent === null) {
      throw new Error('Review Restore content preimage or mode is not authoritative');
    }
    const desiredContent = previous?.beforeContent ?? authoritativeContent.modifiedFullContent;
    if (desiredContent === null) {
      throw new Error('Authoritative agent content is unavailable; refusing Restore');
    }
    const rejectedBaseline = previous?.afterContent ?? authoritativeContent.originalFullContent;
    if (rejectedBaseline === null) {
      throw new Error('Authoritative rejected baseline is unavailable; refusing Restore');
    }
    const merged = threeWayTextMerge(rejectedBaseline, observedBeforeContent, desiredContent);
    if (merged.hasConflicts) {
      throw new Error('Agent changes conflict with edits made after rejection.');
    }
    expectedAfterContent = merged.content;
  }
  const expectedBeforeContent = observedBeforeContent ?? '';
  if (snapshot.beforeContent !== expectedBeforeContent) {
    throw new Error('Review Restore preimage does not match the current reviewed file');
  }
  if (snapshot.afterContent !== expectedAfterContent) {
    throw new Error('Review Restore content does not match authoritative review history');
  }
  const boundSnapshot: ReviewDiskUndoSnapshot = {
    ...snapshot,
    filePath,
    beforeContent: expectedBeforeContent,
    authoritativeBeforeSha256:
      observedBeforeContent === null ? null : hashReviewPreimage(observedBeforeContent),
    file: authoritativeFile,
    restoreMode,
    renameExpectation: undefined,
    restoreConflict: undefined,
  };
  return {
    ...request.persistedState,
    reviewActionHistory: [
      ...request.persistedState.reviewActionHistory.slice(0, -1),
      {
        ...action,
        descriptor: rebindReviewActionDescriptorPath(action, boundSnapshot.filePath),
        action: { ...action.action, snapshot: boundSnapshot, file: authoritativeFile },
      },
    ],
  };
}
