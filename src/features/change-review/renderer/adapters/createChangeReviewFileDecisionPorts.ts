import type {
  ChangeReviewFileDecisionCommandPort,
  ChangeReviewFileDecisionStatePort,
  ChangeReviewFileDecisionStateSnapshot,
} from '../ports/changeReviewFileDecisionPorts';
import type { FileChangeSummary, ReviewDecisionSnapshot, ReviewFileScope } from '@shared/types';
import type { ReviewAPI } from '@shared/types/api';

interface ChangeReviewFileDecisionStore extends ChangeReviewFileDecisionStateSnapshot {
  acceptAllFile(filePath: string): boolean;
  rejectAllFile(filePath: string): void;
  clearReviewFileExternalChange(filePath: string): void;
  invalidateResolvedFileContent(filePath: string): void;
  applySingleFileDecision(
    teamName: string,
    filePath: string,
    taskId?: string,
    memberName?: string
  ): ReturnType<ChangeReviewFileDecisionCommandPort['applySingleFileDecision']>;
  quiesceDecisionPersistence(
    teamName: string,
    scopeKey: string,
    scopeToken: string
  ): Promise<boolean>;
  recordDecisionRevision(
    teamName: string,
    scopeKey: string,
    scopeToken: string,
    revision: number
  ): void;
  fetchFileContent(
    teamName: string,
    memberName: string | undefined,
    filePath: string
  ): Promise<void>;
}

interface CreateChangeReviewFileDecisionStatePortInput {
  getStore: () => ChangeReviewFileDecisionStore;
  applyRestoredDecisionState: (file: FileChangeSummary) => void;
  restoreFileDecisions: (file: FileChangeSummary, snapshot: ReviewDecisionSnapshot) => void;
  reportError: (message: string | null) => void;
}

export function createChangeReviewFileDecisionStatePort({
  getStore,
  applyRestoredDecisionState,
  restoreFileDecisions,
  reportError,
}: CreateChangeReviewFileDecisionStatePortInput): ChangeReviewFileDecisionStatePort {
  return {
    getSnapshot: () => {
      const state = getStore();
      return {
        fileContents: state.fileContents,
        reviewExternalChangesByFile: state.reviewExternalChangesByFile,
        hunkDecisions: state.hunkDecisions,
        fileDecisions: state.fileDecisions,
        hunkContextHashesByFile: state.hunkContextHashesByFile,
        fileChunkCounts: state.fileChunkCounts,
        decisionRevision: state.decisionRevision,
        changeSetEpoch: state.changeSetEpoch,
      };
    },
    acceptAllFile: (filePath) => getStore().acceptAllFile(filePath),
    rejectAllFile: (filePath) => getStore().rejectAllFile(filePath),
    applyRestoredDecisionState,
    restoreFileDecisions,
    clearExternalChange: (filePath) => getStore().clearReviewFileExternalChange(filePath),
    invalidateResolvedFileContent: (filePath) => getStore().invalidateResolvedFileContent(filePath),
    reportError,
  };
}

type ChangeReviewFileDecisionReviewApi = Pick<ReviewAPI, 'checkConflict' | 'executeMutation'>;

interface CreateChangeReviewFileDecisionCommandPortInput {
  getStore: () => ChangeReviewFileDecisionStore;
  getReviewApi: () => ChangeReviewFileDecisionReviewApi;
  readCurrentDiskContent: (filePath: string, fallback: string) => Promise<string>;
}

export function createChangeReviewFileDecisionCommandPort({
  getStore,
  getReviewApi,
  readCurrentDiskContent,
}: CreateChangeReviewFileDecisionCommandPortInput): ChangeReviewFileDecisionCommandPort {
  return {
    checkConflict: (scope: ReviewFileScope, filePath, expectedContent) =>
      getReviewApi().checkConflict(scope, filePath, expectedContent),
    executeMutation: (request) => getReviewApi().executeMutation(request),
    applySingleFileDecision: (teamName, filePath, taskId, memberName) =>
      getStore().applySingleFileDecision(teamName, filePath, taskId, memberName),
    quiescePersistence: ({ teamName, scopeKey, scopeToken }) =>
      getStore().quiesceDecisionPersistence(teamName, scopeKey, scopeToken),
    recordDecisionRevision: ({ teamName, scopeKey, scopeToken }, revision) =>
      getStore().recordDecisionRevision(teamName, scopeKey, scopeToken, revision),
    fetchFileContent: (teamName, memberName, filePath) => {
      void getStore().fetchFileContent(teamName, memberName, filePath);
    },
    readCurrentDiskContent,
  };
}
