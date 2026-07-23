export { createChangeReviewDraftHistoryPort } from './adapters/createChangeReviewDraftHistoryPort';
export type {
  ChangeReviewDraftHistoryController,
  ChangeReviewDraftHistoryDiagnostics,
} from './hooks/useChangeReviewDraftHistoryController';
export { useChangeReviewDraftHistoryController } from './hooks/useChangeReviewDraftHistoryController';
export { useChangeReviewLifecycleRegistration } from './hooks/useChangeReviewLifecycleRegistration';
export { useChangeReviewOperationGeneration } from './hooks/useChangeReviewOperationGeneration';
export { useChangeReviewScopeIdentity } from './hooks/useChangeReviewScopeIdentity';
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
export type { TaskChangesEmptyStateProps } from './ui/TaskChangesEmptyState';
export { TaskChangesEmptyState } from './ui/TaskChangesEmptyState';
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
