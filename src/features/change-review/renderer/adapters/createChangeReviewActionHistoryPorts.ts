import type {
  ChangeReviewActionHistoryStorePort,
  ChangeReviewDecisionPersistencePort,
  ChangeReviewDecisionPersistenceSnapshot,
} from '../ports/changeReviewActionHistoryPorts';
import type { ReviewRedoAction, ReviewUndoAction } from '@shared/types';

interface ChangeReviewActionHistoryStore {
  setReviewActionHistory(history: ReviewUndoAction[]): void;
  setReviewRedoHistory(history: ReviewRedoAction[]): void;
}

interface CreateChangeReviewActionHistoryStorePortInput {
  getStore: () => ChangeReviewActionHistoryStore;
  clearLegacyUndoStack: () => void;
}

export function createChangeReviewActionHistoryStorePort({
  getStore,
  clearLegacyUndoStack,
}: CreateChangeReviewActionHistoryStorePortInput): ChangeReviewActionHistoryStorePort {
  return {
    publishUndoHistory: (history) => getStore().setReviewActionHistory(history),
    publishRedoHistory: (history) => getStore().setReviewRedoHistory(history),
    clearLegacyUndoStack,
  };
}

interface ChangeReviewDecisionPersistenceStore extends ChangeReviewDecisionPersistenceSnapshot {
  loadDecisionsFromDisk(teamName: string, scopeKey: string, scopeToken: string): Promise<void>;
  persistDecisions(teamName: string, scopeKey: string, scopeToken: string): void;
  flushDecisionsToDisk(teamName: string, scopeKey: string, scopeToken: string): Promise<boolean>;
  clearDecisionsFromDisk(teamName: string, scopeKey: string, scopeToken?: string): Promise<boolean>;
}

interface CreateChangeReviewDecisionPersistencePortInput {
  getStore: () => ChangeReviewDecisionPersistenceStore;
  setApplyError: (message: string | null) => void;
}

export function createChangeReviewDecisionPersistencePort({
  getStore,
  setApplyError,
}: CreateChangeReviewDecisionPersistencePortInput): ChangeReviewDecisionPersistencePort {
  return {
    getSnapshot: () => getStore(),
    load: ({ teamName, scopeKey, scopeToken }) =>
      getStore().loadDecisionsFromDisk(teamName, scopeKey, scopeToken),
    schedule: ({ teamName, scopeKey, scopeToken }) =>
      getStore().persistDecisions(teamName, scopeKey, scopeToken),
    flush: ({ teamName, scopeKey, scopeToken }) =>
      getStore().flushDecisionsToDisk(teamName, scopeKey, scopeToken),
    clear: ({ teamName, scopeKey, scopeToken }) =>
      getStore().clearDecisionsFromDisk(teamName, scopeKey, scopeToken),
    reportError: setApplyError,
    clearError: (expectedMessage) => {
      if (getStore().applyError === expectedMessage) setApplyError(null);
    },
  };
}
