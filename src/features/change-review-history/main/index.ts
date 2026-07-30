import * as reviewDecisionHistoryIpc from './adapters/input/ipc/registerReviewDecisionHistoryIpc';
import * as reviewDraftHistoryIpc from './adapters/input/ipc/registerReviewDraftHistoryIpc';

import type { ReviewDecisionHistoryApplication } from '../core/application/ReviewDecisionHistoryApplication';
import type { ReviewDraftHistoryApplication } from '../core/application/ReviewDraftHistoryApplication';
import type { IpcResult } from '@shared/types/ipc';

export type {
  ReviewDraftHistoryAuthorization,
  ReviewDraftHistoryAuthorizationPort,
  ReviewDraftHistoryPersistenceLockPort,
  ReviewDraftHistoryPersistenceScope,
  ReviewHistoryPersistenceLockPort,
  ReviewHistoryPersistenceScope,
} from '../core/application/ports';
export type {
  LoadedReviewDecisionState,
  ReviewDecisionAuthorization,
  ReviewDecisionAuthorizationPort,
  ReviewDecisionHistoryDependencies,
  ReviewDecisionMutationPort,
  ReviewDecisionQueryPort,
  ReviewDecisionRecoveryInspection,
  ReviewDecisionRecoveryPort,
  ReviewDecisionValidationPort,
  SaveReviewDecisionStateInput,
} from '../core/application/ReviewDecisionHistoryPorts';
export { createReviewDecisionHistoryFeature } from './composition/createReviewDecisionHistoryFeature';
export {
  createReviewDraftHistoryFeature,
  type ReviewDraftHistoryFeatureDependencies,
} from './composition/createReviewDraftHistoryFeature';
export {
  ReviewDraftHistoryStore,
  type SaveReviewDraftHistoryEntryInput,
} from './infrastructure/ReviewDraftHistoryStore';

// Electron's IpcMain listener surface is intentionally untyped at this transport seam.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ReviewHistoryIpcListener = (event: any, ...args: any[]) => any;

export interface ReviewHistoryIpcMainPort {
  handle(channel: string, listener: ReviewHistoryIpcListener): void;
  removeHandler(channel: string): void;
}

export type ReviewHistoryIpcHandlerWrapper = <T>(
  operationName: string,
  operation: () => Promise<T>
) => Promise<IpcResult<T>>;

export type ReviewDraftHistoryIpcHandlerWrapper = ReviewHistoryIpcHandlerWrapper;

export function registerReviewDecisionHistoryIpc(
  ipcMain: ReviewHistoryIpcMainPort,
  application: ReviewDecisionHistoryApplication,
  wrapHandler: ReviewHistoryIpcHandlerWrapper
): void {
  reviewDecisionHistoryIpc.registerReviewDecisionHistoryIpc(
    ipcMain as never,
    application,
    wrapHandler
  );
}

export function removeReviewDecisionHistoryIpc(ipcMain: ReviewHistoryIpcMainPort): void {
  reviewDecisionHistoryIpc.removeReviewDecisionHistoryIpc(ipcMain as never);
}

export function registerReviewDraftHistoryIpc(
  ipcMain: ReviewHistoryIpcMainPort,
  application: ReviewDraftHistoryApplication,
  wrapHandler: ReviewDraftHistoryIpcHandlerWrapper
): void {
  reviewDraftHistoryIpc.registerReviewDraftHistoryIpc(ipcMain as never, application, wrapHandler);
}

export function removeReviewDraftHistoryIpc(ipcMain: ReviewHistoryIpcMainPort): void {
  reviewDraftHistoryIpc.removeReviewDraftHistoryIpc(ipcMain as never);
}
