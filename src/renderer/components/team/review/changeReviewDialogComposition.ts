import { resolveChangeReviewFileHunkCount } from '@features/change-review';
import {
  createChangeReviewActionHistoryStorePort,
  createChangeReviewBulkDecisionStatePort,
  createChangeReviewConflictCommandPort,
  createChangeReviewConflictQueryPort,
  createChangeReviewConflictStateBridge,
  createChangeReviewDecisionPersistencePort,
  createChangeReviewDialogLifecycleStatePort,
  createChangeReviewDraftHistoryPort,
  createChangeReviewExternalFileWatcherPort,
  createChangeReviewFileDecisionStatePort,
  createChangeReviewFileDraftCommandPort,
  createChangeReviewFileDraftStatePort,
  createChangeReviewHistoryMutationCommandPort,
  createChangeReviewHistoryMutationStatePort,
  createChangeReviewHunkDecisionStatePort,
} from '@features/change-review/renderer';
import { buildReviewRestoreDecisionState } from '@features/review-mutations';
import { api } from '@renderer/api';
import { useStore } from '@renderer/store';
import { getFileReviewKey } from '@renderer/utils/reviewKey';

import { buildInitialReviewFileScrollKey } from './initialReviewFileScroll';
import { getReviewActionFilePath } from './reviewActionPresentation';
import {
  getReviewRenameRecoveryExpectation,
  hasReviewFileRejections,
  hasUnresolvedReviewExternalChange,
  isReviewFileFullyRejected,
  resolveReviewFileIsNew,
  restoreReviewDecisionRecordsForFile,
  shouldCreateFileWhenUndoingReject,
  shouldDeleteFileWhenUndoingReject,
} from './reviewActionState';
import {
  getResolvedReviewModifiedContent,
  isReviewAcceptDisabled,
  isReviewFileExpectedDeleted,
  isReviewFileMissingOnDisk,
  isReviewRejectable,
  isReviewTextContentUnavailable,
} from './reviewContentPreview';
import { resolveReviewFilePath } from './reviewFilePathResolution';

import type {
  ChangeReviewDialogViewStatePolicy,
  ChangeReviewExternalChangePolicy,
  ChangeReviewExternalChangeStatePort,
  ChangeReviewFileDecisionPolicy,
  ChangeReviewHunkDecisionPolicy,
  ChangeReviewOperationStatePort,
} from '@features/change-review/renderer';

export const changeReviewConflictQueryPort = createChangeReviewConflictQueryPort(() => api.review);
export const changeReviewConflictCommandPort = createChangeReviewConflictCommandPort(
  () => api.review
);
export const changeReviewConflictStateBridge = createChangeReviewConflictStateBridge({
  getSnapshot: useStore.getState,
  setApplyError: (applyError) => useStore.setState({ applyError }),
});
export const changeReviewDraftHistoryPort = createChangeReviewDraftHistoryPort(() => api.review);
export const changeReviewExternalFileWatcherPort = createChangeReviewExternalFileWatcherPort(
  () => api.review
);
export const changeReviewOperationStatePort: ChangeReviewOperationStatePort = {
  getSnapshot: () => {
    const state = useStore.getState();
    return {
      applying: state.applying,
      decisionHydrationScopeKey: state.decisionHydrationScopeKey,
      decisionHydrationStatus: state.decisionHydrationStatus,
    };
  },
  reportError: (message) => useStore.setState({ applyError: message }),
};
export const changeReviewExternalChangeStatePort: ChangeReviewExternalChangeStatePort = {
  getSnapshot: () => {
    const state = useStore.getState();
    return {
      activeChangeSet: state.activeChangeSet,
      editedContents: state.editedContents,
      reviewExternalChangesByFile: state.reviewExternalChangesByFile,
    };
  },
  restoreDraft: (filePath, content) => useStore.getState().updateEditedContent(filePath, content),
  markExternalChange: (filePath, changeType) =>
    useStore.getState().markReviewFileExternallyChanged(filePath, changeType),
  reportError: (message) => useStore.setState({ applyError: message }),
};
export const changeReviewExternalChangePolicy: ChangeReviewExternalChangePolicy = {
  hasUnresolvedExternalChange: hasUnresolvedReviewExternalChange,
};
export const changeReviewActionHistoryStorePort = createChangeReviewActionHistoryStorePort({
  getStore: useStore.getState,
  clearLegacyUndoStack: () => useStore.setState({ reviewUndoStack: [] }),
});
export const changeReviewDecisionPersistencePort = createChangeReviewDecisionPersistencePort({
  getStore: useStore.getState,
  setApplyError: (applyError) => useStore.setState({ applyError }),
});
export const changeReviewBulkDecisionStatePort = createChangeReviewBulkDecisionStatePort({
  getStore: useStore.getState,
  restoreDecisionSnapshot: ({ hunkDecisions, fileDecisions }) =>
    useStore.setState({ hunkDecisions, fileDecisions }),
});
export const changeReviewFileDraftStatePort = createChangeReviewFileDraftStatePort({
  getStore: useStore.getState,
  applyReloadedReviewState: (state) =>
    useStore.setState({
      hunkDecisions: state.hunkDecisions,
      fileDecisions: state.fileDecisions,
      hunkContextHashesByFile: state.hunkContextHashesByFile ?? {},
      applyError: null,
    }),
  reportError: (applyError) => useStore.setState({ applyError }),
});
export const changeReviewFileDraftCommandPort = createChangeReviewFileDraftCommandPort({
  getStore: useStore.getState,
  getReviewApi: () => api.review,
});
export const changeReviewFileDecisionStatePort = createChangeReviewFileDecisionStatePort({
  getStore: useStore.getState,
  applyRestoredDecisionState: (file) =>
    useStore.setState((state) => buildReviewRestoreDecisionState(file, state)),
  restoreFileDecisions: (file, snapshot) =>
    useStore.setState((state) => restoreReviewDecisionRecordsForFile(file, state, snapshot)),
  reportError: (applyError) => useStore.setState({ applyError }),
});
export const changeReviewFileDecisionPolicy: ChangeReviewFileDecisionPolicy = {
  getHunkCount: (file, state) =>
    resolveChangeReviewFileHunkCount(file.filePath, file.snippets.length, state.fileChunkCounts),
  getFileDecision: (file, state) =>
    state.fileDecisions[getFileReviewKey(file)] ?? state.fileDecisions[file.filePath],
  resolveModifiedContent: getResolvedReviewModifiedContent,
  resolveFileIsNew: resolveReviewFileIsNew,
  isExpectedDeletion: isReviewFileExpectedDeleted,
  isAcceptDisabled: (_file, content, fileDecision) =>
    isReviewAcceptDisabled({
      hasEdits: false,
      isMissingOnDisk: isReviewFileMissingOnDisk(content),
      isContentUnavailable: isReviewTextContentUnavailable(_file, content),
      fileDecision,
    }),
  isRejectable: isReviewRejectable,
  hasFileRejections: hasReviewFileRejections,
  isFileFullyRejected: isReviewFileFullyRejected,
  shouldDeleteWhenUndoingReject: shouldDeleteFileWhenUndoingReject,
  hasUnresolvedExternalChange: hasUnresolvedReviewExternalChange,
  getRenameRecoveryExpectation: getReviewRenameRecoveryExpectation,
};
export const changeReviewHunkDecisionStatePort = createChangeReviewHunkDecisionStatePort(
  useStore.getState
);
export const changeReviewHunkDecisionPolicy: ChangeReviewHunkDecisionPolicy = {
  getHunkCount: (file, state) =>
    resolveChangeReviewFileHunkCount(file.filePath, file.snippets.length, state.fileChunkCounts),
  resolveFileIsNew: resolveReviewFileIsNew,
  shouldDeleteWhenUndoingReject: shouldDeleteFileWhenUndoingReject,
  shouldCreateWhenUndoingReject: shouldCreateFileWhenUndoingReject,
  getRenameRecoveryExpectation: getReviewRenameRecoveryExpectation,
};
export const changeReviewDialogViewStatePolicy: ChangeReviewDialogViewStatePolicy = {
  buildInitialScrollKey: buildInitialReviewFileScrollKey,
  getHistoryActionFilePath: getReviewActionFilePath,
  resolveFilePath: resolveReviewFilePath,
};
export const changeReviewDialogLifecycleStatePort = createChangeReviewDialogLifecycleStatePort({
  getStore: useStore.getState,
  reportError: (applyError) => useStore.setState({ applyError }),
  completeSavedStateDiscard: (markDecisionHydrationLoaded) =>
    useStore.setState({
      ...(markDecisionHydrationLoaded ? { decisionHydrationStatus: 'loaded' as const } : {}),
      applyError: null,
    }),
});
export const changeReviewHistoryMutationCommandPort = createChangeReviewHistoryMutationCommandPort(
  () => api.review
);
export const changeReviewHistoryMutationStatePort = createChangeReviewHistoryMutationStatePort({
  getSnapshot: () => useStore.getState(),
  quiesceDecisionPersistence: ({ teamName, scopeKey, scopeToken }) =>
    useStore.getState().quiesceDecisionPersistence(teamName, scopeKey, scopeToken),
  recordDecisionRevision: ({ teamName, scopeKey, scopeToken }, revision) =>
    useStore.getState().recordDecisionRevision(teamName, scopeKey, scopeToken, revision),
  applyDecisionState: ({ hunkDecisions, fileDecisions, hunkContextHashesByFile }) =>
    useStore.setState({
      hunkDecisions,
      fileDecisions,
      ...(hunkContextHashesByFile ? { hunkContextHashesByFile } : {}),
    }),
  applyPersistedState: (state, applyError) =>
    useStore.setState({
      hunkDecisions: state.hunkDecisions,
      fileDecisions: state.fileDecisions,
      hunkContextHashesByFile: state.hunkContextHashesByFile ?? {},
      applyError,
    }),
  reportError: (applyError) => useStore.setState({ applyError }),
  clearExternalChange: (filePath) => useStore.getState().clearReviewFileExternalChange(filePath),
  invalidateResolvedFileContent: (filePath) =>
    useStore.getState().invalidateResolvedFileContent(filePath),
});
