export {
  createChangeReviewConflictCommandPort,
  createChangeReviewConflictQueryPort,
} from './adapters/createChangeReviewConflictPorts';
export type { ChangeReviewConflictStateBridge } from './adapters/createChangeReviewConflictStateBridge';
export { createChangeReviewConflictStateBridge } from './adapters/createChangeReviewConflictStateBridge';
export { createChangeReviewDraftHistoryPort } from './adapters/createChangeReviewDraftHistoryPort';
export type { ChangeReviewConflictDiscoveryController } from './hooks/useChangeReviewConflictDiscoveryController';
export { useChangeReviewConflictDiscoveryController } from './hooks/useChangeReviewConflictDiscoveryController';
export type { ChangeReviewConflictInteractionController } from './hooks/useChangeReviewConflictInteractionController';
export { useChangeReviewConflictInteractionController } from './hooks/useChangeReviewConflictInteractionController';
export type {
  ChangeReviewDraftHistoryController,
  ChangeReviewDraftHistoryDiagnostics,
} from './hooks/useChangeReviewDraftHistoryController';
export { useChangeReviewDraftHistoryController } from './hooks/useChangeReviewDraftHistoryController';
export { useChangeReviewLifecycleRegistration } from './hooks/useChangeReviewLifecycleRegistration';
export { useChangeReviewOperationGeneration } from './hooks/useChangeReviewOperationGeneration';
export { useChangeReviewScopeIdentity } from './hooks/useChangeReviewScopeIdentity';
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
  RegisterChangeReviewAppCloseParticipant,
  RegisterChangeReviewLifecycleOwner,
} from './ports/changeReviewLifecyclePorts';
export {
  ChangeReviewConflictDiscardDialog,
  ChangeReviewConflictNotices,
} from './ui/ChangeReviewConflictNotices';
export type { TaskChangesEmptyStateProps } from './ui/TaskChangesEmptyState';
export { TaskChangesEmptyState } from './ui/TaskChangesEmptyState';
export type { ReviewConflictCandidateSelection } from './utils/changeReviewConflicts';
export {
  CHANGE_REVIEW_CONFLICT_LOAD_ERROR_PREFIX,
  describeReviewConflictCandidate,
  describeReviewConflictDiscard,
  selectLatestReviewConflictCandidate,
} from './utils/changeReviewConflicts';
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
