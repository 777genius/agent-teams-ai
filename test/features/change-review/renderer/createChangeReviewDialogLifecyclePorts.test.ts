import {
  createChangeReviewDialogLifecycleCommandPort,
  createChangeReviewDialogLifecycleStatePort,
} from '@features/change-review/renderer';
import { describe, expect, it, vi } from 'vitest';

function createStore() {
  return {
    editedContents: { '/repo/a.ts': 'manual' },
    hunkDecisions: { '/repo/a.ts:0': 'accepted' as const },
    fileDecisions: {},
    reviewActionHistory: [],
    reviewRedoHistory: [],
    fileContents: {},
    fileChunkCounts: { '/repo/a.ts': 1 },
    decisionHydrationScopeKey: 'hydration-a',
    decisionHydrationStatus: 'loaded' as const,
    applying: false,
    applyError: null as string | null,
    resetAllReviewState: vi.fn(),
    clearChangeReviewCache: vi.fn(),
    fetchAgentChanges: vi.fn().mockResolvedValue(undefined),
    fetchTaskChanges: vi.fn().mockResolvedValue(undefined),
    clearDecisionsFromDisk: vi.fn().mockResolvedValue(true),
    applyReview: vi.fn().mockResolvedValue({
      applied: 1,
      skipped: 0,
      conflicts: 0,
      errors: [],
    }),
  };
}

describe('change-review dialog lifecycle ports', () => {
  it('exposes only lifecycle state and delegates local state transitions', () => {
    const store = createStore();
    const reportError = vi.fn();
    const completeSavedStateDiscard = vi.fn();
    const port = createChangeReviewDialogLifecycleStatePort({
      getStore: () => store,
      reportError,
      completeSavedStateDiscard,
    });

    expect(port.getSnapshot()).toEqual({
      editedContents: { '/repo/a.ts': 'manual' },
      hunkDecisions: { '/repo/a.ts:0': 'accepted' },
      fileDecisions: {},
      reviewActionHistory: [],
      reviewRedoHistory: [],
      fileContents: {},
      fileChunkCounts: { '/repo/a.ts': 1 },
      decisionHydrationScopeKey: 'hydration-a',
      decisionHydrationStatus: 'loaded',
      applying: false,
    });

    port.reportError('failed');
    port.completeSavedStateDiscard(true);
    expect(reportError).toHaveBeenCalledWith('failed');
    expect(completeSavedStateDiscard).toHaveBeenCalledWith(true);
  });

  it('maps fetch, hydration, recovery, apply, and durable cleanup commands exactly', async () => {
    const store = createStore();
    const hydrateDecisions = vi.fn().mockResolvedValue(undefined);
    const retryMutationRecovery = vi.fn().mockResolvedValue({
      decisionRevision: 5,
      diskPostimages: [],
    });
    const port = createChangeReviewDialogLifecycleCommandPort({
      getStore: () => store,
      getReviewApi: () => ({ retryMutationRecovery }),
      hydrateDecisions,
    });
    const scope = {
      teamName: 'team',
      scopeKey: 'task-task',
      scopeToken: 'token',
    };
    const recoveryRequest = {
      scope: { teamName: 'team', taskId: 'task' },
      decisionPersistenceScope: {
        scopeKey: 'task-task',
        scopeToken: 'token',
      },
    };

    port.resetAllReviewState();
    port.clearChangeReviewCache();
    port.fetchAgentChanges('team', 'alice');
    port.fetchTaskChanges('team', 'task', { owner: 'alice' });
    await port.hydrateDecisions(scope, 'hydration-a');
    await port.clearDecisions(scope, true);
    await expect(port.applyReview('team', 'task', undefined)).resolves.toMatchObject({
      status: 'applied',
      result: { applied: 1 },
    });
    await port.retryMutationRecovery(recoveryRequest);

    expect(store.resetAllReviewState).toHaveBeenCalledOnce();
    expect(store.clearChangeReviewCache).toHaveBeenCalledOnce();
    expect(store.fetchAgentChanges).toHaveBeenCalledWith('team', 'alice');
    expect(store.fetchTaskChanges).toHaveBeenCalledWith('team', 'task', { owner: 'alice' });
    expect(hydrateDecisions).toHaveBeenCalledWith(scope, 'hydration-a');
    expect(store.clearDecisionsFromDisk).toHaveBeenCalledWith('team', 'task-task', 'token', true);
    expect(store.applyReview).toHaveBeenCalledWith('team', 'task', undefined);
    expect(retryMutationRecovery).toHaveBeenCalledWith(recoveryRequest);
  });

  it('returns an operation-owned failed Apply outcome for null and partial results', async () => {
    const store = createStore();
    const port = createChangeReviewDialogLifecycleCommandPort({
      getStore: () => store,
      getReviewApi: () => ({ retryMutationRecovery: vi.fn() }),
      hydrateDecisions: vi.fn(),
    });

    store.applyError = 'Review scope changed. Reload Changes before applying.';
    store.applyReview
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        applied: 0,
        skipped: 1,
        conflicts: 1,
        errors: [
          { filePath: '/repo/a.ts', error: 'changed' },
          { filePath: '/repo/b.ts', error: 'also changed' },
        ],
      })
      .mockResolvedValueOnce(null);

    await expect(port.applyReview('team', 'task', undefined)).resolves.toEqual({
      status: 'failed',
      result: null,
      errorMessage: 'Review scope changed. Reload Changes before applying.',
    });
    await expect(port.applyReview('team', 'task', undefined)).resolves.toEqual({
      status: 'failed',
      result: {
        applied: 0,
        skipped: 1,
        conflicts: 1,
        errors: [
          { filePath: '/repo/a.ts', error: 'changed' },
          { filePath: '/repo/b.ts', error: 'also changed' },
        ],
      },
      errorMessage: 'changed\nalso changed',
    });
    store.applyError = null;
    await expect(port.applyReview('team', 'task', undefined)).resolves.toEqual({
      status: 'failed',
      result: null,
      errorMessage: 'Unable to apply this review. Changes remains open; retry Apply.',
    });
  });
});
