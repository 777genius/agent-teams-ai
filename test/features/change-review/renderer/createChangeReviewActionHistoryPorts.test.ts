import {
  createChangeReviewActionHistoryStorePort,
  createChangeReviewDecisionPersistencePort,
} from '@features/change-review/renderer';
import { describe, expect, it, vi } from 'vitest';

import type { ReviewUndoAction } from '@shared/types';

describe('change review action-history ports', () => {
  it('publishes history through the current lazy store', () => {
    const first = {
      setReviewActionHistory: vi.fn(),
      setReviewRedoHistory: vi.fn(),
    };
    const second = {
      setReviewActionHistory: vi.fn(),
      setReviewRedoHistory: vi.fn(),
    };
    let current = first;
    const clearLegacyUndoStack = vi.fn();
    const port = createChangeReviewActionHistoryStorePort({
      getStore: () => current,
      clearLegacyUndoStack,
    });
    const history = [{ id: 'a' }] as ReviewUndoAction[];

    port.publishUndoHistory(history);
    current = second;
    port.publishRedoHistory([]);
    port.clearLegacyUndoStack();

    expect(first.setReviewActionHistory).toHaveBeenCalledWith(history);
    expect(second.setReviewRedoHistory).toHaveBeenCalledWith([]);
    expect(clearLegacyUndoStack).toHaveBeenCalledTimes(1);
  });

  it('maps persistence scope and clears only its own error', async () => {
    const store = {
      hunkDecisions: {},
      fileDecisions: {},
      reviewActionHistory: [],
      reviewRedoHistory: [],
      fileContents: {},
      fileChunkCounts: {},
      decisionHydrationScopeKey: 'hydration',
      decisionHydrationStatus: 'loaded' as const,
      applyError: 'expected',
      loadDecisionsFromDisk: vi.fn(async () => {}),
      persistDecisions: vi.fn(),
      flushDecisionsToDisk: vi.fn(async () => true),
      clearDecisionsFromDisk: vi.fn(async () => true),
    };
    const setApplyError = vi.fn((message: string | null) => {
      store.applyError = message ?? '';
    });
    const port = createChangeReviewDecisionPersistencePort({
      getStore: () => store,
      setApplyError,
    });
    const scope = { teamName: 'team', scopeKey: 'task-a', scopeToken: 'token-a' };

    await port.load(scope);
    port.schedule(scope);
    expect(await port.flush(scope)).toBe(true);
    expect(await port.clear(scope)).toBe(true);
    expect(store.loadDecisionsFromDisk).toHaveBeenCalledWith('team', 'task-a', 'token-a');
    expect(store.persistDecisions).toHaveBeenCalledWith('team', 'task-a', 'token-a');
    expect(store.flushDecisionsToDisk).toHaveBeenCalledWith('team', 'task-a', 'token-a');
    expect(store.clearDecisionsFromDisk).toHaveBeenCalledWith('team', 'task-a', 'token-a');

    port.clearError('other');
    expect(setApplyError).not.toHaveBeenCalled();
    port.clearError('expected');
    expect(setApplyError).toHaveBeenCalledWith(null);
  });
});
