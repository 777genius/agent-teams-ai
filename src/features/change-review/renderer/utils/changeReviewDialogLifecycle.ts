import type { ReviewActionPersistenceStatus } from './changeReviewActionHistory';

export interface ChangeReviewActionLockState {
  applying: boolean;
  fileApplyCount: number;
  undoing: boolean;
  closing: boolean;
}

export interface ChangeReviewDraftWriteDiagnostics {
  pendingWriteCount: number;
  writeChainCount: number;
  writeErrorCount: number;
}

export interface ChangeReviewDecisionWriteDiagnostics {
  pendingDecisionClear: boolean;
  persistenceStatus: ReviewActionPersistenceStatus;
}

export interface ChangeReviewCloseReadinessInput {
  hydrationKey: string | null;
  decisionHydrationScopeKey: string | null;
  decisionHydrationStatus: 'idle' | 'loading' | 'loaded' | 'error';
  draftHydrationKey: string | null;
  draftHydrationStatus: 'idle' | 'loading' | 'loaded' | 'error';
  editedContentCount: number;
  hunkDecisionCount: number;
  fileDecisionCount: number;
  undoHistoryCount: number;
  redoHistoryCount: number;
  draftDiagnostics: ChangeReviewDraftWriteDiagnostics;
  scopedDraftDiagnostics: ChangeReviewDraftWriteDiagnostics;
  decisionDiagnostics: ChangeReviewDecisionWriteDiagnostics;
  pendingApplyCleanupKey: string | null;
  actionLockState: ChangeReviewActionLockState;
}

export type ChangeReviewCloseReadiness =
  | { disposition: 'flush' }
  | { disposition: 'close-without-flush' }
  | { disposition: 'block'; blocker: string };

export function shouldRequestReviewCloseForEscape(input: {
  key: string;
  defaultPrevented: boolean;
  hasOpenModalLayer: boolean;
}): boolean {
  return input.key === 'Escape' && !input.defaultPrevented && !input.hasOpenModalLayer;
}

export function isReviewActionLocked(state: ChangeReviewActionLockState): boolean {
  return state.applying || state.fileApplyCount > 0 || state.undoing || state.closing;
}

export function getReviewCloseBlockReason(input: {
  busy: boolean;
  draftCount: number;
}): string | null {
  if (input.busy) return 'Wait for the current review action to finish.';
  if (input.draftCount > 0) return 'Save or discard manual edits before closing Changes.';
  return null;
}

interface LocalReviewStateInput {
  editedContentCount: number;
  hunkDecisionCount: number;
  fileDecisionCount: number;
  undoHistoryCount: number;
  redoHistoryCount: number;
  draftDiagnostics: ChangeReviewDraftWriteDiagnostics;
  pendingApplyCleanup: boolean;
  decisionDiagnostics: ChangeReviewDecisionWriteDiagnostics;
}

function hasLocalReviewState(input: LocalReviewStateInput): boolean {
  return (
    input.editedContentCount > 0 ||
    input.hunkDecisionCount > 0 ||
    input.fileDecisionCount > 0 ||
    input.undoHistoryCount > 0 ||
    input.redoHistoryCount > 0 ||
    input.draftDiagnostics.pendingWriteCount > 0 ||
    input.draftDiagnostics.writeChainCount > 0 ||
    input.draftDiagnostics.writeErrorCount > 0 ||
    input.pendingApplyCleanup ||
    input.decisionDiagnostics.pendingDecisionClear ||
    input.decisionDiagnostics.persistenceStatus !== 'saved'
  );
}

export function hasUnscopedLocalReviewState(input: {
  editedContentCount: number;
  hunkDecisionCount: number;
  fileDecisionCount: number;
  undoHistoryCount: number;
  redoHistoryCount: number;
  pendingDraftWriteCount: number;
  draftWriteChainCount: number;
  draftWriteErrorCount: number;
  pendingApplyCleanup: boolean;
  pendingDecisionClear: boolean;
  persistenceStatus: ReviewActionPersistenceStatus;
}): boolean {
  return hasLocalReviewState({
    editedContentCount: input.editedContentCount,
    hunkDecisionCount: input.hunkDecisionCount,
    fileDecisionCount: input.fileDecisionCount,
    undoHistoryCount: input.undoHistoryCount,
    redoHistoryCount: input.redoHistoryCount,
    draftDiagnostics: {
      pendingWriteCount: input.pendingDraftWriteCount,
      writeChainCount: input.draftWriteChainCount,
      writeErrorCount: input.draftWriteErrorCount,
    },
    pendingApplyCleanup: input.pendingApplyCleanup,
    decisionDiagnostics: {
      pendingDecisionClear: input.pendingDecisionClear,
      persistenceStatus: input.persistenceStatus,
    },
  });
}

function hasLocalReviewBranch(input: ChangeReviewCloseReadinessInput): boolean {
  return hasLocalReviewState({
    editedContentCount: input.editedContentCount,
    hunkDecisionCount: input.hunkDecisionCount,
    fileDecisionCount: input.fileDecisionCount,
    undoHistoryCount: input.undoHistoryCount,
    redoHistoryCount: input.redoHistoryCount,
    draftDiagnostics: input.scopedDraftDiagnostics,
    pendingApplyCleanup: input.pendingApplyCleanupKey === input.hydrationKey,
    decisionDiagnostics: input.decisionDiagnostics,
  });
}

export function evaluateChangeReviewCloseReadiness(
  input: ChangeReviewCloseReadinessInput
): ChangeReviewCloseReadiness {
  const localStateRequiresScope = hasUnscopedLocalReviewState({
    editedContentCount: input.editedContentCount,
    hunkDecisionCount: input.hunkDecisionCount,
    fileDecisionCount: input.fileDecisionCount,
    undoHistoryCount: input.undoHistoryCount,
    redoHistoryCount: input.redoHistoryCount,
    pendingDraftWriteCount: input.draftDiagnostics.pendingWriteCount,
    draftWriteChainCount: input.draftDiagnostics.writeChainCount,
    draftWriteErrorCount: input.draftDiagnostics.writeErrorCount,
    pendingApplyCleanup: input.pendingApplyCleanupKey !== null,
    pendingDecisionClear: input.decisionDiagnostics.pendingDecisionClear,
    persistenceStatus: input.decisionDiagnostics.persistenceStatus,
  });
  if (!input.hydrationKey && localStateRequiresScope) {
    return {
      disposition: 'block',
      blocker:
        'Manual edit history lost its saved review scope. Keep Changes open and retry recovery.',
    };
  }

  if (input.hydrationKey) {
    const matchesCurrentHydration = input.decisionHydrationScopeKey === input.hydrationKey;
    const matchesDraftHydration = input.draftHydrationKey === input.hydrationKey;
    if (
      (matchesCurrentHydration && input.decisionHydrationStatus === 'error') ||
      (matchesDraftHydration && input.draftHydrationStatus === 'error')
    ) {
      if (hasLocalReviewBranch(input)) {
        return {
          disposition: 'block',
          blocker:
            'Saved review state could not be reconciled with local changes. Retry recovery before closing Changes.',
        };
      }
      return { disposition: 'close-without-flush' };
    }
    if (
      !matchesCurrentHydration ||
      input.decisionHydrationStatus !== 'loaded' ||
      !matchesDraftHydration ||
      input.draftHydrationStatus !== 'loaded'
    ) {
      return {
        disposition: 'block',
        blocker: 'Wait for saved review state to finish loading before closing Changes.',
      };
    }
  }

  const blockReason = getReviewCloseBlockReason({
    busy: isReviewActionLocked(input.actionLockState),
    draftCount: 0,
  });
  return blockReason ? { disposition: 'block', blocker: blockReason } : { disposition: 'flush' };
}
