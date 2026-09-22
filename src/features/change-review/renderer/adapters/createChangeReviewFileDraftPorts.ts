import { normalizePathForComparison } from '@shared/utils/platformPath';

import type {
  ChangeReviewFileDraftCommandPort,
  ChangeReviewFileDraftStatePort,
  ChangeReviewFileDraftStateSnapshot,
  CommitChangeReviewExternalReloadInput,
} from '../ports/changeReviewFileDraftPorts';
import type { ExecuteReviewMutationRequest, ReviewPersistedStateSnapshot } from '@shared/types';
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
  updateEditedContent(filePath: string, content: string): void;
  discardFileEdits(filePath: string): void;
  clearReviewFileExternalChange(filePath: string): void;
  reloadReviewFileFromDisk(filePath: string): void;
  saveEditedFile: ChangeReviewFileDraftCommandPort['saveEditedFile'];
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

function findExternalChange(
  changes: Record<string, object>,
  filePath: string
): { filePath: string; value: object } | undefined {
  const normalizedPath = normalizePathForComparison(filePath);
  const entry = Object.entries(changes).find(
    ([candidate]) => normalizePathForComparison(candidate) === normalizedPath
  );
  return entry ? { filePath: entry[0], value: entry[1] } : undefined;
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
      };
    },
    readExternalChange: (filePath) =>
      findExternalChange(getStore().reviewExternalChangesByFile, filePath)?.value,
    updateEditedContent: (filePath, content) => getStore().updateEditedContent(filePath, content),
    discardFileEdits: (filePath) => getStore().discardFileEdits(filePath),
    clearExternalChange: (filePath, observedChange) => {
      const store = getStore();
      const current = findExternalChange(store.reviewExternalChangesByFile, filePath);
      if (current?.value !== observedChange) return false;
      store.clearReviewFileExternalChange(current.filePath);
      return true;
    },
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
