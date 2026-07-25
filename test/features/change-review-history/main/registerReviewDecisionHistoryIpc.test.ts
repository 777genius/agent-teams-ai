import {
  REVIEW_CLEAR_DECISIONS,
  REVIEW_DECISION_HISTORY_IPC_CHANNELS,
  REVIEW_LOAD_DECISION_CONFLICT_CANDIDATES,
  REVIEW_LOAD_DECISIONS,
  REVIEW_RESOLVE_DECISION_CONFLICT_CANDIDATE,
  REVIEW_SAVE_DECISIONS,
} from '@features/change-review-history/contracts';
import {
  registerReviewDecisionHistoryIpc,
  removeReviewDecisionHistoryIpc,
} from '@features/change-review-history/main';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ReviewDecisionHistoryApplication } from '@features/change-review-history/core/application/ReviewDecisionHistoryApplication';
import type { ReviewHistoryIpcHandlerWrapper } from '@features/change-review-history/main';

type Handler = (...args: unknown[]) => unknown;

describe('change review decision-history IPC', () => {
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
  const wrapHandler: ReviewHistoryIpcHandlerWrapper = async (label, operation) => {
    wrapperLabels.push(label);
    try {
      return { success: true, data: await operation() };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  };
  const application = {
    load: vi.fn(async () => null),
    loadConflictCandidates: vi.fn(async () => []),
    resolveConflictCandidate: vi.fn(async () => ({ revision: 2 })),
    save: vi.fn(async () => ({ revision: 1 })),
    clear: vi.fn(async () => ({ revision: 0 })),
  } as unknown as ReviewDecisionHistoryApplication;

  beforeEach(() => {
    handlers.clear();
    wrapperLabels.length = 0;
    vi.clearAllMocks();
    registerReviewDecisionHistoryIpc(ipcMain as never, application, wrapHandler);
  });

  it('owns and removes the five stable decision-history channels', () => {
    expect(REVIEW_DECISION_HISTORY_IPC_CHANNELS).toEqual([
      'review:loadDecisions',
      'review:loadDecisionConflictCandidates',
      'review:resolveDecisionConflictCandidate',
      'review:saveDecisions',
      'review:clearDecisions',
    ]);
    expect([...handlers.keys()]).toEqual(REVIEW_DECISION_HISTORY_IPC_CHANNELS);

    removeReviewDecisionHistoryIpc(ipcMain as never);

    expect(ipcMain.removeHandler.mock.calls.map(([channel]) => channel)).toEqual(
      REVIEW_DECISION_HISTORY_IPC_CHANNELS
    );
    expect(handlers.size).toBe(0);
  });

  it('preserves positional save arguments and the review success envelope', async () => {
    const action = {
      id: 'accept-hunk',
      createdAt: '2026-07-23T12:00:00.000Z',
      kind: 'hunk' as const,
      action: { filePath: '/repo/reviewed.ts', originalIndex: 0 },
    };

    await expect(
      handlers.get(REVIEW_SAVE_DECISIONS)!(
        {},
        'safe-team',
        'agent-worker',
        'scope-token',
        { '/repo/reviewed.ts:0': 'accepted' },
        {},
        null,
        [action],
        0,
        []
      )
    ).resolves.toEqual({ success: true, data: { revision: 1 } });
    expect(application.save).toHaveBeenCalledWith(
      'safe-team',
      'agent-worker',
      'scope-token',
      { '/repo/reviewed.ts:0': 'accepted' },
      {},
      null,
      [action],
      0,
      []
    );
    expect(wrapperLabels).toEqual(['saveDecisions']);
  });

  it('uses the exact legacy error-boundary label for every operation', async () => {
    await handlers.get(REVIEW_LOAD_DECISIONS)!({}, 'team', 'agent-worker', 'scope');
    await handlers.get(REVIEW_LOAD_DECISION_CONFLICT_CANDIDATES)!(
      {},
      'team',
      'agent-worker',
      'scope'
    );
    await handlers.get(REVIEW_RESOLVE_DECISION_CONFLICT_CANDIDATE)!(
      {},
      'team',
      'agent-worker',
      'scope',
      'candidate',
      'keep-current',
      1
    );
    await handlers.get(REVIEW_SAVE_DECISIONS)!(
      {},
      'team',
      'agent-worker',
      'scope',
      {},
      {},
      null,
      [],
      0,
      []
    );
    await handlers.get(REVIEW_CLEAR_DECISIONS)!({}, 'team', 'agent-worker', 'scope', 1);

    expect(wrapperLabels).toEqual([
      'loadDecisions',
      'loadDecisionConflictCandidates',
      'resolveDecisionConflictCandidate',
      'saveDecisions',
      'clearDecisions',
    ]);
  });

  it('preserves the review error envelope', async () => {
    vi.mocked(application.load).mockRejectedValueOnce(new Error('decision read failed'));

    await expect(
      handlers.get(REVIEW_LOAD_DECISIONS)!({}, 'safe-team', 'agent-worker', 'scope-token')
    ).resolves.toEqual({ success: false, error: 'decision read failed' });
  });
});
