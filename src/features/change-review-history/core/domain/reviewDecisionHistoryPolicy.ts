export type HunkDecision = 'accepted' | 'rejected' | 'pending';

export interface ReviewDecisionFile {
  filePath: string;
  changeKey?: string;
}

export interface ReviewDecisionSnapshot {
  hunkDecisions: Record<string, HunkDecision>;
  fileDecisions: Record<string, HunkDecision>;
}

export type ReviewActionDescriptor =
  | {
      intent: 'accept-hunk' | 'reject-hunk';
      filePath: string;
      hunkIndex: number;
    }
  | {
      intent: 'accept-file' | 'reject-file' | 'restore-file' | 'restore-rename';
      filePath: string;
    }
  | { intent: 'accept-all' | 'reject-all'; fileCount: number };

interface ReviewUndoActionBase {
  id: string;
  createdAt: string;
  descriptor?: ReviewActionDescriptor;
}

export type ReviewUndoAction =
  | (ReviewUndoActionBase & {
      kind: 'bulk';
      decisionSnapshot: ReviewDecisionSnapshot;
      diskSnapshots: {
        filePath: string;
        beforeContent: string;
        afterContent: string | null;
      }[];
    })
  | (ReviewUndoActionBase & {
      kind: 'disk';
      action: {
        snapshot: {
          filePath: string;
          beforeContent: string;
          afterContent: string | null;
        };
        originalIndex?: number;
        decisionSnapshot?: ReviewDecisionSnapshot;
      };
    })
  | (ReviewUndoActionBase & {
      kind: 'hunk';
      action: { filePath: string; originalIndex: number };
    });

export interface ReviewRedoAction {
  action: ReviewUndoAction;
  decisionSnapshot: ReviewDecisionSnapshot;
  hunkContextHashesByFile?: Record<string, Record<number, string>>;
}

export interface ReviewPersistedStateSnapshot extends ReviewDecisionSnapshot {
  hunkContextHashesByFile?: Record<string, Record<number, string>>;
  reviewActionHistory: ReviewUndoAction[];
  reviewRedoHistory: ReviewRedoAction[];
}

export interface ReviewDecisionAuthorization {
  files: readonly ReviewDecisionFile[] | null;
  normalizePath(filePath: string): string;
  resolveFile(filePath: string): ReviewDecisionFile;
}

function normalizeDurableReviewValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => normalizeDurableReviewValue(entry));
  }
  if (!value || typeof value !== 'object') {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .map(([key, entry]) => [key, normalizeDurableReviewValue(entry)])
  );
}

function areNormalizedReviewValuesEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
      return false;
    }
    for (let index = 0; index < left.length; index++) {
      const leftHasEntry = Object.prototype.hasOwnProperty.call(left, index);
      const rightHasEntry = Object.prototype.hasOwnProperty.call(right, index);
      if (
        leftHasEntry !== rightHasEntry ||
        (leftHasEntry && !areNormalizedReviewValuesEqual(left[index], right[index]))
      ) {
        return false;
      }
    }
    return true;
  }
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') {
    return false;
  }
  const leftEntries = Object.entries(left);
  const rightRecord = right as Record<string, unknown>;
  if (leftEntries.length !== Object.keys(rightRecord).length) return false;
  return leftEntries.every(
    ([key, value]) =>
      Object.prototype.hasOwnProperty.call(rightRecord, key) &&
      areNormalizedReviewValuesEqual(value, rightRecord[key])
  );
}

/**
 * Compares JSON-durable review values while treating omitted and undefined
 * object properties identically. Array order remains significant.
 */
export function isDurableReviewEqual(left: unknown, right: unknown): boolean {
  return areNormalizedReviewValuesEqual(
    normalizeDurableReviewValue(left),
    normalizeDurableReviewValue(right)
  );
}

function restoreReviewDecisionRecordsForFile(
  file: ReviewDecisionFile,
  current: ReviewDecisionSnapshot,
  snapshot: ReviewDecisionSnapshot
): ReviewDecisionSnapshot {
  const aliases = [file.changeKey ?? file.filePath, file.filePath];
  const matchesHunkAlias = (key: string): boolean =>
    aliases.some((alias) => {
      const prefix = `${alias}:`;
      return key.startsWith(prefix) && /^\d+$/.test(key.slice(prefix.length));
    });
  const hunkDecisions = { ...current.hunkDecisions };
  for (const key of Object.keys(hunkDecisions)) {
    if (matchesHunkAlias(key)) delete hunkDecisions[key];
  }
  for (const [key, decision] of Object.entries(snapshot.hunkDecisions)) {
    if (matchesHunkAlias(key)) hunkDecisions[key] = decision;
  }

  const fileDecisions = { ...current.fileDecisions };
  for (const alias of aliases) delete fileDecisions[alias];
  for (const alias of aliases) {
    const decision = snapshot.fileDecisions[alias];
    if (decision) fileDecisions[alias] = decision;
  }
  return { hunkDecisions, fileDecisions };
}

function buildReviewUndoDecisionState(
  action: ReviewUndoAction,
  current: ReviewDecisionSnapshot,
  resolveFile: (filePath: string) => ReviewDecisionFile | null
): ReviewDecisionSnapshot | null {
  if (action.kind === 'bulk') {
    return {
      hunkDecisions: { ...action.decisionSnapshot.hunkDecisions },
      fileDecisions: { ...action.decisionSnapshot.fileDecisions },
    };
  }

  const filePath =
    action.kind === 'disk' ? action.action.snapshot.filePath : action.action.filePath;
  const file = resolveFile(filePath);
  if (!file) return null;

  const originalIndex = action.action.originalIndex;
  if (action.kind === 'hunk' || originalIndex !== undefined) {
    if (originalIndex === undefined) return null;
    const hunkDecisions = { ...current.hunkDecisions };
    delete hunkDecisions[`${file.changeKey ?? file.filePath}:${originalIndex}`];
    return { hunkDecisions, fileDecisions: { ...current.fileDecisions } };
  }

  const decisionSnapshot = action.action.decisionSnapshot;
  if (!decisionSnapshot) return null;
  return restoreReviewDecisionRecordsForFile(file, current, decisionSnapshot);
}

function getCanonicalFiles(
  authorization: ReviewDecisionAuthorization
): Map<string, ReviewDecisionFile> {
  if (!authorization.files) {
    throw new Error('Authoritative review file set is unavailable');
  }
  const canonicalFiles = new Map<string, ReviewDecisionFile>();
  for (const file of authorization.files) {
    canonicalFiles.set(file.changeKey ?? file.filePath, file);
  }
  return canonicalFiles;
}

function isAuthorizedReviewDecisionKey(
  canonicalFiles: ReadonlyMap<string, ReviewDecisionFile>,
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
  current: ReviewPersistedStateSnapshot | null
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
  current: ReviewPersistedStateSnapshot | null
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
  current: ReviewPersistedStateSnapshot | null
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
  current: ReviewPersistedStateSnapshot | null,
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
    Object.keys(state.hunkContextHashesByFile ?? {}).some((key) => !canonicalFiles.has(key)) ||
    (state.reviewRedoHistory ?? []).some((entry) =>
      Object.keys(entry.hunkContextHashesByFile ?? {}).some((key) => !canonicalFiles.has(key))
    )
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
  current: ReviewPersistedStateSnapshot | null,
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
