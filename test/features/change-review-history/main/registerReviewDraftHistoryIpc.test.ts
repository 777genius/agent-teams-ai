import {
  REVIEW_CLEAR_DRAFT_HISTORY,
  REVIEW_DRAFT_HISTORY_IPC_CHANNELS,
  REVIEW_LOAD_DRAFT_HISTORY,
  REVIEW_LOAD_DRAFT_HISTORY_CONFLICT_CANDIDATES,
  REVIEW_REPLACE_DRAFT_HISTORY_CONFLICT_CANDIDATE,
  REVIEW_RESOLVE_DRAFT_HISTORY_CONFLICT_CANDIDATE,
  REVIEW_SAVE_DRAFT_HISTORY_ENTRY,
} from '@features/change-review-history/contracts';
import {
  registerReviewDraftHistoryIpc,
  removeReviewDraftHistoryIpc,
} from '@features/change-review-history/main';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ReviewDraftHistoryApplication } from '@features/change-review-history/core/application/ReviewDraftHistoryApplication';
import type { ReviewDraftHistoryIpcHandlerWrapper } from '@features/change-review-history/main';

type Handler = (...args: unknown[]) => unknown;

describe('change review draft-history IPC', () => {
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
  const wrapHandler: ReviewDraftHistoryIpcHandlerWrapper = async (label, operation) => {
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
    resolveConflictCandidate: vi.fn(async () => null),
    replaceConflictCandidate: vi.fn(async () => ({
      id: 'candidate',
      capturedAt: '2026-07-23T10:00:00.000Z',
      origin: 'current-snapshot' as const,
      recoverability: 'recoverable' as const,
      filePath: '/repo/file.ts',
      expectedRevision: 0,
      expectedGeneration: null,
      observedCurrentRevision: 0,
      observedCurrentGeneration: null,
      entryRevision: 1,
    })),
    saveEntry: vi.fn(async () => ({
      filePath: '/repo/file.ts',
      codec: 'codemirror-history-v1' as const,
      revision: 1,
      generation: 'generation',
      diskBaseline: null,
      editorState: { doc: '', history: { done: [], undone: [] } },
      updatedAt: '2026-07-23T10:00:00.000Z',
    })),
    clear: vi.fn(async () => undefined),
  } as unknown as ReviewDraftHistoryApplication;

  beforeEach(() => {
    handlers.clear();
    wrapperLabels.length = 0;
    vi.clearAllMocks();
    registerReviewDraftHistoryIpc(ipcMain as never, application, wrapHandler);
  });

  it('owns and removes the six stable draft-history channels', () => {
    expect(REVIEW_DRAFT_HISTORY_IPC_CHANNELS).toEqual([
      'review:loadDraftHistory',
      'review:loadDraftHistoryConflictCandidates',
      'review:resolveDraftHistoryConflictCandidate',
      'review:replaceDraftHistoryConflictCandidate',
      'review:saveDraftHistoryEntry',
      'review:clearDraftHistory',
    ]);
    expect([...handlers.keys()]).toEqual(REVIEW_DRAFT_HISTORY_IPC_CHANNELS);

    removeReviewDraftHistoryIpc(ipcMain as never);

    expect(ipcMain.removeHandler.mock.calls.map(([channel]) => channel)).toEqual(
      REVIEW_DRAFT_HISTORY_IPC_CHANNELS
    );
    expect(handlers.size).toBe(0);
  });

  it('preserves positional IPC arguments and the review success envelope', async () => {
    await expect(
      handlers.get(REVIEW_LOAD_DRAFT_HISTORY)!({}, 'safe-team', 'agent-worker', 'scope-token')
    ).resolves.toEqual({ success: true, data: null });
    expect(application.load).toHaveBeenCalledWith('safe-team', 'agent-worker', 'scope-token');
    expect(wrapperLabels).toEqual(['loadDraftHistory']);
  });

  it('uses the exact legacy error-boundary label for every operation', async () => {
    const draftEntry = {
      filePath: '/repo/file.ts',
      codec: 'codemirror-history-v1',
      revision: 1,
      diskBaseline: null,
      editorState: { doc: '', history: { done: [], undone: [] } },
    };
    await handlers.get(REVIEW_LOAD_DRAFT_HISTORY)!({}, 'team', 'agent-worker', 'scope');
    await handlers.get(REVIEW_LOAD_DRAFT_HISTORY_CONFLICT_CANDIDATES)!(
      {},
      'team',
      'agent-worker',
      'scope'
    );
    await handlers.get(REVIEW_RESOLVE_DRAFT_HISTORY_CONFLICT_CANDIDATE)!(
      {},
      'team',
      'agent-worker',
      'scope',
      'candidate',
      'keep-current',
      1,
      'generation'
    );
    await handlers.get(REVIEW_REPLACE_DRAFT_HISTORY_CONFLICT_CANDIDATE)!(
      {},
      'team',
      'agent-worker',
      'scope',
      draftEntry,
      { ...draftEntry, revision: 2 },
      1,
      'generation'
    );
    await handlers.get(REVIEW_SAVE_DRAFT_HISTORY_ENTRY)!(
      {},
      'team',
      'agent-worker',
      'scope',
      draftEntry,
      0,
      null
    );
    await handlers.get(REVIEW_CLEAR_DRAFT_HISTORY)!(
      {},
      'team',
      'agent-worker',
      'scope',
      null,
      null,
      null
    );

    expect(wrapperLabels).toEqual([
      'loadDraftHistory',
      'loadDraftHistoryConflictCandidates',
      'resolveDraftHistoryConflictCandidate',
      'replaceDraftHistoryConflictCandidate',
      'saveDraftHistoryEntry',
      'clearDraftHistory',
    ]);
  });

  it('preserves the review error envelope', async () => {
    vi.mocked(application.load).mockRejectedValueOnce(new Error('draft read failed'));

    await expect(
      handlers.get(REVIEW_LOAD_DRAFT_HISTORY)!({}, 'safe-team', 'agent-worker', 'scope-token')
    ).resolves.toEqual({ success: false, error: 'draft read failed' });
    expect(wrapperLabels).toEqual(['loadDraftHistory']);
  });
});
