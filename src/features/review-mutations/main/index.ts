export { ReviewMutationApplyResultError } from '../core/application/ReviewMutationApplyResultError';
export {
  ReviewMutationCoordinator,
  type ReviewMutationJournalPort,
  type ReviewMutationPhaseObserver,
  type ReviewMutationSteps,
} from '../core/application/ReviewMutationCoordinator';
export type {
  PrepareReviewMutationInput,
  ReviewMutationJournalDiskStep,
  ReviewMutationJournalPathPostimage,
  ReviewMutationJournalPathTransition,
  ReviewMutationJournalRecord,
} from '../core/application/ReviewMutationJournalTypes';
export { isDurableReviewEqual } from '../core/domain/durableReviewValue';
export {
  assertPersistedStateIncludesDecisions,
  composeReviewDiskTransitions,
  mergeReviewApplyResults,
  mergeReviewMutationDiskPostimages,
} from '../core/domain/reviewDecisionBatch';
export {
  assertCurrentReviewDecisionRevision,
  assertExactApplyReviewHistoryTransition,
  type ReviewDecisionCommandCurrentState,
  type ReviewDecisionCommandPolicyContext,
} from '../core/domain/reviewDecisionCommandPolicy';
export {
  type DeleteEditedFileInput,
  parseDeleteEditedFileInput,
  parseSaveEditedFileInput,
  type SaveEditedFileInput,
} from '../core/domain/reviewEditableMutationPolicy';
export {
  buildReviewExternalReloadState,
  buildReviewHistoryRestorePlan,
  buildReviewRestoreDecisionState,
  buildReviewUndoDecisionState,
  restoreReviewDecisionRecordsForFile,
  restoreReviewDecisionRecordsForFiles,
  type ReviewDecisionRecords,
  type ReviewHistoryRestorePlan,
} from '../core/domain/reviewHistoryDecisions';
export {
  buildForwardDiskMutationSteps,
  buildRedoDiskMutationSteps,
  buildReviewHistoryRestoreDiskImpact,
  buildReviewHistoryRestoreDiskSteps,
  buildUndoDiskMutationSteps,
  getReviewActionDiskSnapshots,
  type ReviewHistoryDiskTransition,
  type ReviewHistoryDiskTransitionKind,
  type ReviewHistoryLineStatsStatus,
} from '../core/domain/reviewHistoryDiskSteps';
export {
  assertAuthoritativelyBoundReviewAction,
  assertExactReviewHistoryTransition,
  findLatestRestorableDiskSnapshot,
  isAuthoritativelyBoundReviewSnapshot,
  isAuthoritativeReviewDeletion,
  rebindReviewActionDescriptorPath,
  type ReviewHistoryDecisionState,
  type ReviewHistoryMutationPolicyContext,
} from '../core/domain/reviewHistoryMutationPolicy';
export {
  isDecisionlessReviewRecoveryKind,
  parseReviewHistoryRestoreTarget,
} from '../core/domain/reviewHistoryRestoreTarget';
export { ReviewDecisionCommandApplication } from './application/ReviewDecisionCommandApplication';
export type {
  ReviewDecisionCommandApplierPort,
  ReviewDecisionCommandBatchPort,
  ReviewDecisionCommandCachePort,
  ReviewDecisionCommandCoordinatorPort,
  ReviewDecisionCommandDependencies,
  ReviewDecisionCommandHistoryPort,
  ReviewDecisionCommandLoggerPort,
  ReviewDecisionCommandPersistencePort,
  ReviewDecisionCommandRecoveryPort,
  ReviewDecisionCommandScopePort,
  ReviewDecisionCommandSnapshotIdentityPort,
} from './application/ReviewDecisionCommandPorts';
export { ReviewDirectMutationDiskService } from './application/ReviewDirectMutationDiskService';
export { ReviewEditableMutationApplication } from './application/ReviewEditableMutationApplication';
export type {
  ReviewEditableMutationApplierPort,
  ReviewEditableMutationContentPort,
  ReviewEditableMutationDependencies,
  ReviewEditableMutationScopePort,
} from './application/ReviewEditableMutationPorts';
export { ReviewHistoryMutationApplication } from './application/ReviewHistoryMutationApplication';
export type {
  ReviewHistoryMutationCurrentState,
  ReviewHistoryMutationDependencies,
  ReviewHistoryMutationFilePort,
  ReviewHistoryMutationScopePort,
} from './application/ReviewHistoryMutationPorts';
export {
  MAX_REVIEW_MUTATION_STEPS,
  ReviewMutationRecoveryApplication,
} from './application/ReviewMutationRecoveryApplication';
export type {
  DirectReviewMutationState,
  LoadedReviewMutationDecisions,
  ReviewDecisionBatchApplierPort,
  ReviewDecisionBatchDependencies,
  ReviewDecisionBatchFilePort,
  ReviewDecisionBatchFileTransaction,
  ReviewDecisionBatchPersistencePort,
  ReviewDecisionBatchScopePort,
  ReviewDirectMutationDiskDependencies,
  ReviewDirectMutationDiskPort,
  ReviewMutationContentCachePort,
  ReviewMutationCoordinatorPort,
  ReviewMutationDecisionPort,
  ReviewMutationDiskApplierPort,
  ReviewMutationJournalRepositoryPort,
  ReviewMutationLoggerPort,
  ReviewMutationPathAuthorization,
  ReviewMutationRecoveryDependencies,
  ReviewMutationScopePort,
} from './application/ReviewMutationRecoveryPorts';
export {
  createReviewDecisionBatchFeature,
  type ReviewDecisionBatchFeatureDependencies,
} from './composition/createReviewDecisionBatchFeature';
export {
  createReviewDecisionCommandFeature,
  type ReviewDecisionCommandFeatureDependencies,
} from './composition/createReviewDecisionCommandFeature';
export {
  createReviewEditableMutationFeature,
  type ReviewEditableMutationFeatureDependencies,
} from './composition/createReviewEditableMutationFeature';
export {
  createReviewHistoryMutationFeature,
  type ReviewHistoryMutationFeatureDependencies,
} from './composition/createReviewHistoryMutationFeature';
export {
  createReviewMutationRecoveryFeature,
  type ReviewMutationRecoveryFeatureDependencies,
} from './composition/createReviewMutationRecoveryFeature';

// Electron's IpcMain listener surface is intentionally untyped at this transport seam.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ReviewMutationIpcListener = (event: any, ...args: any[]) => any;

export interface ReviewMutationIpcMainPort {
  handle(channel: string, listener: ReviewMutationIpcListener): void;
  removeHandler(channel: string): void;
}

export type ReviewMutationIpcHandlerWrapper = <T>(
  operationName: string,
  operation: () => Promise<T>
) => Promise<IpcResult<T>>;

export function registerReviewMutationRecoveryIpc(
  ipcMain: ReviewMutationIpcMainPort,
  application: ReviewMutationRecoveryApplication,
  wrapHandler: ReviewMutationIpcHandlerWrapper
): void {
  reviewMutationRecoveryIpc.registerReviewMutationRecoveryIpc(
    ipcMain as never,
    application,
    wrapHandler
  );
}

export function removeReviewMutationRecoveryIpc(ipcMain: ReviewMutationIpcMainPort): void {
  reviewMutationRecoveryIpc.removeReviewMutationRecoveryIpc(ipcMain as never);
}
import * as reviewMutationRecoveryIpc from './adapters/input/ipc/registerReviewMutationRecoveryIpc';

import type { ReviewMutationRecoveryApplication } from './application/ReviewMutationRecoveryApplication';
import type { IpcResult } from '@shared/types/ipc';
