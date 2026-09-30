import {
  REVIEW_EXECUTE_MUTATION,
  REVIEW_MUTATION_RECOVERY_IPC_CHANNELS,
  REVIEW_RESTORE_HISTORY,
  REVIEW_RETRY_MUTATION_RECOVERY,
} from '../../../../contracts';
import { MAX_REVIEW_MUTATION_STEPS } from '../../../application/ReviewMutationRecoveryApplication';

import type { ReviewMutationRecoveryApplication } from '../../../application/ReviewMutationRecoveryApplication';
import type { IpcResult } from '@shared/types/ipc';
import type {
  ExecuteReviewMutationRequest,
  RestoreReviewHistoryRequest,
  RetryReviewMutationRecoveryRequest,
} from '@shared/types/review';
import type { IpcMain, IpcMainInvokeEvent } from 'electron';

export type ReviewMutationIpcHandlerWrapper = <T>(
  operationName: string,
  operation: () => Promise<T>
) => Promise<IpcResult<T>>;

export function registerReviewMutationRecoveryIpc(
  ipcMain: IpcMain,
  application: ReviewMutationRecoveryApplication,
  wrapHandler: ReviewMutationIpcHandlerWrapper
): void {
  ipcMain.handle(
    REVIEW_EXECUTE_MUTATION,
    async (_event: IpcMainInvokeEvent, requestValue: unknown) => {
      if (!isExecuteReviewMutationRequest(requestValue)) {
        return { success: false, error: 'Invalid review mutation request' };
      }
      return wrapHandler('executeMutation', () => application.execute(requestValue));
    }
  );
  ipcMain.handle(
    REVIEW_RETRY_MUTATION_RECOVERY,
    (_event: IpcMainInvokeEvent, requestValue: unknown) =>
      wrapHandler('retryMutationRecovery', () => {
        if (!requestValue || typeof requestValue !== 'object' || Array.isArray(requestValue)) {
          throw new Error('Invalid review mutation recovery request');
        }
        return application.retryRecovery(requestValue as RetryReviewMutationRecoveryRequest);
      })
  );
  ipcMain.handle(REVIEW_RESTORE_HISTORY, (_event: IpcMainInvokeEvent, requestValue: unknown) =>
    wrapHandler('restoreHistory', () => {
      if (!requestValue || typeof requestValue !== 'object' || Array.isArray(requestValue)) {
        throw new Error('Invalid review history restore request');
      }
      return application.restoreHistory(requestValue as RestoreReviewHistoryRequest);
    })
  );
}

export function removeReviewMutationRecoveryIpc(ipcMain: IpcMain): void {
  for (const channel of REVIEW_MUTATION_RECOVERY_IPC_CHANNELS) {
    ipcMain.removeHandler(channel);
  }
}

function isExecuteReviewMutationRequest(value: unknown): value is ExecuteReviewMutationRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const request = value as Partial<ExecuteReviewMutationRequest>;
  const allowsEmptyDiskMutation =
    request.kind === 'undo' || request.kind === 'redo' || request.kind === 'reload-external';
  return (
    (request.kind === 'restore' ||
      request.kind === 'rename' ||
      request.kind === 'undo' ||
      request.kind === 'redo' ||
      request.kind === 'reload-external') &&
    Array.isArray(request.diskSteps) &&
    (allowsEmptyDiskMutation || request.diskSteps.length > 0) &&
    request.diskSteps.length <= MAX_REVIEW_MUTATION_STEPS
  );
}
