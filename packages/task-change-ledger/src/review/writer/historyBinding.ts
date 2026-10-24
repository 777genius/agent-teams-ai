import { createHash } from 'crypto';
import type {
  ReviewDiskUndoSnapshot,
  ReviewUndoAction,
  ReviewFileScope,
  ReviewPersistedStateSnapshot,
  ReviewRedoAction,
  ReviewDecisionSnapshot,
  FileChangeSummary,
} from '../../contracts.js';
import { getReviewActionDiskSnapshots } from './reviewHistoryDiskSteps.js';
import type { ReviewWriterContext } from './ports.js';
import type { ReviewPathAuthorization } from './displayedSnapshots.js';
import {
  validateAuthorizedReviewFilePath,
  getAuthoritativeReviewedFile,
  resolveAuthoritativeFileContent,
  assertExpectedAuthoritativeRename,
} from './scopeAuthorization.js';
import { parseReviewRenameRecoveryExpectation, parseReviewFileScope } from './validation.js';
import {
  isAuthoritativeReviewDeletion,
  assertExactGenericReviewHistoryTransition,
} from './historyAdmission.js';
import type { ReviewDecisionStore } from '../storage/ReviewDecisionStore.js';
import { isDurableReviewEqual } from './decisionBatch.js';
import { buildReviewUndoDecisionState } from './reviewHistoryDecisions.js';

import * as fs from 'fs/promises';

export function hashReviewPreimage(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

export function isAuthoritativelyBoundReviewSnapshot(snapshot: ReviewDiskUndoSnapshot): boolean {
  if (snapshot.authoritativeBeforeSha256 === undefined) return false;
  if (snapshot.authoritativeBeforeSha256 === null) {
    const mode =
      snapshot.restoreMode ?? (snapshot.renameExpectation ? 'restore-rejected-rename' : 'content');
    return (
      mode === 'delete-file' ||
      mode === 'restore-rejected-rename' ||
      mode === 'reapply-rejected-rename'
    );
  }
  return snapshot.authoritativeBeforeSha256 === hashReviewPreimage(snapshot.beforeContent);
}

export function assertAuthoritativelyBoundReviewAction(action: ReviewUndoAction): void {
  if (
    getReviewActionDiskSnapshots(action).some(
      (snapshot) => !isAuthoritativelyBoundReviewSnapshot(snapshot)
    )
  ) {
    throw new Error('Review history predates authoritative disk snapshots; reload Changes');
  }
}

export async function readAuthorizedReviewDiskContent(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return null;
    throw error;
  }
}

export async function bindNewReviewDiskSnapshot(
  env: Pick<ReviewWriterContext, 'assertActive' | 'content'>,
  snapshot: ReviewDiskUndoSnapshot,
  scope: ReviewFileScope,
  authorization: ReviewPathAuthorization
): Promise<ReviewDiskUndoSnapshot> {
  const filePath = await validateAuthorizedReviewFilePath(authorization, snapshot.filePath, {
    requireReviewedFile: true,
    rejectHardlinks: true,
  });
  const file = getAuthoritativeReviewedFile(authorization, filePath);
  const restoreMode =
    snapshot.restoreMode ?? (snapshot.renameExpectation ? 'restore-rejected-rename' : 'content');
  const isRenameMode =
    restoreMode === 'restore-rejected-rename' || restoreMode === 'reapply-rejected-rename';
  if (isRenameMode || snapshot.renameExpectation) {
    if (!isRenameMode || !snapshot.renameExpectation) {
      throw new Error('Rename recovery metadata does not match the review history mode');
    }
    const expectation = parseReviewRenameRecoveryExpectation(snapshot.renameExpectation);
    const authoritativeContent = await resolveAuthoritativeFileContent(
      env,
      scope,
      authorization,
      filePath
    );
    assertExpectedAuthoritativeRename(authoritativeContent, expectation);
    return {
      ...snapshot,
      filePath,
      beforeContent: '',
      afterContent: null,
      authoritativeBeforeSha256: null,
      file,
      restoreMode,
      renameExpectation: expectation,
      restoreConflict: undefined,
    };
  }
  const beforeContent = await readAuthorizedReviewDiskContent(filePath);
  if (beforeContent === null && restoreMode !== 'delete-file') {
    throw new Error('Review history preimage is missing; refusing an unsafe disk action');
  }
  const authoritativeContent = await resolveAuthoritativeFileContent(
    env,
    scope,
    authorization,
    filePath
  );
  if (restoreMode === 'create-file' && !authoritativeContent.isNewFile) {
    throw new Error('Create-file review history does not match an authoritative new file');
  }
  if (restoreMode === 'delete-file' && !isAuthoritativeReviewDeletion(file)) {
    throw new Error('Delete-file review history does not match an authoritative deletion');
  }
  let afterContent: string | null;
  if (restoreMode === 'create-file') {
    afterContent = null;
  } else if (restoreMode === 'delete-file') {
    afterContent = authoritativeContent.originalFullContent;
    if (afterContent === null) {
      throw new Error('Authoritative deleted-file baseline is unavailable');
    }
  } else {
    afterContent = beforeContent;
  }
  return {
    ...snapshot,
    filePath,
    beforeContent: beforeContent ?? '',
    afterContent,
    authoritativeBeforeSha256: beforeContent === null ? null : hashReviewPreimage(beforeContent),
    file,
    restoreMode,
    renameExpectation: undefined,
    restoreConflict: undefined,
  };
}

export function rebindReviewActionDescriptorPath(
  action: ReviewUndoAction,
  filePath: string
): ReviewUndoAction['descriptor'] {
  return action.descriptor && 'filePath' in action.descriptor
    ? { ...action.descriptor, filePath }
    : action.descriptor;
}

export async function bindNewReviewAction(
  env: Pick<ReviewWriterContext, 'assertActive' | 'content'>,
  action: ReviewUndoAction,
  current: Awaited<ReturnType<ReviewDecisionStore['load']>>,
  scope: ReviewFileScope | null,
  authorization: ReviewPathAuthorization | null
): Promise<ReviewUndoAction> {
  if (action.kind === 'hunk') return action;
  const decisionSnapshot = {
    hunkDecisions: { ...(current?.hunkDecisions ?? {}) },
    fileDecisions: { ...(current?.fileDecisions ?? {}) },
  };
  if (action.kind === 'bulk') {
    if (action.diskSnapshots.length === 0) return action;
    if (!scope || !authorization) {
      throw new Error('Review scope is unavailable for a new disk history action');
    }
    return {
      ...action,
      decisionSnapshot,
      diskSnapshots: await Promise.all(
        action.diskSnapshots.map((snapshot) =>
          bindNewReviewDiskSnapshot(env, snapshot, scope, authorization)
        )
      ),
    };
  }
  if (!scope || !authorization) {
    throw new Error('Review scope is unavailable for a new disk history action');
  }
  const snapshot = await bindNewReviewDiskSnapshot(
    env,
    action.action.snapshot,
    scope,
    authorization
  );
  return {
    ...action,
    descriptor: rebindReviewActionDescriptorPath(action, snapshot.filePath),
    action: {
      ...action.action,
      snapshot,
      file: snapshot.file,
      ...(action.action.originalIndex === undefined ? { decisionSnapshot } : {}),
    },
  };
}

export async function bindNewReviewHistorySnapshots(
  env: Pick<ReviewWriterContext, 'assertActive' | 'content'>,
  state: ReviewPersistedStateSnapshot,
  current: Awaited<ReturnType<ReviewDecisionStore['load']>>,
  scope: ReviewFileScope | null,
  authorization: ReviewPathAuthorization | null
): Promise<ReviewPersistedStateSnapshot> {
  const trustedActions = new Map<string, ReviewUndoAction>();
  const trustedRedo = new Map<string, ReviewRedoAction>();
  for (const action of current?.reviewActionHistory ?? []) trustedActions.set(action.id, action);
  for (const entry of current?.reviewRedoHistory ?? []) {
    trustedActions.set(entry.action.id, entry.action);
    trustedRedo.set(entry.action.id, entry);
  }
  const bindAction = (action: ReviewUndoAction): Promise<ReviewUndoAction> => {
    const trusted = trustedActions.get(action.id);
    return trusted
      ? Promise.resolve(trusted)
      : bindNewReviewAction(env, action, current, scope, authorization);
  };
  return {
    ...state,
    reviewActionHistory: await Promise.all((state.reviewActionHistory ?? []).map(bindAction)),
    reviewRedoHistory: await Promise.all(
      (state.reviewRedoHistory ?? []).map(async (entry) => {
        const trusted = trustedRedo.get(entry.action.id);
        return trusted ?? { ...entry, action: await bindAction(entry.action) };
      })
    ),
  };
}

export function hasNewReviewDiskHistory(
  state: ReviewPersistedStateSnapshot,
  current: Awaited<ReturnType<ReviewDecisionStore['load']>>
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
  current: Awaited<ReturnType<ReviewDecisionStore['load']>>
): ReviewUndoAction[] {
  const trustedIds = new Set<string>();
  for (const action of current?.reviewActionHistory ?? []) trustedIds.add(action.id);
  for (const entry of current?.reviewRedoHistory ?? []) trustedIds.add(entry.action.id);
  return [
    ...(state.reviewActionHistory ?? []),
    ...(state.reviewRedoHistory ?? []).map((entry) => entry.action),
  ].filter((action) => !trustedIds.has(action.id));
}

export function isGenericReviewSnapshotContainedByCurrent(
  incoming: ReviewPersistedStateSnapshot,
  current: Awaited<ReturnType<ReviewDecisionStore['load']>>,
  authorization: ReviewPathAuthorization
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
      getAuthoritativeReviewedFile(authorization, filePath)
    );
    if (!previous) return false;
    expectedDecisions = previous;
  }
  const recordIsContained = <T,>(
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

export function parseReviewScopeKey(teamName: string, scopeKey: string): ReviewFileScope {
  if (scopeKey.startsWith('task-')) {
    return parseReviewFileScope({ teamName, taskId: scopeKey.slice('task-'.length) });
  }
  if (scopeKey.startsWith('agent-')) {
    return parseReviewFileScope({ teamName, memberName: scopeKey.slice('agent-'.length) });
  }
  throw new Error('Review decision scope cannot authorize history');
}

export function isAuthorizedReviewDecisionKey(
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

export function assertReviewCandidateWithinAuthorization(
  state: ReviewPersistedStateSnapshot,
  authorization: ReviewPathAuthorization
): void {
  if (!authorization.reviewedFiles) {
    throw new Error('Authoritative review file set is unavailable');
  }
  const canonicalFiles = new Map<string, FileChangeSummary>();
  for (const file of authorization.reviewedFiles.values()) {
    canonicalFiles.set(file.changeKey ?? file.filePath, file);
  }
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
      const file = getAuthoritativeReviewedFile(authorization, action.action.filePath);
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
