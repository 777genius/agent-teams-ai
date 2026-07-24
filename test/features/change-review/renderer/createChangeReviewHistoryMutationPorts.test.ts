import {
  createChangeReviewHistoryMutationCommandPort,
  createChangeReviewHistoryMutationStatePort,
} from '@features/change-review/renderer';
import { describe, expect, it, vi } from 'vitest';

describe('change review history mutation ports', () => {
  it('maps command calls lazily to the active review API', async () => {
    const executeMutation = vi.fn().mockResolvedValue({ decisionRevision: 2, diskPostimages: [] });
    const restoreHistory = vi.fn().mockResolvedValue({
      decisionRevision: 2,
      persistedState: {},
      direction: 'undo',
      actionCount: 1,
      diskPostimages: [],
    });
    const retryMutationRecovery = vi.fn().mockResolvedValue({ decisionRevision: 2 });
    const getReviewApi = vi.fn(() => ({
      executeMutation,
      restoreHistory,
      retryMutationRecovery,
    }));
    const port = createChangeReviewHistoryMutationCommandPort(getReviewApi);
    const request = { kind: 'request' } as never;

    await port.executeMutation(request);
    await port.restoreHistory(request);
    await port.retryRecovery(request);

    expect(getReviewApi).toHaveBeenCalledTimes(3);
    expect(executeMutation).toHaveBeenCalledWith(request);
    expect(restoreHistory).toHaveBeenCalledWith(request);
    expect(retryMutationRecovery).toHaveBeenCalledWith(request);
  });

  it('keeps state effects behind the supplied adapter callbacks', async () => {
    const snapshot = {
      hunkDecisions: {},
      fileDecisions: {},
      hunkContextHashesByFile: {},
      decisionRevision: 1,
    };
    const callbacks = {
      getSnapshot: vi.fn(() => snapshot),
      quiesceDecisionPersistence: vi.fn().mockResolvedValue(true),
      recordDecisionRevision: vi.fn(),
      applyDecisionState: vi.fn(),
      applyPersistedState: vi.fn(),
      reportError: vi.fn(),
      clearExternalChange: vi.fn(),
      invalidateResolvedFileContent: vi.fn(),
    };
    const port = createChangeReviewHistoryMutationStatePort(callbacks);
    const scope = { teamName: 'team', scopeKey: 'scope', scopeToken: 'token' };

    expect(port.getSnapshot()).toBe(snapshot);
    await expect(port.quiesceDecisionPersistence(scope)).resolves.toBe(true);
    port.recordDecisionRevision(scope, 2);
    port.reportError('failed');
    port.clearExternalChange('/repo/file.ts');
    port.invalidateResolvedFileContent('/repo/file.ts');

    expect(callbacks.recordDecisionRevision).toHaveBeenCalledWith(scope, 2);
    expect(callbacks.reportError).toHaveBeenCalledWith('failed');
  });
});
