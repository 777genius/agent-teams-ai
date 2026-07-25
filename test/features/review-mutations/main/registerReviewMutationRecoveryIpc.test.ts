import {
  REVIEW_EXECUTE_MUTATION,
  REVIEW_MUTATION_RECOVERY_IPC_CHANNELS,
  REVIEW_RESTORE_HISTORY,
  REVIEW_RETRY_MUTATION_RECOVERY,
} from '@features/review-mutations/contracts';
import {
  registerReviewMutationRecoveryIpc,
  removeReviewMutationRecoveryIpc,
} from '@features/review-mutations/main';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  ReviewMutationIpcHandlerWrapper,
  ReviewMutationRecoveryApplication,
} from '@features/review-mutations/main';

type Handler = (...args: unknown[]) => unknown;

describe('review mutation recovery IPC', () => {
  const handlers = new Map<string, Handler>();
  const wrapperLabels: string[] = [];
  const ipcMain = {
    handle: vi.fn((channel: string, handler: Handler) => {
      if (handlers.has(channel)) throw new Error(`Duplicate IPC registration: ${channel}`);
      handlers.set(channel, handler);
    }),
    removeHandler: vi.fn((channel: string) => {
      handlers.delete(channel);
    }),
  };
  const wrapHandler: ReviewMutationIpcHandlerWrapper = async (label, operation) => {
    wrapperLabels.push(label);
    try {
      return { success: true, data: await operation() };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  };
  const application = {
    execute: vi.fn(async () => ({ decisionRevision: 2, diskPostimages: [] })),
    restoreHistory: vi.fn(async () => ({
      decisionRevision: 2,
      persistedState: {
        hunkDecisions: {},
        fileDecisions: {},
        reviewActionHistory: [],
        reviewRedoHistory: [],
      },
      direction: 'none',
      actionCount: 0,
      diskPostimages: [],
    })),
    retryRecovery: vi.fn(async () => ({
      decisionRevision: 2,
      recoveredMutation: false,
      recoveredRestoreHistory: false,
      differentMutationPending: false,
      persistedState: null,
      expectedRestoreCompleted: false,
      diskPostimages: [],
      retried: false,
    })),
  } as unknown as ReviewMutationRecoveryApplication;

  beforeEach(() => {
    handlers.clear();
    wrapperLabels.length = 0;
    vi.clearAllMocks();
    registerReviewMutationRecoveryIpc(ipcMain as never, application, wrapHandler);
  });

  it('owns and removes the three stable public channels', () => {
    expect(REVIEW_MUTATION_RECOVERY_IPC_CHANNELS).toEqual([
      'review:executeMutation',
      'review:retryMutationRecovery',
      'review:restoreHistory',
    ]);
    expect([...handlers.keys()]).toEqual(REVIEW_MUTATION_RECOVERY_IPC_CHANNELS);

    removeReviewMutationRecoveryIpc(ipcMain as never);

    expect(ipcMain.removeHandler.mock.calls.map(([channel]) => channel)).toEqual(
      REVIEW_MUTATION_RECOVERY_IPC_CHANNELS
    );
    expect(handlers.size).toBe(0);
  });

  it('preserves the legacy wrapper labels and success envelopes', async () => {
    const executeRequest = { kind: 'undo', diskSteps: [] };
    const restoreRequest = { target: { kind: 'start' } };
    const retryRequest = { scope: { teamName: 'safe-team' } };

    await expect(handlers.get(REVIEW_EXECUTE_MUTATION)!({}, executeRequest)).resolves.toEqual({
      success: true,
      data: { decisionRevision: 2, diskPostimages: [] },
    });
    await handlers.get(REVIEW_RESTORE_HISTORY)!({}, restoreRequest);
    await handlers.get(REVIEW_RETRY_MUTATION_RECOVERY)!({}, retryRequest);

    expect(application.execute).toHaveBeenCalledWith(executeRequest);
    expect(application.restoreHistory).toHaveBeenCalledWith(restoreRequest);
    expect(application.retryRecovery).toHaveBeenCalledWith(retryRequest);
    expect(wrapperLabels).toEqual(['executeMutation', 'restoreHistory', 'retryMutationRecovery']);
  });

  it('keeps malformed execute requests outside the wrapper error boundary', async () => {
    await expect(handlers.get(REVIEW_EXECUTE_MUTATION)!({}, null)).resolves.toEqual({
      success: false,
      error: 'Invalid review mutation request',
    });
    expect(application.execute).not.toHaveBeenCalled();
    expect(wrapperLabels).toEqual([]);
  });

  it('keeps malformed recovery requests inside the legacy wrapper envelope', async () => {
    await expect(handlers.get(REVIEW_RETRY_MUTATION_RECOVERY)!({}, [])).resolves.toEqual({
      success: false,
      error: 'Invalid review mutation recovery request',
    });
    expect(wrapperLabels).toEqual(['retryMutationRecovery']);
  });
});
