import {
  REVIEW_DECISION_HISTORY_IPC_CHANNELS,
  REVIEW_DRAFT_HISTORY_IPC_CHANNELS,
} from '@features/change-review-history/contracts';
import { REVIEW_MUTATION_RECOVERY_IPC_CHANNELS } from '@features/review-mutations/contracts';
import {
  createReviewFileWatchFeature,
  registerReviewDecisionHistoryIpc,
  registerReviewDraftHistoryIpc,
  registerReviewMutationRecoveryIpc,
  removeReviewDecisionHistoryIpc,
  removeReviewDraftHistoryIpc,
  removeReviewMutationRecoveryIpc,
} from '@main/ipc/reviewFeatureComposition';
import { describe, expect, it, vi } from 'vitest';

import type { IpcResult } from '@shared/types/ipc';
import type { IpcMain } from 'electron';

describe('review feature composition', () => {
  it('resolves the feature-owned file-watch composition without a public factory', () => {
    const feature = createReviewFileWatchFeature();

    expect(feature).toEqual(
      expect.objectContaining({
        configure: expect.any(Function),
        dispose: expect.any(Function),
        prepareUnwatch: expect.any(Function),
        prepareWatch: expect.any(Function),
        setMainWindow: expect.any(Function),
        supersedePendingRequests: expect.any(Function),
      })
    );

    feature.dispose();
  });

  it('wires and removes the exact feature-owned review IPC channels', () => {
    const registeredChannels: string[] = [];
    const removedChannels: string[] = [];
    const ipcMain = {
      handle: vi.fn((channel: string) => registeredChannels.push(channel)),
      removeHandler: vi.fn((channel: string) => removedChannels.push(channel)),
    } as unknown as IpcMain;
    const wrapHandler = async <T>(
      _operationName: string,
      operation: () => Promise<T>
    ): Promise<IpcResult<T>> => ({ success: true, data: await operation() });

    registerReviewDecisionHistoryIpc(ipcMain, {} as never, wrapHandler);
    registerReviewDraftHistoryIpc(ipcMain, {} as never, wrapHandler);
    registerReviewMutationRecoveryIpc(ipcMain, {} as never, wrapHandler);
    removeReviewDecisionHistoryIpc(ipcMain);
    removeReviewDraftHistoryIpc(ipcMain);
    removeReviewMutationRecoveryIpc(ipcMain);

    const expectedChannels = [
      ...REVIEW_DECISION_HISTORY_IPC_CHANNELS,
      ...REVIEW_DRAFT_HISTORY_IPC_CHANNELS,
      ...REVIEW_MUTATION_RECOVERY_IPC_CHANNELS,
    ];
    expect(registeredChannels).toEqual(expectedChannels);
    expect(removedChannels).toEqual(expectedChannels);
  });
});
