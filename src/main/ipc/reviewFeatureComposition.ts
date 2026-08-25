import {
  createReviewDecisionHistoryFeature,
  createReviewDraftHistoryFeature,
} from '@features/change-review-history/main';
import { createReviewMutationRecoveryFeature } from '@features/review-mutations/main';

import type {
  ReviewFileWatchConfiguration,
  ReviewFileWatchOperation,
} from '@features/change-review/main';
import type { IpcResult } from '@shared/types/ipc';
import type { BrowserWindow, IpcMain } from 'electron';

interface ReviewFileWatchCompositionModule {
  createReviewFileWatchFeature(): {
    supersedePendingRequests(): void;
    configure(configuration: ReviewFileWatchConfiguration): void;
    prepareWatch(projectPath: string, filePaths: unknown): ReviewFileWatchOperation;
    prepareUnwatch(): ReviewFileWatchOperation;
    dispose(): void;
    setMainWindow(window: BrowserWindow | null): void;
  };
}

type ReviewIpcHandlerWrapper = <T>(
  operationName: string,
  operation: () => Promise<T>
) => Promise<IpcResult<T>>;

interface ReviewDecisionHistoryIpcModule {
  registerReviewDecisionHistoryIpc(
    ipcMain: IpcMain,
    application: ReturnType<typeof createReviewDecisionHistoryFeature>,
    wrapHandler: ReviewIpcHandlerWrapper
  ): void;
  removeReviewDecisionHistoryIpc(ipcMain: IpcMain): void;
}

interface ReviewDraftHistoryIpcModule {
  registerReviewDraftHistoryIpc(
    ipcMain: IpcMain,
    application: ReturnType<typeof createReviewDraftHistoryFeature>,
    wrapHandler: ReviewIpcHandlerWrapper
  ): void;
  removeReviewDraftHistoryIpc(ipcMain: IpcMain): void;
}

interface ReviewMutationRecoveryIpcModule {
  registerReviewMutationRecoveryIpc(
    ipcMain: IpcMain,
    application: ReturnType<typeof createReviewMutationRecoveryFeature>,
    wrapHandler: ReviewIpcHandlerWrapper
  ): void;
  removeReviewMutationRecoveryIpc(ipcMain: IpcMain): void;
}

const reviewFileWatchCompositionPath =
  '../../features/change-review/main/composition/createReviewFileWatchFeature.ts';
const reviewDecisionHistoryIpcPath =
  '../../features/change-review-history/main/adapters/input/ipc/registerReviewDecisionHistoryIpc.ts';
const reviewDraftHistoryIpcPath =
  '../../features/change-review-history/main/adapters/input/ipc/registerReviewDraftHistoryIpc.ts';
const reviewMutationRecoveryIpcPath =
  '../../features/review-mutations/main/adapters/input/ipc/registerReviewMutationRecoveryIpc.ts';

export const { createReviewFileWatchFeature } = import.meta.glob<ReviewFileWatchCompositionModule>(
  '../../features/change-review/main/composition/createReviewFileWatchFeature.ts',
  { eager: true }
)[reviewFileWatchCompositionPath];
export const { registerReviewDecisionHistoryIpc, removeReviewDecisionHistoryIpc } =
  import.meta.glob<ReviewDecisionHistoryIpcModule>(
    '../../features/change-review-history/main/adapters/input/ipc/registerReviewDecisionHistoryIpc.ts',
    { eager: true }
  )[reviewDecisionHistoryIpcPath];
export const { registerReviewDraftHistoryIpc, removeReviewDraftHistoryIpc } =
  import.meta.glob<ReviewDraftHistoryIpcModule>(
    '../../features/change-review-history/main/adapters/input/ipc/registerReviewDraftHistoryIpc.ts',
    { eager: true }
  )[reviewDraftHistoryIpcPath];
export const { registerReviewMutationRecoveryIpc, removeReviewMutationRecoveryIpc } =
  import.meta.glob<ReviewMutationRecoveryIpcModule>(
    '../../features/review-mutations/main/adapters/input/ipc/registerReviewMutationRecoveryIpc.ts',
    { eager: true }
  )[reviewMutationRecoveryIpcPath];
