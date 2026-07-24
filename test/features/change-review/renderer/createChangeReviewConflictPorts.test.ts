import {
  createChangeReviewConflictCommandPort,
  createChangeReviewConflictQueryPort,
} from '@features/change-review/renderer';
import { describe, expect, it, vi } from 'vitest';

import type { ReviewAPI } from '@shared/types/api';

describe('change review conflict ports', () => {
  it('resolves the query API lazily for every operation', async () => {
    const firstApi = {
      loadDecisionConflictCandidates: vi.fn(() => Promise.resolve([])),
      loadDraftHistoryConflictCandidates: vi.fn(() => Promise.resolve([])),
    };
    const secondApi = {
      loadDecisionConflictCandidates: vi.fn(() => Promise.resolve([])),
      loadDraftHistoryConflictCandidates: vi.fn(() => Promise.resolve([])),
    };
    let currentApi = firstApi;
    const getReviewApi = vi.fn(() => currentApi);
    const port = createChangeReviewConflictQueryPort(getReviewApi);
    const scope = { teamName: 'team-a', scopeKey: 'task-a', scopeToken: 'token-a' };

    expect(getReviewApi).not.toHaveBeenCalled();
    await port.loadDecisionCandidates(scope);
    currentApi = secondApi;
    await port.loadDraftHistoryCandidates(scope);

    expect(firstApi.loadDecisionConflictCandidates).toHaveBeenCalledWith(
      'team-a',
      'task-a',
      'token-a'
    );
    expect(secondApi.loadDraftHistoryConflictCandidates).toHaveBeenCalledWith(
      'team-a',
      'task-a',
      'token-a'
    );
    expect(getReviewApi).toHaveBeenCalledTimes(2);
  });

  it('resolves the command API lazily and preserves decision CAS arguments', async () => {
    const firstResolve = vi.fn<ReviewAPI['resolveDecisionConflictCandidate']>(() =>
      Promise.resolve({ revision: 4 })
    );
    const secondResolve = vi.fn<ReviewAPI['resolveDecisionConflictCandidate']>(() =>
      Promise.resolve({ revision: 5 })
    );
    let currentApi = { resolveDecisionConflictCandidate: firstResolve };
    const getReviewApi = vi.fn(() => currentApi);
    const port = createChangeReviewConflictCommandPort(getReviewApi);
    const input = {
      scope: { teamName: 'team-a', scopeKey: 'task-a', scopeToken: 'token-a' },
      candidateId: 'candidate-a',
      resolution: 'recover-candidate' as const,
      observedCurrentRevision: 3,
    };

    await expect(port.resolveDecisionCandidate(input)).resolves.toEqual({ revision: 4 });
    currentApi = { resolveDecisionConflictCandidate: secondResolve };
    await port.resolveDecisionCandidate({ ...input, resolution: 'keep-current' });

    expect(firstResolve).toHaveBeenCalledWith(
      'team-a',
      'task-a',
      'token-a',
      'candidate-a',
      'recover-candidate',
      3
    );
    expect(secondResolve).toHaveBeenCalledWith(
      'team-a',
      'task-a',
      'token-a',
      'candidate-a',
      'keep-current',
      3
    );
    expect(getReviewApi).toHaveBeenCalledTimes(2);
  });
});
