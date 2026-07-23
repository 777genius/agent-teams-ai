export {
  createChangeReviewActionHistoryStorePort,
  createChangeReviewDecisionPersistencePort,
} from './adapters/createChangeReviewActionHistoryPorts';
export {
  createChangeReviewBulkDecisionCommandPort,
  createChangeReviewBulkDecisionStatePort,
} from './adapters/createChangeReviewBulkDecisionPorts';
export {
  createChangeReviewConflictCommandPort,
  createChangeReviewConflictQueryPort,
} from './adapters/createChangeReviewConflictPorts';
export type { ChangeReviewConflictStateBridge } from './adapters/createChangeReviewConflictStateBridge';
export { createChangeReviewConflictStateBridge } from './adapters/createChangeReviewConflictStateBridge';
export { createChangeReviewDraftHistoryPort } from './adapters/createChangeReviewDraftHistoryPort';
export {
  createChangeReviewFileDraftCommandPort,
  createChangeReviewFileDraftStatePort,
} from './adapters/createChangeReviewFileDraftPorts';
export {
  createChangeReviewHistoryMutationCommandPort,
  createChangeReviewHistoryMutationStatePort,
} from './adapters/createChangeReviewHistoryMutationPorts';
export type { ChangeReviewActionHistoryController } from './hooks/useChangeReviewActionHistoryController';
export { useChangeReviewActionHistoryController } from './hooks/useChangeReviewActionHistoryController';
export type { ChangeReviewBulkDecisionController } from './hooks/useChangeReviewBulkDecisionController';
export { useChangeReviewBulkDecisionController } from './hooks/useChangeReviewBulkDecisionController';
export type { ChangeReviewConflictDiscoveryController } from './hooks/useChangeReviewConflictDiscoveryController';
export { useChangeReviewConflictDiscoveryController } from './hooks/useChangeReviewConflictDiscoveryController';
export type { ChangeReviewConflictInteractionController } from './hooks/useChangeReviewConflictInteractionController';
export { useChangeReviewConflictInteractionController } from './hooks/useChangeReviewConflictInteractionController';
export { useChangeReviewDecisionAutoPersistence } from './hooks/useChangeReviewDecisionAutoPersistence';
export type {
  ChangeReviewAutoClearResult,
  ChangeReviewDecisionPersistenceController,
  ChangeReviewDecisionPersistenceDiagnostics,
} from './hooks/useChangeReviewDecisionPersistenceController';
export {
  CHANGE_REVIEW_PERSISTENCE_ERROR,
  useChangeReviewDecisionPersistenceController,
} from './hooks/useChangeReviewDecisionPersistenceController';
export type {
  ChangeReviewDraftHistoryController,
  ChangeReviewDraftHistoryDiagnostics,
} from './hooks/useChangeReviewDraftHistoryController';
export { useChangeReviewDraftHistoryController } from './hooks/useChangeReviewDraftHistoryController';
export type { ChangeReviewFileDraftController } from './hooks/useChangeReviewFileDraftController';
export { useChangeReviewFileDraftController } from './hooks/useChangeReviewFileDraftController';
export type { ChangeReviewKeyboardEditorContext } from './hooks/useChangeReviewHistoryKeyboardShortcuts';
export { useChangeReviewHistoryKeyboardShortcuts } from './hooks/useChangeReviewHistoryKeyboardShortcuts';
export type {
  ChangeReviewHistoryMutationController,
  ChangeReviewHistoryRestorePreview,
} from './hooks/useChangeReviewHistoryMutationController';
export { useChangeReviewHistoryMutationController } from './hooks/useChangeReviewHistoryMutationController';
export { useChangeReviewLifecycleRegistration } from './hooks/useChangeReviewLifecycleRegistration';
export { useChangeReviewOperationGeneration } from './hooks/useChangeReviewOperationGeneration';
export { useChangeReviewScopeIdentity } from './hooks/useChangeReviewScopeIdentity';
export type {
  ChangeReviewActionHistoryStorePort,
  ChangeReviewDecisionPersistencePort,
  ChangeReviewDecisionPersistenceScope,
  ChangeReviewDecisionPersistenceSnapshot,
} from './ports/changeReviewActionHistoryPorts';
export type {
  BuildBulkRejectDiskSnapshot,
  ChangeReviewBulkDecisionCommandPort,
  ChangeReviewBulkDecisionEditorPort,
  ChangeReviewBulkDecisionStatePort,
  ChangeReviewBulkDecisionStateSnapshot,
  ChangeReviewBulkDecisionStatusPort,
  ChangeReviewBulkDecisionWriteEvidencePort,
} from './ports/changeReviewBulkDecisionPorts';
export type {
  ChangeReviewConflictCommandPort,
  ChangeReviewConflictQueryPort,
  ChangeReviewConflictScope,
} from './ports/changeReviewConflictPorts';
export type {
  ChangeReviewDraftHistoryEntryInput,
  ChangeReviewDraftHistoryPort,
  ChangeReviewDraftHistoryScope,
  ChangeReviewDraftHistoryVersion,
} from './ports/changeReviewDraftHistoryPort';
export type {
  ChangeReviewFileDraftCommandPort,
  ChangeReviewFileDraftPersistenceScope,
  ChangeReviewFileDraftStatePort,
  ChangeReviewFileDraftStateSnapshot,
  ChangeReviewFileDraftStatusPort,
  ChangeReviewFileDraftWriteEvidencePort,
  CommitChangeReviewExternalReloadInput,
} from './ports/changeReviewFileDraftPorts';
export type {
  ChangeReviewHistoryMutationCommandPort,
  ChangeReviewHistoryMutationScope,
  ChangeReviewHistoryMutationStatePort,
  ChangeReviewHistoryMutationViewPort,
  ChangeReviewHistoryPersistenceScope,
  ChangeReviewHistoryStateSnapshot,
} from './ports/changeReviewHistoryMutationPorts';
export type {
  RegisterChangeReviewAppCloseParticipant,
  RegisterChangeReviewLifecycleOwner,
} from './ports/changeReviewLifecyclePorts';
export {
  ChangeReviewConflictDiscardDialog,
  ChangeReviewConflictNotices,
} from './ui/ChangeReviewConflictNotices';
export type { TaskChangesEmptyStateProps } from './ui/TaskChangesEmptyState';
export { TaskChangesEmptyState } from './ui/TaskChangesEmptyState';
export type {
  ReviewActionPersistenceStatus,
  ReviewUndoActionInput,
} from './utils/changeReviewActionHistory';
export {
  appendOrderedReviewAction,
  createReviewUndoAction,
  filterReviewActionHistoryForFile,
  isReviewActionPersistenceBlocking,
  popOrderedReviewAction,
  replaceLatestReviewAction,
} from './utils/changeReviewActionHistory';
export type { ReviewConflictCandidateSelection } from './utils/changeReviewConflicts';
export {
  CHANGE_REVIEW_CONFLICT_LOAD_ERROR_PREFIX,
  describeReviewConflictCandidate,
  describeReviewConflictDiscard,
  selectLatestReviewConflictCandidate,
} from './utils/changeReviewConflicts';
export type { ReviewHistoryRecoveryDisposition } from './utils/changeReviewHistoryMutation';
export {
  areReviewPersistedStatesEqual,
  classifyReviewHistoryRecovery,
  createReviewRedoAction,
  getReviewActionAffectedPaths,
  getReviewDiskMutationExpectedContent,
  resolveReviewFile,
} from './utils/changeReviewHistoryMutation';
export type {
  BuildChangeReviewScopeProjectionInput,
  ChangeReviewScopeProjection,
  ReviewDecisionHydrationGuard,
  ReviewDecisionHydrationStatus,
  ReviewDraftHistoryHydrationState,
} from './utils/changeReviewScope';
export {
  buildChangeReviewScopeProjection,
  getReviewDecisionHydrationGuard,
} from './utils/changeReviewScope';
export type { ReviewOperationScopeToken } from './utils/reviewOperationGeneration';
export {
  createReviewOperationScopeToken,
  isReviewOperationScopeCurrent,
} from './utils/reviewOperationGeneration';
export type {
  ChangeReviewChangeSet,
  GlobalDiffLoadingState,
  ReviewChangeStats,
  ReviewStats,
  TaskChangesEmptyStatePresentation,
} from './view-models/changeReviewPresentation';
export {
  buildChangeReviewTitle,
  buildGlobalDiffLoadingState,
  buildReviewChangeStats,
  buildReviewFileLabels,
  buildReviewStats,
  buildTaskChangesEmptyStatePresentation,
  buildWatchedReviewFilePathsKey,
  findActiveReviewFile,
  isTaskChangeSetV2,
  resolveReviewFileLabel,
  shouldShowTaskScopeBanner,
  sortChangeReviewFiles,
  toTaskChangeSetV2,
} from './view-models/changeReviewPresentation';
