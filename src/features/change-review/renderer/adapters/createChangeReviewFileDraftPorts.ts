import type {
  ChangeReviewFileDraftCommandPort,
  ChangeReviewFileDraftStatePort,
  ChangeReviewFileDraftStateSnapshot,
  CommitChangeReviewExternalReloadInput,
} from '../ports/changeReviewFileDraftPorts';
import type {
  ExecuteReviewMutationRequest,
  ReviewFileScope,
  ReviewPersistedStateSnapshot,
} from '@shared/types';
import type { ReviewAPI } from '@shared/types/api';

interface ChangeReviewFileDraftStore {
  activeChangeSet: {
    files: readonly ChangeReviewFileDraftStateSnapshot['activeFiles'][number][];
  } | null;
  editedContents: ChangeReviewFileDraftStateSnapshot['editedContents'];
  reviewExternalChangesByFile: ChangeReviewFileDraftStateSnapshot['reviewExternalChangesByFile'];
  hunkDecisions: ChangeReviewFileDraftStateSnapshot['hunkDecisions'];
  fileDecisions: ChangeReviewFileDraftStateSnapshot['fileDecisions'];
  hunkContextHashesByFile: ChangeReviewFileDraftStateSnapshot['hunkContextHashesByFile'];
  decisionRevision: number;
  changeSetEpoch: number;
  applyError: string | null;
  updateEditedContent(filePath: string, content: string): void;
  discardFileEdits(filePath: string): void;
  clearReviewFileExternalChange(filePath: string): void;
  reloadReviewFileFromDisk(filePath: string): void;
  saveEditedFile(
    filePath: string,
    scope: ReviewFileScope,
    expectedCurrentContent: string | null
  ): Promise<void>;
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

interface CreateChangeReviewFileDraftStatePortInput {
  getStore: () => ChangeReviewFileDraftStore;
  applyReloadedReviewState: (state: ReviewPersistedStateSnapshot) => void;
  reportError: (message: string | null) => void;
}

export function createChangeReviewFileDraftStatePort({
  getStore,
  applyReloadedReviewState,
  reportError,
}: CreateChangeReviewFileDraftStatePortInput): ChangeReviewFileDraftStatePort {
  return {
    getSnapshot: () => {
      const state = getStore();
      return {
        activeFiles: state.activeChangeSet?.files ?? [],
        editedContents: state.editedContents,
        reviewExternalChangesByFile: state.reviewExternalChangesByFile,
        hunkDecisions: state.hunkDecisions,
        fileDecisions: state.fileDecisions,
        hunkContextHashesByFile: state.hunkContextHashesByFile,
        decisionRevision: state.decisionRevision,
        changeSetEpoch: state.changeSetEpoch,
        applyError: state.applyError,
      };
    },
    updateEditedContent: (filePath, content) => getStore().updateEditedContent(filePath, content),
    discardFileEdits: (filePath) => getStore().discardFileEdits(filePath),
    clearExternalChange: (filePath) => getStore().clearReviewFileExternalChange(filePath),
    reloadFileFromDisk: (filePath) => getStore().reloadReviewFileFromDisk(filePath),
    applyReloadedReviewState,
    reportError,
  };
}

type ChangeReviewFileDraftReviewApi = Pick<ReviewAPI, 'checkConflict' | 'executeMutation'>;

interface CreateChangeReviewFileDraftCommandPortInput {
  getStore: () => ChangeReviewFileDraftStore;
  getReviewApi: () => ChangeReviewFileDraftReviewApi;
}

function toExternalReloadRequest({
  reviewScope,
  persistenceScope,
  filePath,
  persistedState,
  expectedDecisionRevision,
}: CommitChangeReviewExternalReloadInput): ExecuteReviewMutationRequest {
  return {
    scope: reviewScope,
    decisionPersistenceScope: {
      scopeKey: persistenceScope.scopeKey,
      scopeToken: persistenceScope.scopeToken,
    },
    kind: 'reload-external' as const,
    externalFilePath: filePath,
    diskSteps: [],
    persistedState,
    expectedDecisionRevision,
  };
}

export function createChangeReviewFileDraftCommandPort({
  getStore,
  getReviewApi,
}: CreateChangeReviewFileDraftCommandPortInput): ChangeReviewFileDraftCommandPort {
  return {
    saveEditedFile: (filePath, reviewScope, expectedCurrentContent) =>
      getStore().saveEditedFile(filePath, reviewScope, expectedCurrentContent),
    checkConflict: (reviewScope, filePath, expectedContent) =>
      getReviewApi().checkConflict(reviewScope, filePath, expectedContent),
    commitExternalReload: (input) => getReviewApi().executeMutation(toExternalReloadRequest(input)),
    quiescePersistence: ({ teamName, scopeKey, scopeToken }) =>
      getStore().quiesceDecisionPersistence(teamName, scopeKey, scopeToken),
    recordDecisionRevision: ({ teamName, scopeKey, scopeToken }, revision) =>
      getStore().recordDecisionRevision(teamName, scopeKey, scopeToken, revision),
    fetchFileContent: (teamName, memberName, filePath) => {
      void getStore().fetchFileContent(teamName, memberName, filePath);
    },
  };
}
