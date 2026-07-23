import { createChangeReviewDraftHistoryPort } from '@features/change-review/renderer';
import { describe, expect, it, vi } from 'vitest';

import type { ReviewAPI } from '@shared/types/api';

type DraftHistoryReviewApi = Pick<
  ReviewAPI,
  | 'loadDraftHistory'
  | 'saveDraftHistoryEntry'
  | 'clearDraftHistory'
  | 'checkConflict'
  | 'replaceDraftHistoryConflictCandidate'
  | 'resolveDraftHistoryConflictCandidate'
>;

function reviewApi(loadDraftHistory: ReviewAPI['loadDraftHistory']): DraftHistoryReviewApi {
  return {
    loadDraftHistory,
    saveDraftHistoryEntry: vi.fn(),
    clearDraftHistory: vi.fn(),
    checkConflict: vi.fn(),
    replaceDraftHistoryConflictCandidate: vi.fn(),
    resolveDraftHistoryConflictCandidate: vi.fn(),
  };
}

describe('createChangeReviewDraftHistoryPort', () => {
  it('resolves the review API lazily for every operation', async () => {
    const firstLoad = vi.fn<ReviewAPI['loadDraftHistory']>(() => Promise.resolve(null));
    const secondLoad = vi.fn<ReviewAPI['loadDraftHistory']>(() => Promise.resolve({ entries: {} }));
    let currentApi = reviewApi(firstLoad);
    const getReviewApi = vi.fn(() => currentApi);
    const port = createChangeReviewDraftHistoryPort(getReviewApi);
    const scope = { teamName: 'team-a', scopeKey: 'task-task-a', scopeToken: 'scope-token' };

    expect(getReviewApi).not.toHaveBeenCalled();
    await expect(port.load(scope)).resolves.toBeNull();
    expect(firstLoad).toHaveBeenCalledWith('team-a', 'task-task-a', 'scope-token');

    currentApi = reviewApi(secondLoad);
    await expect(port.load(scope)).resolves.toEqual({ entries: {} });
    expect(getReviewApi).toHaveBeenCalledTimes(2);
    expect(secondLoad).toHaveBeenCalledWith('team-a', 'task-task-a', 'scope-token');
  });
});
