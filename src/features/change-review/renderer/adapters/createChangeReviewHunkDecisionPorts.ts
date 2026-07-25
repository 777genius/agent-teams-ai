import type {
  ChangeReviewHunkDecisionCommandPort,
  ChangeReviewHunkDecisionStatePort,
  ChangeReviewHunkDecisionStateSnapshot,
} from '../ports/changeReviewHunkDecisionPorts';
import type { ApplyReviewResult, HunkDecision } from '@shared/types';

interface ChangeReviewHunkDecisionStore extends ChangeReviewHunkDecisionStateSnapshot {
  setHunkDecision(filePath: string, hunkIndex: number, decision: HunkDecision): number;
  clearHunkDecisionByOriginalIndex(filePath: string, originalIndex: number): void;
  invalidateResolvedFileContent(filePath: string): void;
  applySingleFileDecision(
    teamName: string,
    filePath: string,
    taskId?: string,
    memberName?: string
  ): Promise<ApplyReviewResult | null>;
  fetchFileContent(
    teamName: string,
    memberName: string | undefined,
    filePath: string
  ): Promise<void>;
}

export function createChangeReviewHunkDecisionStatePort(
  getStore: () => ChangeReviewHunkDecisionStore
): ChangeReviewHunkDecisionStatePort {
  return {
    getSnapshot: () => {
      const state = getStore();
      return {
        hunkDecisions: state.hunkDecisions,
        fileDecisions: state.fileDecisions,
        fileChunkCounts: state.fileChunkCounts,
        changeSetEpoch: state.changeSetEpoch,
      };
    },
    setDecision: (filePath, hunkIndex, decision) =>
      getStore().setHunkDecision(filePath, hunkIndex, decision),
    clearDecision: (filePath, originalIndex) =>
      getStore().clearHunkDecisionByOriginalIndex(filePath, originalIndex),
    invalidateResolvedFileContent: (filePath) => getStore().invalidateResolvedFileContent(filePath),
  };
}

interface CreateChangeReviewHunkDecisionCommandPortInput {
  getStore: () => ChangeReviewHunkDecisionStore;
  readCurrentDiskContent: (filePath: string, fallback: string) => Promise<string>;
}

export function createChangeReviewHunkDecisionCommandPort({
  getStore,
  readCurrentDiskContent,
}: CreateChangeReviewHunkDecisionCommandPortInput): ChangeReviewHunkDecisionCommandPort {
  return {
    applySingleFileDecision: async (teamName, filePath, taskId, memberName) => {
      const result = await getStore().applySingleFileDecision(
        teamName,
        filePath,
        taskId,
        memberName
      );
      return result?.errors.length === 0
        ? { status: 'applied', result }
        : { status: 'failed', result };
    },
    fetchFileContent: (teamName, memberName, filePath) => {
      void getStore().fetchFileContent(teamName, memberName, filePath);
    },
    readCurrentDiskContent,
  };
}
