import type {
  ChangeReviewBulkDecisionCommandPort,
  ChangeReviewBulkDecisionStatePort,
  ChangeReviewBulkDecisionStateSnapshot,
} from '../ports/changeReviewBulkDecisionPorts';
import type { ReviewDecisionSnapshot } from '@shared/types';

interface ChangeReviewBulkDecisionStore extends ChangeReviewBulkDecisionStateSnapshot {
  acceptAllFile(filePath: string): boolean;
  rejectAllFile(filePath: string): void;
  invalidateResolvedFileContent(filePath: string): void;
  applyReview(
    teamName: string,
    taskId?: string,
    memberName?: string
  ): ReturnType<ChangeReviewBulkDecisionCommandPort['applyReview']>;
  fetchFileContent(
    teamName: string,
    memberName: string | undefined,
    filePath: string
  ): Promise<void>;
}

interface CreateChangeReviewBulkDecisionStatePortInput {
  getStore: () => ChangeReviewBulkDecisionStore;
  restoreDecisionSnapshot: (snapshot: ReviewDecisionSnapshot) => void;
}

export function createChangeReviewBulkDecisionStatePort({
  getStore,
  restoreDecisionSnapshot,
}: CreateChangeReviewBulkDecisionStatePortInput): ChangeReviewBulkDecisionStatePort {
  return {
    getSnapshot: () => getStore(),
    acceptAllFile: (filePath) => getStore().acceptAllFile(filePath),
    rejectAllFile: (filePath) => getStore().rejectAllFile(filePath),
    restoreDecisionSnapshot,
    invalidateResolvedFileContent: (filePath) => getStore().invalidateResolvedFileContent(filePath),
  };
}

interface CreateChangeReviewBulkDecisionCommandPortInput {
  getStore: () => ChangeReviewBulkDecisionStore;
  readCurrentDiskContent: (filePath: string, fallback: string) => Promise<string>;
}

export function createChangeReviewBulkDecisionCommandPort({
  getStore,
  readCurrentDiskContent,
}: CreateChangeReviewBulkDecisionCommandPortInput): ChangeReviewBulkDecisionCommandPort {
  return {
    applyReview: (teamName, taskId, memberName) =>
      getStore().applyReview(teamName, taskId, memberName),
    fetchFileContent: (teamName, memberName, filePath) => {
      void getStore().fetchFileContent(teamName, memberName, filePath);
    },
    readCurrentDiskContent,
  };
}
