import { beforeEach, describe, expect, it, vi } from 'vitest';
import { create } from 'zustand';

import { createChangeReviewSlice } from '../../../src/renderer/store/slices/changeReviewSlice';
import { buildTaskChangePresenceKey } from '../../../src/renderer/utils/taskChangeRequest';

import type { ReviewRedoAction } from '@shared/types';

const hoisted = vi.hoisted(() => ({
  getTaskChanges: vi.fn(),
  getAgentChanges: vi.fn(),
  getChangeStats: vi.fn(),
  getFileContent: vi.fn(),
  applyDecisions: vi.fn(),
  saveEditedFile: vi.fn(),
  loadDecisions: vi.fn(),
  saveDecisions: vi.fn(),
  clearDecisions: vi.fn(),
  checkConflict: vi.fn(),
  rejectHunks: vi.fn(),
  rejectFile: vi.fn(),
  previewReject: vi.fn(),
  capturePostHogEvent: vi.fn(),
}));

vi.mock('@renderer/api', () => ({
  api: {
    review: {
      getTaskChanges: hoisted.getTaskChanges,
      getAgentChanges: hoisted.getAgentChanges,
      getChangeStats: hoisted.getChangeStats,
      getFileContent: hoisted.getFileContent,
      applyDecisions: hoisted.applyDecisions,
      saveEditedFile: hoisted.saveEditedFile,
      loadDecisions: hoisted.loadDecisions,
      saveDecisions: hoisted.saveDecisions,
      clearDecisions: hoisted.clearDecisions,
      checkConflict: hoisted.checkConflict,
      rejectHunks: hoisted.rejectHunks,
      rejectFile: hoisted.rejectFile,
      previewReject: hoisted.previewReject,
    },
  },
}));

vi.mock('@renderer/posthog', () => ({
  capturePostHogEvent: hoisted.capturePostHogEvent,
}));

function createSliceStore() {
  // The slice tests intentionally build partial AppState fixtures around this isolated slice.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return create<any>()((set, get, store) => ({
    ...createChangeReviewSlice(set as never, get as never, store as never),
    setSelectedTeamTaskChangePresence: vi.fn(),
  }));
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function flushAsyncWork(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

const AGENT_REVIEW_SCOPE = { teamName: 'team-a', memberName: 'alice' };
const TASK_A_REVIEW_SCOPE = { teamName: 'team-a', taskId: 'task-a' };

function makeSnippet(
  overrides: Partial<{
    toolUseId: string;
    filePath: string;
    toolName: string;
    type: 'edit' | 'multi-edit' | 'write-new' | 'write-update';
    oldString: string;
    newString: string;
    replaceAll: boolean;
    timestamp: string;
    isError: boolean;
    contextHash: string;
  }> = {}
) {
  return {
    toolUseId: 'tool-1',
    filePath: '/repo/file.ts',
    toolName: 'Edit',
    type: 'edit' as const,
    oldString: 'before',
    newString: 'after',
    replaceAll: false,
    timestamp: '2026-03-01T10:00:00.000Z',
    isError: false,
    ...overrides,
  };
}

function makeFile(filePath = '/repo/file.ts', snippetOverrides = {}) {
  return {
    filePath,
    relativePath: filePath.split('/').pop() ?? 'file.ts',
    snippets: [makeSnippet({ filePath, ...snippetOverrides })],
    linesAdded: 1,
    linesRemoved: 1,
    isNewFile: false,
  };
}

function makeAgentChangeSet(filePath = '/repo/file.ts', snippetOverrides = {}) {
  const file = makeFile(filePath, snippetOverrides);
  return {
    memberName: 'alice',
    teamName: 'team-a',
    files: [file],
    totalFiles: 1,
    totalLinesAdded: file.linesAdded,
    totalLinesRemoved: file.linesRemoved,
  };
}

function makeTaskChangeSet(taskId = 'task-1', filePath = '/repo/file.ts', snippetOverrides = {}) {
  const file = makeFile(filePath, snippetOverrides);
  return {
    teamName: 'team-a',
    taskId,
    files: [file],
    totalFiles: 1,
    totalLinesAdded: file.linesAdded,
    totalLinesRemoved: file.linesRemoved,
    confidence: 'fallback',
    computedAt: '2026-03-01T12:00:00.000Z',
    scope: {
      taskId,
      memberName: 'alice',
      startLine: 0,
      endLine: 0,
      startTimestamp: '',
      endTimestamp: '',
      toolUseIds: [],
      filePaths: [filePath],
      confidence: { tier: 4, label: 'fallback', reason: 'test fixture' },
    },
    warnings: [],
  };
}

const OPTIONS_A = {
  owner: 'alice',
  status: 'completed',
  intervals: [{ startedAt: '2026-03-01T10:00:00.000Z' }],
  since: '2026-03-01T09:58:00.000Z',
  stateBucket: 'completed' as const,
};

const OPTIONS_B = {
  owner: 'bob',
  status: 'completed',
  intervals: [{ startedAt: '2026-03-01T11:00:00.000Z' }],
  since: '2026-03-01T10:58:00.000Z',
  stateBucket: 'completed' as const,
};

const REVIEW_OPTIONS = {
  owner: 'alice',
  status: 'completed',
  intervals: [{ startedAt: '2026-03-01T10:00:00.000Z' }],
  since: '2026-03-01T09:58:00.000Z',
  stateBucket: 'review' as const,
};

describe('changeReviewSlice task changes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hoisted.capturePostHogEvent.mockClear();
    hoisted.saveDecisions.mockImplementation((...args: unknown[]) =>
      Promise.resolve({ revision: (typeof args[7] === 'number' ? args[7] : 0) + 1 })
    );
    hoisted.clearDecisions.mockImplementation((...args: unknown[]) =>
      Promise.resolve({ revision: (typeof args[3] === 'number' ? args[3] : 0) + 1 })
    );
  });

  it('does not cache errors as negative task-change results', async () => {
    const store = createSliceStore();
    hoisted.getTaskChanges.mockRejectedValue(new Error('transient'));

    await store.getState().checkTaskHasChanges('team-a', '1', OPTIONS_A);
    await store.getState().checkTaskHasChanges('team-a', '1', OPTIONS_A);

    expect(hoisted.getTaskChanges).toHaveBeenCalledTimes(2);
  });

  it('negative-caches confirmed empty results per request signature', async () => {
    const store = createSliceStore();
    hoisted.getTaskChanges.mockResolvedValue({
      files: [],
      totalFiles: 0,
      totalLinesAdded: 0,
      totalLinesRemoved: 0,
      teamName: 'team-a',
      taskId: '1',
      confidence: 'high',
      computedAt: '2026-03-01T12:00:00.000Z',
      scope: {
        taskId: '1',
        memberName: '',
        startLine: 0,
        endLine: 0,
        startTimestamp: '',
        endTimestamp: '',
        toolUseIds: [],
        filePaths: [],
        confidence: { tier: 1, label: 'high', reason: 'Confirmed empty summary' },
      },
      warnings: [],
    });

    await store.getState().checkTaskHasChanges('team-a', '1', OPTIONS_A);
    await store.getState().checkTaskHasChanges('team-a', '1', OPTIONS_A);
    await store.getState().checkTaskHasChanges('team-a', '1', OPTIONS_B);

    expect(hoisted.getTaskChanges).toHaveBeenCalledTimes(2);
    expect(
      store.getState().taskChangePresenceByKey[buildTaskChangePresenceKey('team-a', '1', OPTIONS_A)]
    ).toBe('no_changes');
  });

  it('records task change presence entries in one batch', () => {
    const store = createSliceStore();
    const keyA = buildTaskChangePresenceKey('team-a', 'task-a', OPTIONS_A);
    const keyB = buildTaskChangePresenceKey('team-a', 'task-b', OPTIONS_B);

    store.getState().recordTaskChangePresences([
      { teamName: 'team-a', taskId: 'task-a', options: OPTIONS_A, presence: 'has_changes' },
      { teamName: 'team-a', taskId: 'task-b', options: OPTIONS_B, presence: 'no_changes' },
    ]);

    expect(store.getState().taskChangePresenceByKey[keyA]).toBe('has_changes');
    expect(store.getState().taskChangePresenceByKey[keyB]).toBe('no_changes');

    store
      .getState()
      .recordTaskChangePresences([
        { teamName: 'team-a', taskId: 'task-a', options: OPTIONS_A, presence: 'unknown' },
      ]);

    expect(store.getState().taskChangePresenceByKey[keyA]).toBeUndefined();
    expect(store.getState().taskChangePresenceByKey[keyB]).toBe('no_changes');
  });

  it('updates selected team task changePresence after a positive summary check', async () => {
    const store = createSliceStore();
    hoisted.getTaskChanges.mockResolvedValue(makeTaskChangeSet('presence-hit'));

    await store.getState().checkTaskHasChanges('team-a', 'presence-hit', OPTIONS_A);

    expect(store.getState().setSelectedTeamTaskChangePresence).toHaveBeenCalledWith(
      'team-a',
      'presence-hit',
      'has_changes'
    );
  });

  it('updates selected team task changePresence to no_changes only for confirmed empty summaries', async () => {
    const store = createSliceStore();
    hoisted.getTaskChanges.mockResolvedValue({
      files: [],
      totalFiles: 0,
      totalLinesAdded: 0,
      totalLinesRemoved: 0,
      teamName: 'team-a',
      taskId: 'presence-empty',
      confidence: 'high',
      computedAt: '2026-03-01T12:00:00.000Z',
      scope: {
        taskId: 'presence-empty',
        memberName: '',
        startLine: 0,
        endLine: 0,
        startTimestamp: '',
        endTimestamp: '',
        toolUseIds: [],
        filePaths: [],
        confidence: { tier: 1, label: 'high', reason: 'test fixture' },
      },
      warnings: [],
    });

    await store.getState().checkTaskHasChanges('team-a', 'presence-empty', OPTIONS_A);

    expect(store.getState().setSelectedTeamTaskChangePresence).toHaveBeenCalledWith(
      'team-a',
      'presence-empty',
      'no_changes'
    );
  });

  it('keeps changePresence unknown for fallback empty summaries', async () => {
    const store = createSliceStore();
    hoisted.getTaskChanges.mockResolvedValue({
      files: [],
      totalFiles: 0,
      totalLinesAdded: 0,
      totalLinesRemoved: 0,
      teamName: 'team-a',
      taskId: 'presence-unknown',
      confidence: 'fallback',
      computedAt: '2026-03-01T12:00:00.000Z',
      scope: {
        taskId: 'presence-unknown',
        memberName: '',
        startLine: 0,
        endLine: 0,
        startTimestamp: '',
        endTimestamp: '',
        toolUseIds: [],
        filePaths: [],
        confidence: { tier: 4, label: 'fallback', reason: 'test fixture' },
      },
      warnings: [],
    });

    await store.getState().checkTaskHasChanges('team-a', 'presence-unknown', OPTIONS_A);

    expect(store.getState().setSelectedTeamTaskChangePresence).not.toHaveBeenCalledWith(
      'team-a',
      'presence-unknown',
      'no_changes'
    );
  });

  it('treats diagnostic-only multi-scope summaries as unknown and rechecks after invalidation', async () => {
    const store = createSliceStore();
    const teamName = 'team-a';
    const taskId = 'presence-warning';
    const cacheKey = buildTaskChangePresenceKey(teamName, taskId, OPTIONS_A);
    hoisted.getTaskChanges.mockResolvedValue({
      files: [],
      totalFiles: 0,
      totalLinesAdded: 0,
      totalLinesRemoved: 0,
      teamName,
      taskId,
      confidence: 'fallback',
      computedAt: '2026-03-01T12:00:00.000Z',
      scope: {
        taskId,
        memberName: '',
        startLine: 0,
        endLine: 0,
        startTimestamp: '',
        endTimestamp: '',
        toolUseIds: [],
        filePaths: [],
        confidence: { tier: 4, label: 'fallback', reason: 'Ambiguous scope skipped' },
      },
      warnings: ['Ledger skipped attribution because multiple task scopes were active.'],
      provenance: {
        sourceKind: 'ledger',
        sourceFingerprint: 'ledger-warning-only',
      },
    });

    await store.getState().checkTaskHasChanges(teamName, taskId, OPTIONS_A);

    expect(store.getState().setSelectedTeamTaskChangePresence).not.toHaveBeenCalledWith(
      teamName,
      taskId,
      'needs_attention'
    );
    expect(store.getState().taskChangePresenceByKey[cacheKey]).toBeUndefined();

    store.getState().invalidateTaskChangePresence([cacheKey]);
    await store.getState().checkTaskHasChanges(teamName, taskId, OPTIONS_A);

    expect(hoisted.getTaskChanges).toHaveBeenCalledTimes(2);
  });

  it('treats unclassified warning-only summaries as needs_attention', async () => {
    const store = createSliceStore();
    const teamName = 'team-a';
    const taskId = 'presence-unclassified-warning';
    const cacheKey = buildTaskChangePresenceKey(teamName, taskId, OPTIONS_A);
    hoisted.getTaskChanges.mockResolvedValue({
      files: [],
      totalFiles: 0,
      totalLinesAdded: 0,
      totalLinesRemoved: 0,
      teamName,
      taskId,
      confidence: 'fallback',
      computedAt: '2026-03-01T12:00:00.000Z',
      scope: {
        taskId,
        memberName: '',
        startLine: 0,
        endLine: 0,
        startTimestamp: '',
        endTimestamp: '',
        toolUseIds: [],
        filePaths: [],
        confidence: { tier: 4, label: 'fallback', reason: 'Unknown warning' },
      },
      warnings: ['Unexpected ledger warning.'],
      provenance: {
        sourceKind: 'ledger',
        sourceFingerprint: 'ledger-warning-only',
      },
    });

    await store.getState().checkTaskHasChanges(teamName, taskId, OPTIONS_A);

    expect(store.getState().setSelectedTeamTaskChangePresence).toHaveBeenCalledWith(
      teamName,
      taskId,
      'needs_attention'
    );
    expect(store.getState().taskChangePresenceByKey[cacheKey]).toBe('needs_attention');
  });

  it('background revalidates cached needs_attention presence', async () => {
    const store = createSliceStore();
    const teamName = 'team-a';
    const taskId = 'cached-needs-attention';
    const cacheKey = buildTaskChangePresenceKey(teamName, taskId, OPTIONS_A);
    store.setState({
      selectedTeamName: teamName,
      selectedTeamData: {
        tasks: [{ id: taskId, changePresence: 'needs_attention' }],
      },
      taskChangePresenceByKey: { [cacheKey]: 'needs_attention' },
    });
    hoisted.getTaskChanges.mockResolvedValue({
      teamName,
      taskId,
      files: [],
      totalFiles: 0,
      totalLinesAdded: 0,
      totalLinesRemoved: 0,
      confidence: 'fallback',
      computedAt: '2026-03-01T12:00:00.000Z',
      scope: {
        taskId,
        memberName: '',
        startLine: 0,
        endLine: 0,
        startTimestamp: '',
        endTimestamp: '',
        toolUseIds: [],
        filePaths: [],
        confidence: { tier: 4, label: 'fallback', reason: 'Multi-scope notice only' },
      },
      warnings: [
        'Task change ledger skipped attribution because multiple task scopes were active.',
      ],
    });

    await store.getState().checkTaskHasChanges(teamName, taskId, OPTIONS_A);
    await flushAsyncWork();

    expect(hoisted.getTaskChanges).toHaveBeenCalledWith(teamName, taskId, {
      ...OPTIONS_A,
      summaryOnly: true,
      forceFresh: true,
    });
    expect(store.getState().taskChangePresenceByKey[cacheKey]).toBeUndefined();
    expect(store.getState().setSelectedTeamTaskChangePresence).toHaveBeenCalledWith(
      teamName,
      taskId,
      'needs_attention'
    );
    expect(store.getState().setSelectedTeamTaskChangePresence).toHaveBeenCalledWith(
      teamName,
      taskId,
      'unknown'
    );
  });

  it('does not raise needs_attention for active interval summaries with no observed file edits yet', async () => {
    const store = createSliceStore();
    const teamName = 'team-a';
    const taskId = 'presence-active-no-edits';
    const cacheKey = buildTaskChangePresenceKey(teamName, taskId, OPTIONS_A);
    hoisted.getTaskChanges.mockResolvedValue({
      files: [],
      totalFiles: 0,
      totalLinesAdded: 0,
      totalLinesRemoved: 0,
      teamName,
      taskId,
      confidence: 'medium',
      computedAt: '2026-03-01T12:00:00.000Z',
      scope: {
        taskId,
        memberName: 'echo',
        startLine: 0,
        endLine: 0,
        startTimestamp: '2026-03-01T12:00:00.000Z',
        endTimestamp: '',
        toolUseIds: [],
        filePaths: [],
        confidence: {
          tier: 2,
          label: 'medium',
          reason: 'Scoped by persisted task workIntervals (timestamp-based)',
        },
      },
      warnings: ['No file edits found within persisted workIntervals.'],
    });

    await store.getState().checkTaskHasChanges(teamName, taskId, OPTIONS_A);

    expect(store.getState().setSelectedTeamTaskChangePresence).not.toHaveBeenCalledWith(
      teamName,
      taskId,
      'needs_attention'
    );
    expect(store.getState().taskChangePresenceByKey[cacheKey]).toBeUndefined();
  });

  it('downgrades stale known presence to unknown for fallback empty summaries', async () => {
    const store = createSliceStore();
    store.setState({
      selectedTeamName: 'team-a',
      selectedTeamData: {
        tasks: [{ id: 'presence-stale', changePresence: 'has_changes' }],
      },
    });
    hoisted.getTaskChanges.mockResolvedValue({
      files: [],
      totalFiles: 0,
      totalLinesAdded: 0,
      totalLinesRemoved: 0,
      teamName: 'team-a',
      taskId: 'presence-stale',
      confidence: 'fallback',
      computedAt: '2026-03-01T12:00:00.000Z',
      scope: {
        taskId: 'presence-stale',
        memberName: '',
        startLine: 0,
        endLine: 0,
        startTimestamp: '',
        endTimestamp: '',
        toolUseIds: [],
        filePaths: [],
        confidence: { tier: 4, label: 'fallback', reason: 'test fixture' },
      },
      warnings: [],
    });

    await store.getState().checkTaskHasChanges('team-a', 'presence-stale', OPTIONS_A);

    expect(store.getState().setSelectedTeamTaskChangePresence).toHaveBeenCalledWith(
      'team-a',
      'presence-stale',
      'unknown'
    );
  });

  it('bypasses stale negative cache when selected team task presence is unknown', async () => {
    const store = createSliceStore();
    hoisted.getTaskChanges.mockResolvedValue({
      files: [],
      totalFiles: 0,
      totalLinesAdded: 0,
      totalLinesRemoved: 0,
      teamName: 'team-a',
      taskId: 'presence-bypass',
      confidence: 'fallback',
      computedAt: '2026-03-01T12:00:00.000Z',
      scope: {
        taskId: 'presence-bypass',
        memberName: '',
        startLine: 0,
        endLine: 0,
        startTimestamp: '',
        endTimestamp: '',
        toolUseIds: [],
        filePaths: [],
        confidence: { tier: 4, label: 'fallback', reason: 'test fixture' },
      },
      warnings: [],
    });

    await store.getState().checkTaskHasChanges('team-a', 'presence-bypass', OPTIONS_A);
    store.setState({
      selectedTeamName: 'team-a',
      selectedTeamData: {
        tasks: [{ id: 'presence-bypass', changePresence: 'unknown' }],
      },
    });
    await store.getState().checkTaskHasChanges('team-a', 'presence-bypass', OPTIONS_A);

    expect(hoisted.getTaskChanges).toHaveBeenCalledTimes(2);
  });

  it('ignores stale fetchTaskChanges responses when a newer task request wins', async () => {
    const store = createSliceStore();
    const first = deferred<unknown>();
    const second = deferred<unknown>();
    hoisted.getTaskChanges.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);

    const firstFetch = store.getState().fetchTaskChanges('team-a', '1', OPTIONS_A);
    const secondFetch = store.getState().fetchTaskChanges('team-a', '2', OPTIONS_B);

    second.resolve({
      teamName: 'team-a',
      taskId: '2',
      files: [
        {
          filePath: '/repo/new.ts',
          relativePath: 'new.ts',
          snippets: [],
          linesAdded: 1,
          linesRemoved: 0,
          isNewFile: true,
        },
      ],
      totalFiles: 1,
      totalLinesAdded: 1,
      totalLinesRemoved: 0,
      confidence: 'fallback',
      computedAt: '2026-03-01T12:00:00.000Z',
      scope: {
        taskId: '2',
        memberName: 'bob',
        startLine: 0,
        endLine: 0,
        startTimestamp: '',
        endTimestamp: '',
        toolUseIds: [],
        filePaths: ['/repo/new.ts'],
        confidence: { tier: 4, label: 'fallback', reason: 'No task boundaries found in JSONL' },
      },
      warnings: [],
    });
    await secondFetch;

    first.resolve({
      teamName: 'team-a',
      taskId: '1',
      files: [
        {
          filePath: '/repo/old.ts',
          relativePath: 'old.ts',
          snippets: [],
          linesAdded: 1,
          linesRemoved: 0,
          isNewFile: true,
        },
      ],
      totalFiles: 1,
      totalLinesAdded: 1,
      totalLinesRemoved: 0,
      confidence: 'fallback',
      computedAt: '2026-03-01T12:00:00.000Z',
      scope: {
        taskId: '1',
        memberName: 'alice',
        startLine: 0,
        endLine: 0,
        startTimestamp: '',
        endTimestamp: '',
        toolUseIds: [],
        filePaths: ['/repo/old.ts'],
        confidence: { tier: 4, label: 'fallback', reason: 'No task boundaries found in JSONL' },
      },
      warnings: [],
    });
    await firstFetch;

    expect(store.getState().activeChangeSet?.taskId).toBe('2');
    expect(store.getState().selectedReviewFilePath).toBe('/repo/new.ts');
  });

  it('does not treat review-state summaries as permanently cacheable', async () => {
    const store = createSliceStore();
    hoisted.getTaskChanges.mockResolvedValue({
      files: [],
      totalFiles: 0,
      totalLinesAdded: 0,
      totalLinesRemoved: 0,
      teamName: 'team-a',
      taskId: '1',
      confidence: 'fallback',
      computedAt: '2026-03-01T12:00:00.000Z',
      scope: {
        taskId: '1',
        memberName: '',
        startLine: 0,
        endLine: 0,
        startTimestamp: '',
        endTimestamp: '',
        toolUseIds: [],
        filePaths: [],
        confidence: { tier: 4, label: 'fallback', reason: 'No log files found for task' },
      },
      warnings: [],
    });

    await store.getState().checkTaskHasChanges('team-a', '1', REVIEW_OPTIONS);
    // Expire the 30s negative-cache TTL so the second call actually hits the API
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 31_000);
    await store.getState().checkTaskHasChanges('team-a', '1', REVIEW_OPTIONS);
    vi.mocked(Date.now).mockRestore();

    expect(hoisted.getTaskChanges).toHaveBeenCalledTimes(2);
  });

  it('re-warms terminal summaries after an earlier empty result', async () => {
    const store = createSliceStore();
    const teamName = 'team-warm';
    const taskId = 'late-log-task';
    hoisted.getTaskChanges
      .mockResolvedValueOnce({
        files: [],
        totalFiles: 0,
        totalLinesAdded: 0,
        totalLinesRemoved: 0,
        teamName,
        taskId,
        confidence: 'fallback',
        computedAt: '2026-03-01T12:00:00.000Z',
        scope: {
          taskId: '1',
          memberName: '',
          startLine: 0,
          endLine: 0,
          startTimestamp: '',
          endTimestamp: '',
          toolUseIds: [],
          filePaths: [],
          confidence: { tier: 4, label: 'fallback', reason: 'No log files found for task' },
        },
        warnings: [],
      })
      .mockResolvedValueOnce({
        teamName,
        taskId,
        files: [
          {
            filePath: '/repo/new.ts',
            relativePath: 'new.ts',
            snippets: [],
            linesAdded: 1,
            linesRemoved: 0,
            isNewFile: true,
          },
        ],
        totalFiles: 1,
        totalLinesAdded: 1,
        totalLinesRemoved: 0,
        confidence: 'fallback',
        computedAt: '2026-03-01T12:01:00.000Z',
        scope: {
          taskId: '1',
          memberName: 'alice',
          startLine: 0,
          endLine: 0,
          startTimestamp: '',
          endTimestamp: '',
          toolUseIds: [],
          filePaths: ['/repo/new.ts'],
          confidence: { tier: 4, label: 'fallback', reason: 'No task boundaries found in JSONL' },
        },
        warnings: [],
      })
      .mockResolvedValueOnce({
        teamName,
        taskId,
        files: [
          {
            filePath: '/repo/new.ts',
            relativePath: 'new.ts',
            snippets: [],
            linesAdded: 1,
            linesRemoved: 0,
            isNewFile: true,
          },
        ],
        totalFiles: 1,
        totalLinesAdded: 1,
        totalLinesRemoved: 0,
        confidence: 'fallback',
        computedAt: '2026-03-01T12:01:01.000Z',
        scope: {
          taskId: '1',
          memberName: 'alice',
          startLine: 0,
          endLine: 0,
          startTimestamp: '',
          endTimestamp: '',
          toolUseIds: [],
          filePaths: ['/repo/new.ts'],
          confidence: { tier: 4, label: 'fallback', reason: 'No task boundaries found in JSONL' },
        },
        warnings: [],
      });

    await store.getState().checkTaskHasChanges(teamName, taskId, OPTIONS_A);
    await store.getState().warmTaskChangeSummaries([{ teamName, taskId, options: OPTIONS_A }]);

    expect(hoisted.getTaskChanges).toHaveBeenCalledTimes(3);
    expect(
      store.getState().taskChangePresenceByKey[
        buildTaskChangePresenceKey(teamName, taskId, OPTIONS_A)
      ]
    ).toBe('has_changes');
  });

  it('warms task summaries with bounded concurrency', async () => {
    const store = createSliceStore();
    const pending = Array.from({ length: 6 }, () => deferred<unknown>());
    let callIndex = 0;
    hoisted.getTaskChanges.mockImplementation(() => pending[callIndex++].promise);

    const requests = Array.from({ length: 6 }, (_, index) => ({
      teamName: 'team-a',
      taskId: `task-${index}`,
      options: {
        owner: 'alice',
        status: 'completed',
        intervals: [{ startedAt: `2026-03-01T1${index}:00:00.000Z` }],
        since: `2026-03-01T0${index}:58:00.000Z`,
        stateBucket: 'completed' as const,
      },
    }));

    const warmPromise = store.getState().warmTaskChangeSummaries(requests);
    await flushAsyncWork();

    expect(hoisted.getTaskChanges).toHaveBeenCalledTimes(4);

    for (let index = 0; index < 4; index++) {
      pending[index].resolve({
        teamName: 'team-a',
        taskId: `task-${index}`,
        files: [],
        totalFiles: 0,
        totalLinesAdded: 0,
        totalLinesRemoved: 0,
        confidence: 'fallback',
        computedAt: '2026-12-01T12:00:00.000Z',
        scope: {
          taskId: `task-${index}`,
          memberName: '',
          startLine: 0,
          endLine: 0,
          startTimestamp: '',
          endTimestamp: '',
          toolUseIds: [],
          filePaths: [],
          confidence: { tier: 4, label: 'fallback', reason: 'No log files found for task' },
        },
        warnings: [],
      });
    }
    await flushAsyncWork();

    expect(hoisted.getTaskChanges).toHaveBeenCalledTimes(6);

    for (let index = 4; index < 6; index++) {
      pending[index].resolve({
        teamName: 'team-a',
        taskId: `task-${index}`,
        files: [],
        totalFiles: 0,
        totalLinesAdded: 0,
        totalLinesRemoved: 0,
        confidence: 'fallback',
        computedAt: '2026-12-01T12:00:00.000Z',
        scope: {
          taskId: `task-${index}`,
          memberName: '',
          startLine: 0,
          endLine: 0,
          startTimestamp: '',
          endTimestamp: '',
          toolUseIds: [],
          filePaths: [],
          confidence: { tier: 4, label: 'fallback', reason: 'No log files found for task' },
        },
        warnings: [],
      });
    }

    await warmPromise;
  });

  it('clears stale no_changes warm cache entries for diagnostic-only summaries', async () => {
    const store = createSliceStore();
    const teamName = 'team-a';
    const taskId = 'warm-diagnostic-only';
    const cacheKey = buildTaskChangePresenceKey(teamName, taskId, OPTIONS_A);
    store.setState({ taskChangePresenceByKey: { [cacheKey]: 'no_changes' } });
    hoisted.getTaskChanges.mockResolvedValue({
      teamName,
      taskId,
      files: [],
      totalFiles: 0,
      totalLinesAdded: 0,
      totalLinesRemoved: 0,
      confidence: 'fallback',
      computedAt: '2026-03-01T12:00:00.000Z',
      scope: {
        taskId,
        memberName: '',
        startLine: 0,
        endLine: 0,
        startTimestamp: '',
        endTimestamp: '',
        toolUseIds: [],
        filePaths: [],
        confidence: { tier: 4, label: 'fallback', reason: 'Multi-scope notice only' },
      },
      warnings: [
        'Task change ledger skipped attribution because multiple task scopes were active.',
      ],
    });

    await store.getState().warmTaskChangeSummaries([{ teamName, taskId, options: OPTIONS_A }]);

    expect(store.getState().taskChangePresenceByKey[cacheKey]).toBeUndefined();
  });

  it('clears optimistic terminal presence after background forceFresh revalidation', async () => {
    const store = createSliceStore();
    const teamName = 'team-revalidate';
    const taskId = 'persisted-hit';
    hoisted.getTaskChanges
      .mockResolvedValueOnce({
        teamName,
        taskId,
        files: [
          {
            filePath: '/repo/persisted.ts',
            relativePath: 'persisted.ts',
            snippets: [],
            linesAdded: 1,
            linesRemoved: 0,
            isNewFile: true,
          },
        ],
        totalFiles: 1,
        totalLinesAdded: 1,
        totalLinesRemoved: 0,
        confidence: 'medium',
        computedAt: '2026-03-01T12:00:00.000Z',
        scope: {
          taskId: '1',
          memberName: 'alice',
          startLine: 0,
          endLine: 0,
          startTimestamp: '',
          endTimestamp: '',
          toolUseIds: [],
          filePaths: ['/repo/persisted.ts'],
          confidence: { tier: 2, label: 'medium', reason: 'Persisted summary' },
        },
        warnings: [],
      })
      .mockResolvedValueOnce({
        teamName,
        taskId,
        files: [],
        totalFiles: 0,
        totalLinesAdded: 0,
        totalLinesRemoved: 0,
        confidence: 'fallback',
        computedAt: '2026-03-01T12:01:00.000Z',
        scope: {
          taskId: '1',
          memberName: '',
          startLine: 0,
          endLine: 0,
          startTimestamp: '',
          endTimestamp: '',
          toolUseIds: [],
          filePaths: [],
          confidence: { tier: 4, label: 'fallback', reason: 'No log files found for task' },
        },
        warnings: [],
      });

    await store.getState().checkTaskHasChanges(teamName, taskId, OPTIONS_A);
    await flushAsyncWork();

    expect(hoisted.getTaskChanges).toHaveBeenNthCalledWith(1, teamName, taskId, {
      ...OPTIONS_A,
      summaryOnly: true,
    });
    expect(hoisted.getTaskChanges).toHaveBeenNthCalledWith(2, teamName, taskId, {
      ...OPTIONS_A,
      summaryOnly: true,
      forceFresh: true,
    });
    expect(
      store.getState().taskChangePresenceByKey[
        buildTaskChangePresenceKey(teamName, taskId, OPTIONS_A)
      ]
    ).toBeUndefined();
    expect(store.getState().setSelectedTeamTaskChangePresence).toHaveBeenCalledWith(
      teamName,
      taskId,
      'unknown'
    );
  });

  it('clears resolved file content state when fetchAgentChanges installs a new change set', async () => {
    const store = createSliceStore();
    const data = makeAgentChangeSet('/repo/new.ts');
    hoisted.getAgentChanges.mockResolvedValue(data);

    store.setState({
      hunkDecisions: { '/repo/file.ts:0': 'rejected' },
      fileContents: {
        '/repo/file.ts': {
          ...makeFile('/repo/file.ts'),
          originalFullContent: 'before',
          modifiedFullContent: 'after',
          contentSource: 'snippet-reconstruction',
        },
      },
      fileContentsLoading: { '/repo/file.ts': true },
      fileChunkCounts: { '/repo/file.ts': 3 },
      hunkContextHashesByFile: { '/repo/file.ts': { 0: 'ctx' } },
      changeSetEpoch: 4,
      fileContentVersionByPath: { '/repo/file.ts': 2 },
    });

    await store.getState().fetchAgentChanges('team-a', 'alice');

    expect(store.getState().activeChangeSet).toEqual(data);
    expect(store.getState().selectedReviewFilePath).toBe('/repo/new.ts');
    expect(store.getState().fileContents).toEqual({});
    expect(store.getState().fileContentsLoading).toEqual({});
    expect(store.getState().fileChunkCounts).toEqual({});
    expect(store.getState().hunkContextHashesByFile).toEqual({});
    expect(store.getState().hunkDecisions).toEqual({});
    expect(store.getState().changeSetEpoch).toBe(5);
    expect(store.getState().fileContentVersionByPath).toEqual({});
  });

  it('clears resolved file content state when fetchTaskChanges installs a new change set', async () => {
    const store = createSliceStore();
    const data = makeTaskChangeSet('task-2', '/repo/task.ts');
    hoisted.getTaskChanges.mockResolvedValue(data);

    store.setState({
      hunkDecisions: { '/repo/file.ts:0': 'accepted' },
      fileContents: {
        '/repo/file.ts': {
          ...makeFile('/repo/file.ts'),
          originalFullContent: 'before',
          modifiedFullContent: 'after',
          contentSource: 'snippet-reconstruction',
        },
      },
      fileContentsLoading: { '/repo/file.ts': true },
      fileChunkCounts: { '/repo/file.ts': 2 },
      hunkContextHashesByFile: { '/repo/file.ts': { 0: 'ctx' } },
      changeSetEpoch: 1,
      fileContentVersionByPath: { '/repo/file.ts': 7 },
    });

    await store.getState().fetchTaskChanges('team-a', 'task-2', OPTIONS_A);

    expect(store.getState().activeChangeSet).toEqual(data);
    expect(store.getState().activeTaskChangeRequestOptions).toEqual(OPTIONS_A);
    expect(store.getState().selectedReviewFilePath).toBe('/repo/task.ts');
    expect(store.getState().fileContents).toEqual({});
    expect(store.getState().fileContentsLoading).toEqual({});
    expect(store.getState().fileChunkCounts).toEqual({});
    expect(store.getState().hunkContextHashesByFile).toEqual({});
    expect(store.getState().hunkDecisions).toEqual({});
    expect(store.getState().changeSetEpoch).toBe(2);
    expect(store.getState().fileContentVersionByPath).toEqual({});
  });

  it('re-fetches visible file content after change-set replacement instead of silently reusing stale content', async () => {
    const store = createSliceStore();
    const refreshed = makeAgentChangeSet('/repo/file.ts', { newString: 'after-v2' });
    hoisted.getAgentChanges.mockResolvedValueOnce(refreshed);
    hoisted.getFileContent.mockResolvedValueOnce({
      ...makeFile('/repo/file.ts', { newString: 'after-v2' }),
      originalFullContent: 'before',
      modifiedFullContent: 'after-v2',
      contentSource: 'snippet-reconstruction',
    });

    store.setState({
      activeChangeSet: makeAgentChangeSet('/repo/file.ts'),
      fileContents: {
        '/repo/file.ts': {
          ...makeFile('/repo/file.ts'),
          originalFullContent: 'before',
          modifiedFullContent: 'after',
          contentSource: 'snippet-reconstruction',
        },
      },
      fileContentsLoading: {},
      changeSetEpoch: 0,
      fileContentVersionByPath: {},
    });

    await store.getState().fetchAgentChanges('team-a', 'alice');
    expect(store.getState().fileContents).toEqual({});

    await store.getState().fetchFileContent('team-a', 'alice', '/repo/file.ts');

    expect(hoisted.getFileContent).toHaveBeenCalledTimes(1);
    expect(hoisted.getFileContent).toHaveBeenCalledWith(
      'team-a',
      'alice',
      '/repo/file.ts',
      refreshed.files[0]?.snippets ?? []
    );
    expect(store.getState().fileContents['/repo/file.ts']?.modifiedFullContent).toBe('after-v2');
  });

  it('uses canonical relative Windows file paths when fetching content by slash/case variant', async () => {
    const store = createSliceStore();
    const filePath = 'SRC\\File.ts';
    const data = makeAgentChangeSet(filePath);
    hoisted.getFileContent.mockResolvedValueOnce({
      ...makeFile(filePath),
      originalFullContent: 'before',
      modifiedFullContent: 'after',
      contentSource: 'snippet-reconstruction',
    });

    store.setState({
      activeChangeSet: data,
      changeSetEpoch: 0,
      fileContentVersionByPath: {},
    });

    await store.getState().fetchFileContent('team-a', 'alice', 'src/file.ts');

    expect(hoisted.getFileContent).toHaveBeenCalledWith(
      'team-a',
      'alice',
      filePath,
      data.files[0]?.snippets ?? []
    );
    expect(store.getState().fileContents[filePath]?.modifiedFullContent).toBe('after');
    expect(store.getState().fileContents['src/file.ts']).toBeUndefined();
  });

  it('ignores stale fetchFileContent responses after change-set replacement', async () => {
    const store = createSliceStore();
    const pending = deferred<unknown>();
    hoisted.getFileContent.mockReturnValueOnce(pending.promise);
    hoisted.getAgentChanges.mockResolvedValueOnce(makeAgentChangeSet('/repo/next.ts'));

    store.setState({
      activeChangeSet: makeAgentChangeSet('/repo/file.ts'),
      hunkContextHashesByFile: { '/repo/file.ts': { 0: 'ctx' } },
      changeSetEpoch: 0,
      fileContentVersionByPath: {},
    });

    const fetchPromise = store.getState().fetchFileContent('team-a', 'alice', '/repo/file.ts');
    await flushAsyncWork();
    await store.getState().fetchAgentChanges('team-a', 'alice');

    pending.resolve({
      ...makeFile('/repo/file.ts'),
      originalFullContent: 'before',
      modifiedFullContent: 'after',
      contentSource: 'snippet-reconstruction',
    });
    await fetchPromise;
    await flushAsyncWork();

    expect(store.getState().selectedReviewFilePath).toBe('/repo/next.ts');
    expect(store.getState().fileContents).toEqual({});
    expect(store.getState().fileContentsLoading).toEqual({});
  });

  it('ignores stale fetchFileContent responses after per-file invalidation', async () => {
    const store = createSliceStore();
    const pending = deferred<unknown>();
    hoisted.getFileContent.mockReturnValueOnce(pending.promise);

    store.setState({
      activeChangeSet: makeAgentChangeSet('/repo/file.ts'),
      changeSetEpoch: 0,
      fileContentVersionByPath: {},
    });

    const fetchPromise = store.getState().fetchFileContent('team-a', 'alice', '/repo/file.ts');
    await flushAsyncWork();
    store.getState().clearReviewStateForFile('/repo/file.ts');

    pending.resolve({
      ...makeFile('/repo/file.ts'),
      originalFullContent: 'before',
      modifiedFullContent: 'after',
      contentSource: 'snippet-reconstruction',
    });
    await fetchPromise;
    await flushAsyncWork();

    expect(store.getState().fileContents).toEqual({});
    expect(store.getState().fileContentsLoading).toEqual({});
    expect(store.getState().hunkContextHashesByFile).toEqual({});
    expect(store.getState().fileContentVersionByPath['/repo/file.ts']).toBe(1);
  });

  it('normalizes persisted legacy file-path review decisions onto changeKey entries', async () => {
    const store = createSliceStore();
    const changeKey = 'rename:/repo/old.ts->/repo/new.ts';
    const ledgerFile = {
      ...makeFile('/repo/new.ts'),
      changeKey,
    };

    store.setState({
      activeChangeSet: {
        ...makeTaskChangeSet('task-ledger', '/repo/new.ts'),
        files: [ledgerFile],
        totalFiles: 1,
        totalLinesAdded: ledgerFile.linesAdded,
        totalLinesRemoved: ledgerFile.linesRemoved,
      },
    });

    hoisted.loadDecisions.mockResolvedValueOnce({
      hunkDecisions: { '/repo/new.ts:0': 'rejected' },
      fileDecisions: { '/repo/new.ts': 'rejected' },
      hunkContextHashesByFile: { '/repo/new.ts': { 0: 'ctx-rename' } },
    });

    await store.getState().loadDecisionsFromDisk('team-a', 'task-task-ledger', 'scope-token');

    expect(store.getState().hunkDecisions).toEqual({ [`${changeKey}:0`]: 'rejected' });
    expect(store.getState().fileDecisions).toEqual({ [changeKey]: 'rejected' });
    expect(store.getState().hunkContextHashesByFile).toEqual({
      [changeKey]: { 0: 'ctx-rename' },
    });
  });

  it('stores fresh decisions under changeKey for grouped ledger files', () => {
    const store = createSliceStore();
    const changeKey = 'rename:/repo/old.ts->/repo/new.ts';
    const ledgerFile = {
      ...makeFile('/repo/new.ts'),
      changeKey,
    };

    store.setState({
      activeChangeSet: {
        ...makeAgentChangeSet('/repo/new.ts'),
        files: [ledgerFile],
        totalFiles: 1,
        totalLinesAdded: ledgerFile.linesAdded,
        totalLinesRemoved: ledgerFile.linesRemoved,
      },
      fileChunkCounts: { '/repo/new.ts': 1 },
    });

    const originalIndex = store.getState().setHunkDecision('/repo/new.ts', 0, 'rejected');
    store.getState().setFileDecision('/repo/new.ts', 'rejected');

    expect(originalIndex).toBe(0);
    expect(store.getState().hunkDecisions).toEqual({ [`${changeKey}:0`]: 'rejected' });
    expect(store.getState().fileDecisions).toEqual({ [changeKey]: 'rejected' });
  });

  it('stores grouped copy decisions under the copy changeKey', () => {
    const store = createSliceStore();
    const changeKey = 'copy:/repo/base.ts->/repo/copy.ts';
    const ledgerFile = {
      ...makeFile('/repo/copy.ts'),
      changeKey,
    };

    store.setState({
      activeChangeSet: {
        ...makeAgentChangeSet('/repo/copy.ts'),
        files: [ledgerFile],
        totalFiles: 1,
        totalLinesAdded: ledgerFile.linesAdded,
        totalLinesRemoved: ledgerFile.linesRemoved,
      },
      fileChunkCounts: { '/repo/copy.ts': 1 },
    });

    const originalIndex = store.getState().setHunkDecision('/repo/copy.ts', 0, 'accepted');
    store.getState().setFileDecision('/repo/copy.ts', 'accepted');

    expect(originalIndex).toBe(0);
    expect(store.getState().hunkDecisions).toEqual({ [`${changeKey}:0`]: 'accepted' });
    expect(store.getState().fileDecisions).toEqual({ [changeKey]: 'accepted' });
  });

  it('invalidates resolved file content without clearing draft or review decisions', async () => {
    const store = createSliceStore();

    store.setState({
      activeChangeSet: makeAgentChangeSet('/repo/file.ts'),
      hunkDecisions: { '/repo/file.ts:0': 'rejected' },
      fileDecisions: { '/repo/file.ts': 'rejected' },
      fileChunkCounts: { '/repo/file.ts': 2 },
      hunkContextHashesByFile: { '/repo/file.ts': { 0: 'ctx' } },
      fileContents: {
        '/repo/file.ts': {
          ...makeFile('/repo/file.ts'),
          originalFullContent: 'before',
          modifiedFullContent: 'after',
          contentSource: 'snippet-reconstruction',
        },
      },
      fileContentsLoading: { '/repo/file.ts': true },
      editedContents: { '/repo/file.ts': 'draft' },
      reviewExternalChangesByFile: { '/repo/file.ts': { type: 'change' } },
      fileContentVersionByPath: {},
    });

    store.getState().invalidateResolvedFileContent('/repo/file.ts');

    expect(store.getState().fileContents).toEqual({});
    expect(store.getState().fileContentsLoading).toEqual({});
    expect(store.getState().fileChunkCounts).toEqual({});
    expect(store.getState().hunkContextHashesByFile).toEqual({});
    expect(store.getState().editedContents).toEqual({ '/repo/file.ts': 'draft' });
    expect(store.getState().hunkDecisions).toEqual({ '/repo/file.ts:0': 'rejected' });
    expect(store.getState().fileDecisions).toEqual({ '/repo/file.ts': 'rejected' });
    expect(store.getState().reviewExternalChangesByFile).toEqual({
      '/repo/file.ts': { type: 'change' },
    });
    expect(store.getState().fileContentVersionByPath['/repo/file.ts']).toBe(1);
  });

  it('invalidates review-key hunk hashes for grouped ledger files without clearing decisions', () => {
    const store = createSliceStore();
    const changeKey = 'rename:/repo/old.ts->/repo/new.ts';
    const ledgerFile = {
      ...makeFile('/repo/new.ts'),
      changeKey,
    };

    store.setState({
      activeChangeSet: {
        ...makeAgentChangeSet('/repo/new.ts'),
        files: [ledgerFile],
        totalFiles: 1,
        totalLinesAdded: ledgerFile.linesAdded,
        totalLinesRemoved: ledgerFile.linesRemoved,
      },
      hunkDecisions: { [`${changeKey}:0`]: 'rejected' },
      fileDecisions: { [changeKey]: 'rejected' },
      fileChunkCounts: { '/repo/new.ts': 2 },
      hunkContextHashesByFile: { [changeKey]: { 0: 'ctx-rename' } },
      fileContents: {
        '/repo/new.ts': {
          ...ledgerFile,
          originalFullContent: 'before',
          modifiedFullContent: 'after',
          contentSource: 'ledger-exact',
        },
      },
      fileContentsLoading: { '/repo/new.ts': true },
      editedContents: { '/repo/new.ts': 'draft' },
      reviewExternalChangesByFile: { '/repo/new.ts': { type: 'change' } },
      fileContentVersionByPath: {},
    });

    store.getState().invalidateResolvedFileContent('/repo/new.ts');

    expect(store.getState().hunkContextHashesByFile).toEqual({});
    expect(store.getState().hunkDecisions).toEqual({ [`${changeKey}:0`]: 'rejected' });
    expect(store.getState().fileDecisions).toEqual({ [changeKey]: 'rejected' });
    expect(store.getState().editedContents).toEqual({ '/repo/new.ts': 'draft' });
    expect(store.getState().fileContentVersionByPath['/repo/new.ts']).toBe(1);
  });

  it('reloadReviewFileFromDisk clears the draft but preserves review decisions', async () => {
    const store = createSliceStore();

    store.setState({
      activeChangeSet: makeAgentChangeSet('/repo/file.ts'),
      hunkDecisions: { '/repo/file.ts:0': 'rejected' },
      fileDecisions: { '/repo/file.ts': 'rejected' },
      fileChunkCounts: { '/repo/file.ts': 2 },
      hunkContextHashesByFile: { '/repo/file.ts': { 0: 'ctx' } },
      fileContents: {
        '/repo/file.ts': {
          ...makeFile('/repo/file.ts'),
          originalFullContent: 'before',
          modifiedFullContent: 'after',
          contentSource: 'snippet-reconstruction',
        },
      },
      editedContents: { '/repo/file.ts': 'draft' },
      reviewExternalChangesByFile: { '/repo/file.ts': { type: 'unlink' } },
      fileContentVersionByPath: {},
    });

    store.getState().reloadReviewFileFromDisk('/repo/file.ts');

    expect(store.getState().fileContents).toEqual({});
    expect(store.getState().fileChunkCounts).toEqual({});
    expect(store.getState().hunkContextHashesByFile).toEqual({});
    expect(store.getState().editedContents).toEqual({});
    expect(store.getState().reviewExternalChangesByFile).toEqual({});
    expect(store.getState().hunkDecisions).toEqual({ '/repo/file.ts:0': 'rejected' });
    expect(store.getState().fileDecisions).toEqual({ '/repo/file.ts': 'rejected' });
    expect(store.getState().fileContentVersionByPath['/repo/file.ts']).toBe(1);
  });

  it('ignores stale fetchFileContent responses after removing a review file', async () => {
    const store = createSliceStore();
    const pending = deferred<unknown>();
    hoisted.getFileContent.mockReturnValueOnce(pending.promise);

    store.setState({
      activeChangeSet: makeAgentChangeSet('/repo/file.ts'),
      changeSetEpoch: 0,
      fileContentVersionByPath: {},
    });

    const fetchPromise = store.getState().fetchFileContent('team-a', 'alice', '/repo/file.ts');
    await flushAsyncWork();
    store.getState().removeReviewFile('/repo/file.ts');

    pending.resolve({
      ...makeFile('/repo/file.ts'),
      originalFullContent: 'before',
      modifiedFullContent: 'after',
      contentSource: 'snippet-reconstruction',
    });
    await fetchPromise;
    await flushAsyncWork();

    expect(store.getState().activeChangeSet?.files).toEqual([]);
    expect(store.getState().fileContents).toEqual({});
    expect(store.getState().fileContentsLoading).toEqual({});
    expect(store.getState().fileContentVersionByPath['/repo/file.ts']).toBe(1);
  });

  it('removes relative Windows review files by slash/case variant without leaving stale state', async () => {
    const store = createSliceStore();
    const filePath = 'SRC\\File.ts';

    store.setState({
      activeChangeSet: makeAgentChangeSet(filePath),
      selectedReviewFilePath: filePath,
      hunkDecisions: { [`${filePath}:0`]: 'rejected' },
      fileDecisions: { [filePath]: 'rejected' },
      fileContents: {
        [filePath]: {
          ...makeFile(filePath),
          originalFullContent: 'before',
          modifiedFullContent: 'after',
          contentSource: 'snippet-reconstruction',
        },
      },
      fileContentsLoading: { [filePath]: true },
      fileContentVersionByPath: {},
    });

    store.getState().removeReviewFile('src/file.ts');

    expect(store.getState().activeChangeSet?.files).toEqual([]);
    expect(store.getState().selectedReviewFilePath).toBeNull();
    expect(store.getState().fileContents).toEqual({});
    expect(store.getState().fileContentsLoading).toEqual({});
    expect(store.getState().fileContentVersionByPath[filePath]).toBe(1);
  });

  it('clears path-equivalent loading aliases when removing the canonical review file', async () => {
    const store = createSliceStore();
    const filePath = 'SRC\\File.ts';

    store.setState({
      activeChangeSet: makeAgentChangeSet(filePath),
      fileContentsLoading: { [filePath]: true, 'src/file.ts': true },
      fileContentVersionByPath: { 'src/file.ts': 0 },
    });

    store.getState().removeReviewFile(filePath);

    expect(store.getState().fileContentsLoading).toEqual({});
    expect(store.getState().fileContentVersionByPath[filePath]).toBe(1);
    expect(store.getState().fileContentVersionByPath['src/file.ts']).toBe(1);
  });

  it('keeps restored file content when a stale fetch resolves after remove and re-add', async () => {
    const store = createSliceStore();
    const pending = deferred<unknown>();
    hoisted.getFileContent.mockReturnValueOnce(pending.promise);

    store.setState({
      activeChangeSet: makeAgentChangeSet('/repo/file.ts'),
      changeSetEpoch: 0,
      fileContentVersionByPath: {},
    });

    const fetchPromise = store.getState().fetchFileContent('team-a', 'alice', '/repo/file.ts');
    await flushAsyncWork();
    store.getState().removeReviewFile('/repo/file.ts');
    store.getState().addReviewFile(makeFile('/repo/file.ts'), {
      index: 0,
      content: {
        ...makeFile('/repo/file.ts'),
        originalFullContent: 'before',
        modifiedFullContent: 'restored',
        contentSource: 'snippet-reconstruction',
      },
    });

    pending.resolve({
      ...makeFile('/repo/file.ts'),
      originalFullContent: 'before',
      modifiedFullContent: 'stale',
      contentSource: 'snippet-reconstruction',
    });
    await fetchPromise;
    await flushAsyncWork();

    expect(store.getState().activeChangeSet?.files).toHaveLength(1);
    expect(store.getState().fileContents['/repo/file.ts']?.modifiedFullContent).toBe('restored');
    expect(store.getState().fileContentVersionByPath['/repo/file.ts']).toBe(1);
  });

  it('ignores stale fetchFileContent responses that resolve after saveEditedFile', async () => {
    const store = createSliceStore();
    const fetchPending = deferred<unknown>();
    const savePending = deferred<void>();
    hoisted.getFileContent.mockReturnValueOnce(fetchPending.promise);
    hoisted.saveEditedFile.mockReturnValueOnce(savePending.promise);

    store.setState({
      activeChangeSet: makeAgentChangeSet('/repo/file.ts'),
      fileContents: {
        '/repo/file.ts': {
          ...makeFile('/repo/file.ts'),
          originalFullContent: 'before',
          modifiedFullContent: 'draft-before-save',
          contentSource: 'snippet-reconstruction',
        },
      },
      fileContentsLoading: { '/repo/file.ts': true },
      fileChunkCounts: { '/repo/file.ts': 3 },
      hunkContextHashesByFile: { '/repo/file.ts': { 0: 'ctx' } },
      editedContents: { '/repo/file.ts': 'saved-content' },
      changeSetEpoch: 0,
      fileContentVersionByPath: {},
    });

    const fetchPromise = store.getState().fetchFileContent('team-a', 'alice', '/repo/file.ts');
    await flushAsyncWork();
    const savePromise = store
      .getState()
      .saveEditedFile('/repo/file.ts', AGENT_REVIEW_SCOPE, 'draft-before-save');
    await flushAsyncWork();

    savePending.resolve();
    await savePromise;

    fetchPending.resolve({
      ...makeFile('/repo/file.ts'),
      originalFullContent: 'before',
      modifiedFullContent: 'stale-after-save',
      contentSource: 'snippet-reconstruction',
    });
    await fetchPromise;
    await flushAsyncWork();

    expect(store.getState().editedContents).toEqual({});
    expect(store.getState().fileContents['/repo/file.ts']?.modifiedFullContent).toBe(
      'saved-content'
    );
    expect(store.getState().fileContentsLoading['/repo/file.ts']).toBe(false);
    expect(store.getState().fileChunkCounts).toEqual({});
    expect(store.getState().hunkContextHashesByFile).toEqual({});
    expect(store.getState().fileContentVersionByPath['/repo/file.ts']).toBe(1);
  });

  it('clears review-key hunk hashes after saveEditedFile for grouped ledger files', async () => {
    const store = createSliceStore();
    const changeKey = 'rename:/repo/old.ts->/repo/new.ts';
    const ledgerFile = {
      ...makeFile('/repo/new.ts'),
      changeKey,
    };
    hoisted.saveEditedFile.mockResolvedValueOnce(undefined);

    store.setState({
      activeChangeSet: {
        ...makeAgentChangeSet('/repo/new.ts'),
        files: [ledgerFile],
        totalFiles: 1,
        totalLinesAdded: ledgerFile.linesAdded,
        totalLinesRemoved: ledgerFile.linesRemoved,
      },
      fileContents: {
        '/repo/new.ts': {
          ...ledgerFile,
          originalFullContent: 'before',
          modifiedFullContent: 'draft-before-save',
          contentSource: 'ledger-exact',
        },
      },
      fileChunkCounts: { '/repo/new.ts': 2 },
      hunkContextHashesByFile: { [changeKey]: { 0: 'ctx-rename' } },
      hunkDecisions: { [`${changeKey}:0`]: 'rejected' },
      fileDecisions: { [changeKey]: 'rejected' },
      editedContents: { '/repo/new.ts': 'saved-content' },
      fileContentVersionByPath: {},
    });

    const result = await store
      .getState()
      .saveEditedFile('/repo/new.ts', AGENT_REVIEW_SCOPE, 'draft-before-save');

    expect(result).toEqual({ ok: true });
    expect(hoisted.saveEditedFile).toHaveBeenCalledWith(
      AGENT_REVIEW_SCOPE,
      '/repo/new.ts',
      'saved-content',
      'draft-before-save'
    );
    expect(store.getState().hunkContextHashesByFile).toEqual({});
    expect(store.getState().hunkDecisions).toEqual({});
    expect(store.getState().fileDecisions).toEqual({});
    expect(store.getState().fileChunkCounts).toEqual({});
    expect(store.getState().fileContents['/repo/new.ts']?.modifiedFullContent).toBe(
      'saved-content'
    );
  });

  it('returns a Save-owned failure result without consuming the edited draft', async () => {
    const store = createSliceStore();
    hoisted.saveEditedFile.mockRejectedValueOnce(new Error('conflict on disk'));
    store.setState({
      activeChangeSet: makeAgentChangeSet('/repo/file.ts'),
      editedContents: { '/repo/file.ts': 'manual' },
      changeSetEpoch: 1,
      fileContentVersionByPath: {},
    });

    const result = await store
      .getState()
      .saveEditedFile('/repo/file.ts', AGENT_REVIEW_SCOPE, 'agent-change');

    expect(result).toEqual({
      ok: false,
      error: 'File has been modified since agent changes.',
    });
    expect(store.getState().applyError).toBe('File has been modified since agent changes.');
    expect(store.getState().editedContents).toEqual({ '/repo/file.ts': 'manual' });
  });

  it('saves edited content through canonical Windows ledger paths and clears aliases', async () => {
    const store = createSliceStore();
    const canonicalPath = 'SRC\\File.ts';
    const aliasPath = 'src/file.ts';
    const ledgerFile = makeFile(canonicalPath);
    hoisted.saveEditedFile.mockResolvedValueOnce(undefined);

    store.setState({
      activeChangeSet: {
        ...makeAgentChangeSet(canonicalPath),
        files: [ledgerFile],
        totalFiles: 1,
      },
      fileContents: {
        [aliasPath]: {
          ...ledgerFile,
          filePath: aliasPath,
          originalFullContent: 'before',
          modifiedFullContent: 'draft-before-save',
          contentSource: 'ledger-exact',
        },
      },
      fileChunkCounts: { [aliasPath]: 2, [canonicalPath]: 2 },
      hunkContextHashesByFile: {
        [aliasPath]: { 0: 'ctx-alias' },
        [canonicalPath]: { 0: 'ctx-canonical' },
      },
      reviewExternalChangesByFile: { [aliasPath]: { type: 'change' } },
      editedContents: { [aliasPath]: 'saved-content' },
      fileContentVersionByPath: {},
    });

    await store.getState().saveEditedFile(aliasPath, AGENT_REVIEW_SCOPE, 'draft-before-save');

    expect(hoisted.saveEditedFile).toHaveBeenCalledWith(
      AGENT_REVIEW_SCOPE,
      canonicalPath,
      'saved-content',
      'draft-before-save'
    );
    expect(store.getState().editedContents).toEqual({});
    expect(store.getState().fileChunkCounts).toEqual({});
    expect(store.getState().hunkContextHashesByFile).toEqual({});
    expect(store.getState().reviewExternalChangesByFile).toEqual({});
    expect(store.getState().fileContents[aliasPath]).toBeUndefined();
    expect(store.getState().fileContents[canonicalPath]?.filePath).toBe(canonicalPath);
    expect(store.getState().fileContents[canonicalPath]?.modifiedFullContent).toBe('saved-content');
    expect(store.getState().fileContentVersionByPath[aliasPath]).toBe(1);
    expect(store.getState().fileContentVersionByPath[canonicalPath]).toBe(1);
  });

  it('does not canonicalize POSIX paths that differ only by case when saving edits', async () => {
    const store = createSliceStore();
    const canonicalPath = 'SRC/File.ts';
    const requestedPath = 'src/file.ts';
    hoisted.saveEditedFile.mockResolvedValueOnce(undefined);

    store.setState({
      activeChangeSet: makeAgentChangeSet(canonicalPath),
      fileContents: {
        [requestedPath]: {
          ...makeFile(requestedPath),
          originalFullContent: 'before',
          modifiedFullContent: 'draft-before-save',
          contentSource: 'snippet-reconstruction',
        },
      },
      editedContents: { [requestedPath]: 'saved-content' },
      fileContentVersionByPath: {},
    });

    await store.getState().saveEditedFile(requestedPath, AGENT_REVIEW_SCOPE, 'draft-before-save');

    expect(hoisted.saveEditedFile).toHaveBeenCalledWith(
      AGENT_REVIEW_SCOPE,
      requestedPath,
      'saved-content',
      'draft-before-save'
    );
    expect(store.getState().fileContents[requestedPath]?.modifiedFullContent).toBe('saved-content');
    expect(store.getState().fileContents[canonicalPath]).toBeUndefined();
  });

  it('forces re-review when snippets change even if file paths stay the same', async () => {
    const store = createSliceStore();
    const current = makeAgentChangeSet('/repo/file.ts', { newString: 'after' });
    const fresh = makeAgentChangeSet('/repo/file.ts', { newString: 'after-v2' });
    hoisted.getAgentChanges.mockResolvedValueOnce(fresh);

    store.setState({
      activeChangeSet: current,
      hunkDecisions: { '/repo/file.ts:0': 'rejected' },
      fileDecisions: { '/repo/file.ts': 'rejected' },
      fileChunkCounts: { '/repo/file.ts': 1 },
      reviewUndoStack: [
        {
          hunkDecisions: { '/repo/file.ts:0': 'rejected' },
          fileDecisions: { '/repo/file.ts': 'rejected' },
        },
      ],
      hunkContextHashesByFile: { '/repo/file.ts': { 0: 'ctx' } },
      fileContents: {
        '/repo/file.ts': {
          ...makeFile('/repo/file.ts'),
          originalFullContent: 'before',
          modifiedFullContent: 'after',
          contentSource: 'snippet-reconstruction',
        },
      },
      fileContentsLoading: { '/repo/file.ts': false },
      editedContents: { '/repo/file.ts': 'draft' },
      changeSetEpoch: 2,
      fileContentVersionByPath: { '/repo/file.ts': 3 },
    });

    await store.getState().applyReview('team-a', undefined, 'alice');

    expect(hoisted.applyDecisions).not.toHaveBeenCalled();
    expect(store.getState().activeChangeSet).toEqual(fresh);
    expect(store.getState().applyError).toBe(
      'Changes have been updated since you started reviewing. Please re-review.'
    );
    expect(store.getState().hunkDecisions).toEqual({});
    expect(store.getState().fileDecisions).toEqual({});
    expect(store.getState().reviewUndoStack).toEqual([]);
    expect(store.getState().hunkContextHashesByFile).toEqual({});
    expect(store.getState().fileContents).toEqual({});
    expect(store.getState().fileContentsLoading).toEqual({});
    expect(store.getState().editedContents).toEqual({});
    expect(store.getState().changeSetEpoch).toBe(3);
    expect(store.getState().fileContentVersionByPath).toEqual({});
  });

  it('forces re-review when snippet order changes even if file paths stay the same', async () => {
    const store = createSliceStore();
    const first = makeSnippet({
      toolUseId: 'tool-1',
      filePath: '/repo/file.ts',
      oldString: 'a',
      newString: 'b',
      timestamp: '2026-03-01T10:00:00.000Z',
    });
    const second = makeSnippet({
      toolUseId: 'tool-2',
      filePath: '/repo/file.ts',
      oldString: 'c',
      newString: 'd',
      timestamp: '2026-03-01T10:01:00.000Z',
    });
    const current = {
      memberName: 'alice',
      teamName: 'team-a',
      files: [
        {
          ...makeFile('/repo/file.ts'),
          snippets: [first, second],
        },
      ],
      totalFiles: 1,
      totalLinesAdded: 1,
      totalLinesRemoved: 1,
    };
    const fresh = {
      ...current,
      files: [
        {
          ...current.files[0],
          snippets: [second, first],
        },
      ],
    };
    hoisted.getAgentChanges.mockResolvedValueOnce(fresh);

    store.setState({
      activeChangeSet: current,
      hunkDecisions: { '/repo/file.ts:0': 'rejected' },
      fileDecisions: { '/repo/file.ts': 'rejected' },
      changeSetEpoch: 0,
      fileContentVersionByPath: {},
    });

    await store.getState().applyReview('team-a', undefined, 'alice');

    expect(hoisted.applyDecisions).not.toHaveBeenCalled();
    expect(store.getState().activeChangeSet).toEqual(fresh);
    expect(store.getState().applyError).toBe(
      'Changes have been updated since you started reviewing. Please re-review.'
    );
  });

  it('does not force re-review when only top-level file order changes', async () => {
    const store = createSliceStore();
    const firstFile = makeFile('/repo/a.ts', { newString: 'after-a' });
    const secondFile = makeFile('/repo/b.ts', { newString: 'after-b' });
    const current = {
      memberName: 'alice',
      teamName: 'team-a',
      files: [firstFile, secondFile],
      totalFiles: 2,
      totalLinesAdded: firstFile.linesAdded + secondFile.linesAdded,
      totalLinesRemoved: firstFile.linesRemoved + secondFile.linesRemoved,
    };
    const fresh = {
      ...current,
      files: [secondFile, firstFile],
    };
    hoisted.getAgentChanges.mockResolvedValueOnce(fresh);
    hoisted.applyDecisions.mockResolvedValueOnce({
      applied: 0,
      skipped: 0,
      conflicts: 0,
      errors: [],
    });

    store.setState({
      activeChangeSet: current,
      hunkDecisions: { '/repo/a.ts:0': 'rejected' },
      fileDecisions: { '/repo/a.ts': 'rejected' },
      changeSetEpoch: 0,
      fileContentVersionByPath: {},
    });

    await store.getState().applyReview('team-a', undefined, 'alice');

    expect(store.getState().applyError).toBeNull();
    expect(hoisted.applyDecisions).toHaveBeenCalledTimes(1);
    expect(hoisted.applyDecisions).toHaveBeenCalledWith({
      teamName: 'team-a',
      taskId: undefined,
      memberName: 'alice',
      decisionPersistenceScope: {
        scopeKey: 'agent-alice',
        scopeToken: expect.stringContaining('agent:alice:content:'),
      },
      expectedDecisionRevision: 0,
      persistedState: {
        hunkDecisions: { '/repo/a.ts:0': 'rejected' },
        fileDecisions: { '/repo/a.ts': 'rejected' },
        hunkContextHashesByFile: {},
        reviewActionHistory: [],
        reviewRedoHistory: [],
      },
      decisions: [
        expect.objectContaining({
          filePath: '/repo/a.ts',
          reviewKey: '/repo/a.ts',
        }),
      ],
    });
    expect(store.getState().activeChangeSet).toEqual(current);
  });

  it('records review apply outcome without leaking file paths or diff content', async () => {
    const store = createSliceStore();
    const changeSet = makeAgentChangeSet('/repo/secret-file.ts', {
      oldString: 'secret-before',
      newString: 'secret-after',
    });
    hoisted.applyDecisions.mockResolvedValueOnce({
      applied: 1,
      skipped: 0,
      conflicts: 0,
      errors: [],
    });

    store.setState({
      activeChangeSet: changeSet,
      hunkDecisions: { '/repo/secret-file.ts:0': 'rejected' },
      fileDecisions: { '/repo/secret-file.ts': 'rejected' },
      fileChunkCounts: { '/repo/secret-file.ts': 1 },
      changeSetEpoch: 0,
      fileContentVersionByPath: {},
    });

    await store.getState().applyReview('team-a');

    expect(hoisted.capturePostHogEvent).toHaveBeenCalledWith('change_review:apply_end', {
      success: true,
      decision: 'request_changes',
      files_count_bucket: '1',
      accepted_count_bucket: '0',
      rejected_count_bucket: '1',
      duration_ms_bucket: expect.any(String),
      error_class: 'none',
    });
    expect(JSON.stringify(hoisted.capturePostHogEvent.mock.calls)).not.toContain('secret-file');
    expect(JSON.stringify(hoisted.capturePostHogEvent.mock.calls)).not.toContain('secret-before');
  });

  it('does not force re-review when ledger provenance stays stable despite warning changes', async () => {
    const store = createSliceStore();
    const current = {
      ...makeTaskChangeSet('task-ledger', '/repo/file.ts'),
      provenance: {
        sourceKind: 'ledger',
        sourceFingerprint: 'projected-fp-stable',
      },
      warnings: [],
    };
    const fresh = {
      ...current,
      computedAt: '2026-03-01T13:00:00.000Z',
      warnings: ['raw journal warning changed'],
    };
    hoisted.getTaskChanges.mockResolvedValueOnce(fresh);
    hoisted.applyDecisions.mockResolvedValueOnce({
      applied: 1,
      skipped: 0,
      conflicts: 0,
      errors: [],
    });

    store.setState({
      activeChangeSet: current,
      hunkDecisions: { '/repo/file.ts:0': 'rejected' },
      fileDecisions: { '/repo/file.ts': 'rejected' },
      fileChunkCounts: { '/repo/file.ts': 1 },
      changeSetEpoch: 0,
      fileContentVersionByPath: {},
    });

    await store.getState().applyReview('team-a', 'task-ledger');

    expect(store.getState().applyError).toBeNull();
    expect(hoisted.applyDecisions).toHaveBeenCalledTimes(1);
    expect(store.getState().activeChangeSet).toEqual(current);
  });

  it('uses task freshness and the exact task persistence scope when memberName is also present', async () => {
    const store = createSliceStore();
    const current = {
      ...makeTaskChangeSet('task-ledger', '/repo/file.ts'),
      provenance: {
        sourceKind: 'ledger' as const,
        sourceFingerprint: 'projected-fp-stable',
      },
    };
    hoisted.getTaskChanges.mockResolvedValueOnce(current);
    hoisted.applyDecisions.mockResolvedValueOnce({
      applied: 1,
      skipped: 0,
      conflicts: 0,
      errors: [],
    });
    store.setState({
      activeChangeSet: current,
      activeTaskChangeRequestOptions: REVIEW_OPTIONS,
      hunkDecisions: { '/repo/file.ts:0': 'rejected' },
      fileDecisions: { '/repo/file.ts': 'rejected' },
      fileChunkCounts: { '/repo/file.ts': 1 },
      changeSetEpoch: 0,
      fileContentVersionByPath: {},
    });

    await store.getState().applyReview('team-a', 'task-ledger', 'alice');

    expect(hoisted.getTaskChanges).toHaveBeenCalledWith('team-a', 'task-ledger', {
      ...REVIEW_OPTIONS,
      forceFresh: true,
    });
    expect(hoisted.getAgentChanges).not.toHaveBeenCalled();
    expect(hoisted.applyDecisions).toHaveBeenCalledWith(
      expect.objectContaining({
        teamName: 'team-a',
        taskId: 'task-ledger',
        memberName: 'alice',
        decisionPersistenceScope: {
          scopeKey: 'task-task-ledger',
          scopeToken: expect.stringContaining(
            'task:task-ledger:{"owner":"alice","status":"completed"'
          ),
        },
        decisions: [
          expect.objectContaining({
            filePath: '/repo/file.ts',
            reviewKey: '/repo/file.ts',
          }),
        ],
      })
    );
  });

  it('forces re-review when ledger projected provenance changes with the same file paths', async () => {
    const store = createSliceStore();
    const current = {
      ...makeTaskChangeSet('task-ledger', '/repo/file.ts'),
      provenance: {
        sourceKind: 'ledger',
        sourceFingerprint: 'projected-fp-v1',
      },
    };
    const fresh = {
      ...current,
      provenance: {
        sourceKind: 'ledger',
        sourceFingerprint: 'projected-fp-v2',
      },
    };
    hoisted.getTaskChanges.mockResolvedValueOnce(fresh);

    store.setState({
      activeChangeSet: current,
      hunkDecisions: { '/repo/file.ts:0': 'rejected' },
      fileDecisions: { '/repo/file.ts': 'rejected' },
      fileChunkCounts: { '/repo/file.ts': 1 },
      reviewUndoStack: [
        {
          hunkDecisions: { '/repo/file.ts:0': 'rejected' },
          fileDecisions: { '/repo/file.ts': 'rejected' },
        },
      ],
      changeSetEpoch: 2,
      fileContentVersionByPath: { '/repo/file.ts': 3 },
    });

    await store.getState().applyReview('team-a', 'task-ledger');

    expect(hoisted.applyDecisions).not.toHaveBeenCalled();
    expect(store.getState().activeChangeSet).toEqual(fresh);
    expect(store.getState().applyError).toBe(
      'Changes have been updated since you started reviewing. Please re-review.'
    );
    expect(store.getState().hunkDecisions).toEqual({});
    expect(store.getState().fileDecisions).toEqual({});
    expect(store.getState().reviewUndoStack).toEqual([]);
    expect(store.getState().fileContentVersionByPath).toEqual({});
  });

  it('clears metadata-only decisions when ledger evidence upgrades to full text for the same changeKey', async () => {
    const store = createSliceStore();
    const changeKey = 'path:/repo/file.ts';
    const currentFile = {
      ...makeFile('/repo/file.ts'),
      changeKey,
      snippets: [],
      ledgerSummary: {
        latestOperation: 'modify',
        contentAvailability: 'metadata-only',
        reviewability: 'metadata-only',
      },
    };
    const freshFile = {
      ...makeFile('/repo/file.ts'),
      changeKey,
      ledgerSummary: {
        latestOperation: 'modify',
        contentAvailability: 'full-text',
        reviewability: 'full-text',
        beforeState: { exists: true, sha256: 'before-hash', sizeBytes: 6 },
        afterState: { exists: true, sha256: 'after-hash', sizeBytes: 5 },
      },
    };
    const current = {
      ...makeTaskChangeSet('task-ledger', '/repo/file.ts'),
      files: [currentFile],
      provenance: {
        sourceKind: 'ledger',
        sourceFingerprint: 'metadata-only-projection',
      },
    };
    const fresh = {
      ...current,
      files: [freshFile],
      provenance: {
        sourceKind: 'ledger',
        sourceFingerprint: 'snapshot-full-text-projection',
      },
    };
    hoisted.getTaskChanges.mockResolvedValueOnce(fresh);

    store.setState({
      activeChangeSet: current,
      hunkDecisions: { [`${changeKey}:0`]: 'rejected' },
      fileDecisions: { [changeKey]: 'rejected' },
      hunkContextHashesByFile: { [changeKey]: { 0: 'metadata-only-context' } },
      fileChunkCounts: { [changeKey]: 1 },
      reviewUndoStack: [
        {
          hunkDecisions: { [`${changeKey}:0`]: 'rejected' },
          fileDecisions: { [changeKey]: 'rejected' },
        },
      ],
      changeSetEpoch: 4,
      fileContentVersionByPath: { '/repo/file.ts': 2 },
    });

    await store.getState().applyReview('team-a', 'task-ledger');

    expect(hoisted.applyDecisions).not.toHaveBeenCalled();
    expect(store.getState().activeChangeSet).toEqual(fresh);
    expect(store.getState().fileDecisions).toEqual({});
    expect(store.getState().hunkDecisions).toEqual({});
    expect(store.getState().hunkContextHashesByFile).toEqual({});
    expect(store.getState().reviewUndoStack).toEqual([]);
    expect(store.getState().fileContentVersionByPath).toEqual({});
  });

  it('does not let a late persisted-decision read overwrite an interactive decision', async () => {
    const store = createSliceStore();
    const pending = deferred<{
      hunkDecisions: Record<string, 'rejected'>;
      fileDecisions: Record<string, 'rejected'>;
    }>();
    hoisted.loadDecisions.mockReturnValueOnce(pending.promise);
    store.setState({
      activeChangeSet: makeTaskChangeSet('task-a'),
      fileChunkCounts: { '/repo/file.ts': 1 },
      changeSetEpoch: 1,
    });

    const loadPromise = store.getState().loadDecisionsFromDisk('team-a', 'task-task-a', 'scope-a');
    await flushAsyncWork();
    store.getState().setHunkDecision('/repo/file.ts', 0, 'accepted');

    pending.resolve({
      hunkDecisions: { '/repo/file.ts:0': 'rejected' },
      fileDecisions: { '/repo/file.ts': 'rejected' },
    });
    await loadPromise;

    expect(store.getState().hunkDecisions).toEqual({ '/repo/file.ts:0': 'accepted' });
    expect(store.getState().fileDecisions).toEqual({});
    expect(store.getState().decisionHydrationStatus).toBe('error');
  });

  it('exposes exact-scope decision hydration as loading before it becomes ready', async () => {
    const store = createSliceStore();
    const pending = deferred<null>();
    hoisted.loadDecisions.mockReturnValueOnce(pending.promise);
    store.setState({ activeChangeSet: makeAgentChangeSet(), changeSetEpoch: 1 });

    const load = store.getState().loadDecisionsFromDisk('team-a', 'agent-alice', 'hydration-scope');

    expect(store.getState().decisionHydrationStatus).toBe('loading');
    expect(store.getState().decisionHydrationScopeKey).toBe('team-a:agent-alice:hydration-scope');

    pending.resolve(null);
    await load;
    expect(store.getState().decisionHydrationStatus).toBe('loaded');
  });

  it('preserves in-memory decisions and marks hydration failed on a read error', async () => {
    const store = createSliceStore();
    hoisted.loadDecisions.mockRejectedValueOnce(new Error('disk unavailable'));
    store.setState({
      activeChangeSet: makeAgentChangeSet(),
      hunkDecisions: { '/repo/file.ts:0': 'rejected' },
      fileDecisions: { '/repo/file.ts': 'rejected' },
      changeSetEpoch: 1,
    });

    await store.getState().loadDecisionsFromDisk('team-a', 'agent-alice', 'failed-hydration');
    vi.mocked(console.error).mockClear();

    expect(store.getState().hunkDecisions).toEqual({ '/repo/file.ts:0': 'rejected' });
    expect(store.getState().fileDecisions).toEqual({ '/repo/file.ts': 'rejected' });
    expect(store.getState().decisionHydrationStatus).toBe('error');
    expect(store.getState().applyError).toContain('Unable to load');

    hoisted.loadDecisions.mockResolvedValueOnce({
      hunkDecisions: { '/repo/file.ts:0': 'accepted' },
      fileDecisions: { '/repo/file.ts': 'accepted' },
    });
    await store.getState().loadDecisionsFromDisk('team-a', 'agent-alice', 'failed-hydration');

    expect(store.getState().hunkDecisions).toEqual({ '/repo/file.ts:0': 'rejected' });
    expect(store.getState().fileDecisions).toEqual({ '/repo/file.ts': 'rejected' });
    expect(store.getState().decisionHydrationStatus).toBe('loaded');
    expect(store.getState().applyError).toBeNull();
  });

  it('hydrates and re-persists ordered review history beyond ten actions', async () => {
    const store = createSliceStore();
    const history = Array.from({ length: 25 }, (_, index) => ({
      id: `hunk-${index}`,
      createdAt: new Date(1_700_000_000_000 + index).toISOString(),
      kind: 'hunk' as const,
      action: { filePath: '/repo/file.ts', originalIndex: index },
    }));
    store.setState({ activeChangeSet: makeAgentChangeSet(), changeSetEpoch: 1 });
    hoisted.loadDecisions.mockResolvedValueOnce({
      hunkDecisions: { '/repo/file.ts:0': 'accepted' },
      fileDecisions: {},
      reviewActionHistory: history,
    });

    await store.getState().loadDecisionsFromDisk('team-a', 'agent-alice', 'history-scope');
    expect(store.getState().reviewActionHistory).toEqual(history);

    store.getState().persistDecisions('team-a', 'agent-alice', 'history-scope');
    await expect(
      store.getState().flushDecisionsToDisk('team-a', 'agent-alice', 'history-scope')
    ).resolves.toBe(true);
    expect(hoisted.saveDecisions).toHaveBeenLastCalledWith(
      'team-a',
      'agent-alice',
      'history-scope',
      { '/repo/file.ts:0': 'accepted' },
      {},
      { '/repo/file.ts': {} },
      history,
      expect.any(Number),
      []
    );
  });

  it('hydrates and deep-clones the durable Redo branch before a queued save', async () => {
    const store = createSliceStore();
    const action = {
      id: 'redo-action',
      createdAt: '2026-07-17T12:00:00.000Z',
      kind: 'hunk' as const,
      action: { filePath: '/repo/file.ts', originalIndex: 0 },
    };
    const redoHistory: ReviewRedoAction[] = [
      {
        action,
        decisionSnapshot: {
          hunkDecisions: { '/repo/file.ts:0': 'accepted' as const },
          fileDecisions: {},
        },
        hunkContextHashesByFile: { '/repo/file.ts': { 0: 'hash' } },
      },
    ];
    store.setState({ activeChangeSet: makeAgentChangeSet(), changeSetEpoch: 1 });
    hoisted.loadDecisions.mockResolvedValueOnce({
      hunkDecisions: {},
      fileDecisions: {},
      reviewActionHistory: [],
      reviewRedoHistory: redoHistory,
      revision: 4,
    });

    await store.getState().loadDecisionsFromDisk('team-a', 'agent-alice', 'redo-scope');
    expect(store.getState().reviewRedoHistory).toEqual(redoHistory);
    store.getState().persistDecisions('team-a', 'agent-alice', 'redo-scope');
    redoHistory[0]!.decisionSnapshot.hunkDecisions['/repo/file.ts:0'] = 'rejected';
    redoHistory[0]!.hunkContextHashesByFile!['/repo/file.ts']![0] = 'changed';
    await expect(
      store.getState().flushDecisionsToDisk('team-a', 'agent-alice', 'redo-scope')
    ).resolves.toBe(true);

    expect(hoisted.saveDecisions).toHaveBeenLastCalledWith(
      'team-a',
      'agent-alice',
      'redo-scope',
      {},
      {},
      { '/repo/file.ts': {} },
      [],
      4,
      [
        expect.objectContaining({
          decisionSnapshot: {
            hunkDecisions: { '/repo/file.ts:0': 'accepted' },
            fileDecisions: {},
          },
          hunkContextHashesByFile: { '/repo/file.ts': { 0: 'hash' } },
        }),
      ]
    );
  });

  it('does not apply task A decisions after the review scope switches to task B', async () => {
    const store = createSliceStore();
    const pendingFresh = deferred<ReturnType<typeof makeTaskChangeSet>>();
    hoisted.getTaskChanges.mockReturnValueOnce(pendingFresh.promise);
    const taskA = makeTaskChangeSet('task-a');
    const taskB = makeTaskChangeSet('task-b');
    store.setState({
      activeChangeSet: taskA,
      hunkDecisions: { '/repo/file.ts:0': 'rejected' },
      fileDecisions: { '/repo/file.ts': 'rejected' },
      fileChunkCounts: { '/repo/file.ts': 1 },
      changeSetEpoch: 1,
    });

    const applyPromise = store.getState().applyReview('team-a', 'task-a');
    await flushAsyncWork();
    store.setState({
      activeChangeSet: taskB,
      hunkDecisions: { '/repo/file.ts:0': 'accepted' },
      fileDecisions: { '/repo/file.ts': 'accepted' },
      changeSetEpoch: 2,
      applying: false,
    });
    pendingFresh.resolve(taskA);
    await applyPromise;

    expect(hoisted.applyDecisions).not.toHaveBeenCalled();
    expect(store.getState().activeChangeSet).toBe(taskB);
    expect(store.getState().hunkDecisions).toEqual({ '/repo/file.ts:0': 'accepted' });
    expect(store.getState().fileDecisions).toEqual({ '/repo/file.ts': 'accepted' });
  });

  it('does not let a late task A save clear a task B draft with the same file path', async () => {
    const store = createSliceStore();
    const pendingSave = deferred<void>();
    hoisted.saveEditedFile.mockReturnValueOnce(pendingSave.promise);
    store.setState({
      activeChangeSet: makeTaskChangeSet('task-a'),
      editedContents: { '/repo/file.ts': 'task-a-draft' },
      changeSetEpoch: 1,
      fileContentVersionByPath: {},
    });

    const savePromise = store
      .getState()
      .saveEditedFile('/repo/file.ts', TASK_A_REVIEW_SCOPE, 'task-a-base');
    await flushAsyncWork();
    const taskB = makeTaskChangeSet('task-b');
    store.setState({
      activeChangeSet: taskB,
      editedContents: { '/repo/file.ts': 'task-b-draft' },
      changeSetEpoch: 2,
      applying: false,
    });
    pendingSave.resolve();
    await savePromise;

    expect(store.getState().activeChangeSet).toBe(taskB);
    expect(store.getState().editedContents).toEqual({ '/repo/file.ts': 'task-b-draft' });
  });

  it('keeps a newer draft when an older save resolves late', async () => {
    const store = createSliceStore();
    const pendingSave = deferred<void>();
    hoisted.saveEditedFile.mockReturnValueOnce(pendingSave.promise);
    store.setState({
      activeChangeSet: makeAgentChangeSet(),
      fileContents: {
        '/repo/file.ts': {
          ...makeFile(),
          originalFullContent: 'before',
          modifiedFullContent: 'agent-change',
          contentSource: 'snippet-reconstruction',
        },
      },
      editedContents: { '/repo/file.ts': 'first-draft' },
      changeSetEpoch: 1,
      fileContentVersionByPath: {},
    });

    const savePromise = store
      .getState()
      .saveEditedFile('/repo/file.ts', AGENT_REVIEW_SCOPE, 'agent-change');
    await flushAsyncWork();
    store.getState().updateEditedContent('/repo/file.ts', 'newer-draft');
    pendingSave.resolve();
    await savePromise;

    expect(store.getState().editedContents).toEqual({ '/repo/file.ts': 'newer-draft' });
    expect(store.getState().fileContents['/repo/file.ts'].modifiedFullContent).toBe('first-draft');
    expect(store.getState().applying).toBe(false);
  });

  it('surfaces per-file apply errors returned without throwing', async () => {
    const store = createSliceStore();
    hoisted.applyDecisions.mockResolvedValueOnce({
      applied: 0,
      skipped: 1,
      conflicts: 1,
      errors: [{ filePath: '/repo/file.ts', error: 'File changed on disk', code: 'conflict' }],
    });
    store.setState({
      activeChangeSet: makeAgentChangeSet(),
      hunkDecisions: { '/repo/file.ts:0': 'rejected' },
      fileChunkCounts: { '/repo/file.ts': 1 },
      changeSetEpoch: 1,
    });

    const result = await store.getState().applyReview('team-a');

    expect(result?.conflicts).toBe(1);
    expect(store.getState().applyError).toBe('File changed on disk');
    expect(store.getState().applying).toBe(false);
  });

  it('returns an operation-owned success result when Apply only approves pending changes', async () => {
    const store = createSliceStore();
    store.setState({
      activeChangeSet: makeAgentChangeSet(),
      hunkDecisions: { '/repo/file.ts:0': 'accepted' },
      fileChunkCounts: { '/repo/file.ts': 1 },
      changeSetEpoch: 1,
    });

    await expect(store.getState().applyReview('team-a')).resolves.toEqual({
      applied: 0,
      skipped: 0,
      conflicts: 0,
      errors: [],
    });
    expect(hoisted.applyDecisions).not.toHaveBeenCalled();
    expect(store.getState().applyError).toBeNull();
  });

  it('refuses to apply a stale change set owned by another team', async () => {
    const store = createSliceStore();
    store.setState({
      activeChangeSet: makeAgentChangeSet(),
      hunkDecisions: { '/repo/file.ts:0': 'rejected' },
      fileChunkCounts: { '/repo/file.ts': 1 },
      changeSetEpoch: 1,
    });

    const allResult = await store.getState().applyReview('team-b', undefined, 'alice');
    const fileResult = await store
      .getState()
      .applySingleFileDecision('team-b', '/repo/file.ts', undefined, 'alice');

    expect(allResult).toBeNull();
    expect(fileResult).toBeNull();
    expect(hoisted.getAgentChanges).not.toHaveBeenCalled();
    expect(hoisted.applyDecisions).not.toHaveBeenCalled();
    expect(store.getState().applyError).toBe(
      'Review scope changed. Reload Changes before applying.'
    );
  });

  it('surfaces instant single-file apply errors returned without throwing', async () => {
    const store = createSliceStore();
    hoisted.applyDecisions.mockResolvedValueOnce({
      applied: 0,
      skipped: 1,
      conflicts: 1,
      errors: [{ filePath: '/repo/file.ts', error: 'Concurrent edit conflict', code: 'conflict' }],
    });
    store.setState({
      activeChangeSet: makeAgentChangeSet(),
      hunkDecisions: { '/repo/file.ts:0': 'rejected' },
      fileChunkCounts: { '/repo/file.ts': 1 },
      changeSetEpoch: 1,
    });

    const result = await store
      .getState()
      .applySingleFileDecision('team-a', '/repo/file.ts', undefined, 'alice');

    expect(result?.conflicts).toBe(1);
    expect(store.getState().applyError).toBe('Concurrent edit conflict');
    expect(hoisted.applyDecisions).toHaveBeenCalledWith(
      expect.objectContaining({
        decisionPersistenceScope: {
          scopeKey: 'agent-alice',
          scopeToken: expect.stringContaining('agent:alice:content:'),
        },
        decisions: [expect.objectContaining({ reviewKey: '/repo/file.ts' })],
      })
    );
  });

  it('flushes a pending debounced decision write before close cleanup can cancel it', async () => {
    const store = createSliceStore();
    store.setState({
      activeChangeSet: makeAgentChangeSet(),
      hunkDecisions: { '/repo/file.ts:0': 'accepted' },
      fileDecisions: { '/repo/file.ts': 'accepted' },
    });

    store.getState().persistDecisions('team-a', 'agent-alice', 'scope-token');
    expect(hoisted.saveDecisions).not.toHaveBeenCalled();

    const flushed = await store
      .getState()
      .flushDecisionsToDisk('team-a', 'agent-alice', 'scope-token');
    store.getState().clearChangeReviewCache();

    expect(flushed).toBe(true);
    expect(hoisted.saveDecisions).toHaveBeenCalledTimes(1);
    expect(hoisted.saveDecisions).toHaveBeenCalledWith(
      'team-a',
      'agent-alice',
      'scope-token',
      { '/repo/file.ts:0': 'accepted' },
      { '/repo/file.ts': 'accepted' },
      { '/repo/file.ts': {} },
      [],
      expect.any(Number),
      []
    );
  });

  it('does not cancel another exact-scope persistence timer when volatile review state resets', async () => {
    vi.useFakeTimers();
    try {
      const store = createSliceStore();
      store.setState({
        activeChangeSet: makeAgentChangeSet(),
        hunkDecisions: { '/repo/file.ts:0': 'accepted' },
      });
      store.getState().persistDecisions('team-a', 'agent-alice', 'surviving-scope');

      store.getState().clearChangeReviewCache();
      await vi.advanceTimersByTimeAsync(500);

      expect(hoisted.saveDecisions).toHaveBeenCalledWith(
        'team-a',
        'agent-alice',
        'surviving-scope',
        { '/repo/file.ts:0': 'accepted' },
        {},
        { '/repo/file.ts': {} },
        [],
        expect.any(Number),
        []
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('uses the revision of the queued scope after the UI switches to another scope', async () => {
    vi.useFakeTimers();
    try {
      const store = createSliceStore();
      store.setState({
        activeChangeSet: makeAgentChangeSet(),
        fileDecisions: { '/repo/file.ts': 'accepted' },
        decisionHydrationScopeKey: 'team-a:agent-alice:scope-a',
        decisionHydrationStatus: 'loaded',
      });
      store.getState().recordDecisionRevision('team-a', 'agent-alice', 'scope-a', 4);
      store.getState().persistDecisions('team-a', 'agent-alice', 'scope-a');

      store.setState({ decisionHydrationScopeKey: 'team-a:agent-alice:scope-b' });
      store.getState().recordDecisionRevision('team-a', 'agent-alice', 'scope-b', 99);
      await vi.advanceTimersByTimeAsync(500);

      expect(hoisted.saveDecisions).toHaveBeenCalledWith(
        'team-a',
        'agent-alice',
        'scope-a',
        {},
        { '/repo/file.ts': 'accepted' },
        { '/repo/file.ts': {} },
        [],
        4,
        []
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('deep-clones queued Undo history before later in-memory reconciliation', async () => {
    const store = createSliceStore();
    const history = [
      {
        id: 'disk-action',
        createdAt: '2026-07-17T12:00:00.000Z',
        kind: 'disk' as const,
        action: {
          snapshot: {
            filePath: '/repo/file.ts',
            beforeContent: 'before\n',
            afterContent: 'predicted\n',
          },
        },
      },
    ];
    store.setState({ activeChangeSet: makeAgentChangeSet(), reviewActionHistory: history });
    store.getState().persistDecisions('team-a', 'agent-alice', 'clone-scope');
    history[0]!.action.snapshot.afterContent = 'mutated-after-queue\n';

    await store.getState().flushDecisionsToDisk('team-a', 'agent-alice', 'clone-scope');

    expect(hoisted.saveDecisions.mock.calls[0]?.[6]).toMatchObject([
      { action: { snapshot: { afterContent: 'predicted\n' } } },
    ]);
  });

  it('reports a failed decision flush so the dialog can remain open', async () => {
    const store = createSliceStore();
    hoisted.saveDecisions.mockRejectedValueOnce(new Error('disk full'));
    store.setState({
      activeChangeSet: makeAgentChangeSet(),
      fileDecisions: { '/repo/file.ts': 'accepted' },
    });
    store.getState().persistDecisions('team-a', 'agent-alice', 'scope-token');

    await expect(
      store.getState().flushDecisionsToDisk('team-a', 'agent-alice', 'scope-token')
    ).resolves.toBe(false);
    vi.mocked(console.error).mockClear();
  });

  it('can retry the authoritative current snapshot after an immediate decision flush fails', async () => {
    const store = createSliceStore();
    hoisted.saveDecisions
      .mockRejectedValueOnce(new Error('disk full'))
      .mockResolvedValueOnce({ revision: 1 });
    const history = [
      {
        id: 'accepted-hunk',
        createdAt: '2026-07-18T10:00:00.000Z',
        kind: 'hunk' as const,
        descriptor: {
          intent: 'accept-hunk' as const,
          filePath: '/repo/file.ts',
          hunkIndex: 0,
        },
        action: { filePath: '/repo/file.ts', originalIndex: 0 },
      },
    ];
    store.setState({
      activeChangeSet: makeAgentChangeSet(),
      hunkDecisions: { '/repo/file.ts:0': 'accepted' },
      reviewActionHistory: history,
    });

    store.getState().persistDecisions('team-a', 'agent-alice', 'retry-scope');
    await expect(
      store.getState().flushDecisionsToDisk('team-a', 'agent-alice', 'retry-scope')
    ).resolves.toBe(false);

    // Retry deliberately snapshots live state again because a failed queued write is
    // discarded. This keeps the recovery source authoritative and avoids stale replay.
    store.getState().persistDecisions('team-a', 'agent-alice', 'retry-scope');
    await expect(
      store.getState().flushDecisionsToDisk('team-a', 'agent-alice', 'retry-scope')
    ).resolves.toBe(true);

    expect(hoisted.saveDecisions).toHaveBeenCalledTimes(2);
    expect(hoisted.saveDecisions).toHaveBeenLastCalledWith(
      'team-a',
      'agent-alice',
      'retry-scope',
      { '/repo/file.ts:0': 'accepted' },
      {},
      { '/repo/file.ts': {} },
      history,
      0,
      []
    );
    vi.mocked(console.error).mockClear();
  });

  it('hydrates a canonical suffix returned by a contained response-loss retry', async () => {
    const store = createSliceStore();
    const actionA = {
      id: 'accepted-a',
      createdAt: '2026-07-18T10:00:00.000Z',
      kind: 'hunk' as const,
      action: { filePath: '/repo/file.ts', originalIndex: 0 },
    };
    const actionB = {
      ...actionA,
      id: 'accepted-b',
      createdAt: '2026-07-18T10:00:01.000Z',
    };
    const actionC = {
      ...actionA,
      id: 'accepted-c',
      createdAt: '2026-07-18T10:00:02.000Z',
    };
    const scopeKey = 'team-a:agent-alice:response-loss-scope';
    store.setState({
      activeChangeSet: makeAgentChangeSet(),
      hunkDecisions: { '/repo/file.ts:0': 'accepted' },
      reviewActionHistory: [actionA],
      decisionHydrationScopeKey: scopeKey,
      decisionHydrationStatus: 'loaded',
    });
    store.getState().recordDecisionRevision('team-a', 'agent-alice', 'response-loss-scope', 0);
    hoisted.saveDecisions.mockResolvedValueOnce({
      revision: 2,
      reconciledState: {
        hunkDecisions: { '/repo/file.ts:0': 'accepted' },
        fileDecisions: {},
        hunkContextHashesByFile: { '/repo/file.ts': {} },
        reviewActionHistory: [actionA, actionB],
        reviewRedoHistory: [],
      },
    });

    store.getState().persistDecisions('team-a', 'agent-alice', 'response-loss-scope');
    await expect(
      store.getState().flushDecisionsToDisk('team-a', 'agent-alice', 'response-loss-scope')
    ).resolves.toBe(true);
    expect(store.getState()).toMatchObject({
      decisionRevision: 2,
      reviewActionHistory: [actionA, actionB],
    });

    store.setState({ reviewActionHistory: [actionA, actionB, actionC] });
    hoisted.saveDecisions.mockResolvedValueOnce({ revision: 3 });
    store.getState().persistDecisions('team-a', 'agent-alice', 'response-loss-scope');
    await expect(
      store.getState().flushDecisionsToDisk('team-a', 'agent-alice', 'response-loss-scope')
    ).resolves.toBe(true);
    expect(hoisted.saveDecisions).toHaveBeenLastCalledWith(
      'team-a',
      'agent-alice',
      'response-loss-scope',
      { '/repo/file.ts:0': 'accepted' },
      {},
      { '/repo/file.ts': {} },
      [actionA, actionB, actionC],
      2,
      []
    );
  });

  it('serializes a close flush behind an older in-flight decision write', async () => {
    vi.useFakeTimers();
    try {
      const firstWrite = deferred<{ revision: number }>();
      hoisted.saveDecisions
        .mockReturnValueOnce(firstWrite.promise)
        .mockResolvedValueOnce({ revision: 2 });
      const store = createSliceStore();
      store.setState({
        activeChangeSet: makeAgentChangeSet(),
        fileDecisions: { '/repo/file.ts': 'accepted' },
      });

      store.getState().persistDecisions('team-a', 'agent-alice', 'ordered-scope');
      await vi.advanceTimersByTimeAsync(500);
      expect(hoisted.saveDecisions).toHaveBeenCalledTimes(1);

      store.setState({ fileDecisions: { '/repo/file.ts': 'rejected' } });
      store.getState().persistDecisions('team-a', 'agent-alice', 'ordered-scope');
      const flush = store.getState().flushDecisionsToDisk('team-a', 'agent-alice', 'ordered-scope');
      await flushAsyncWork();
      expect(hoisted.saveDecisions).toHaveBeenCalledTimes(1);

      firstWrite.resolve({ revision: 1 });
      await expect(flush).resolves.toBe(true);
      expect(hoisted.saveDecisions).toHaveBeenCalledTimes(2);
      expect(hoisted.saveDecisions).toHaveBeenLastCalledWith(
        'team-a',
        'agent-alice',
        'ordered-scope',
        {},
        { '/repo/file.ts': 'rejected' },
        { '/repo/file.ts': {} },
        [],
        expect.any(Number),
        []
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('serializes decision clearing behind an older in-flight save', async () => {
    vi.useFakeTimers();
    try {
      const firstWrite = deferred<{ revision: number }>();
      hoisted.saveDecisions.mockReturnValueOnce(firstWrite.promise);
      hoisted.clearDecisions.mockResolvedValueOnce({ revision: 2 });
      const store = createSliceStore();
      store.setState({
        activeChangeSet: makeAgentChangeSet(),
        fileDecisions: { '/repo/file.ts': 'accepted' },
      });

      store.getState().persistDecisions('team-a', 'agent-alice', 'clear-scope');
      await vi.advanceTimersByTimeAsync(500);
      expect(hoisted.saveDecisions).toHaveBeenCalledTimes(1);

      const clear = store.getState().clearDecisionsFromDisk('team-a', 'agent-alice', 'clear-scope');
      await flushAsyncWork();
      expect(hoisted.clearDecisions).not.toHaveBeenCalled();

      firstWrite.resolve({ revision: 1 });
      await expect(clear).resolves.toBe(true);
      expect(hoisted.clearDecisions).toHaveBeenCalledWith(
        'team-a',
        'agent-alice',
        'clear-scope',
        1
      );
      expect(hoisted.saveDecisions.mock.invocationCallOrder[0]).toBeLessThan(
        hoisted.clearDecisions.mock.invocationCallOrder[0]
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('retries a failed decision clear from the same acknowledged revision', async () => {
    hoisted.clearDecisions
      .mockRejectedValueOnce(new Error('transient clear failure'))
      .mockResolvedValueOnce({ revision: 8 });
    const store = createSliceStore();
    store.getState().recordDecisionRevision('team-a', 'agent-alice', 'retry-clear', 7);

    await expect(
      store.getState().clearDecisionsFromDisk('team-a', 'agent-alice', 'retry-clear')
    ).resolves.toBe(false);
    vi.mocked(console.error).mockClear();
    await expect(
      store.getState().clearDecisionsFromDisk('team-a', 'agent-alice', 'retry-clear')
    ).resolves.toBe(true);

    expect(hoisted.clearDecisions).toHaveBeenNthCalledWith(
      1,
      'team-a',
      'agent-alice',
      'retry-clear',
      7
    );
    expect(hoisted.clearDecisions).toHaveBeenNthCalledWith(
      2,
      'team-a',
      'agent-alice',
      'retry-clear',
      7
    );
  });

  it('accepts only pending hunks and preserves rejected disk decisions', () => {
    const store = createSliceStore();
    store.setState({
      activeChangeSet: makeAgentChangeSet(),
      fileChunkCounts: { '/repo/file.ts': 3 },
      hunkDecisions: {
        '/repo/file.ts:0': 'rejected',
        '/repo/file.ts:1': 'accepted',
      },
      fileDecisions: {},
    });

    expect(store.getState().acceptAllFile('/repo/file.ts')).toBe(true);
    expect(store.getState().hunkDecisions).toEqual({
      '/repo/file.ts:0': 'rejected',
      '/repo/file.ts:1': 'accepted',
      '/repo/file.ts:2': 'accepted',
    });
    expect(store.getState().fileDecisions).toEqual({});
  });

  it('does not turn a rejected file back into accepted without undoing its disk mutation', () => {
    const store = createSliceStore();
    store.setState({
      activeChangeSet: makeAgentChangeSet(),
      fileChunkCounts: { '/repo/file.ts': 1 },
      hunkDecisions: { '/repo/file.ts:0': 'rejected' },
      fileDecisions: { '/repo/file.ts': 'rejected' },
    });

    expect(store.getState().acceptAllFile('/repo/file.ts')).toBe(false);
    expect(store.getState().hunkDecisions).toEqual({ '/repo/file.ts:0': 'rejected' });
    expect(store.getState().fileDecisions).toEqual({ '/repo/file.ts': 'rejected' });
  });

  it('accepts a reviewable file with no text chunks at file level', () => {
    const store = createSliceStore();
    store.setState({
      activeChangeSet: makeAgentChangeSet(),
      fileChunkCounts: { '/repo/file.ts': 0 },
      hunkDecisions: {},
      fileDecisions: {},
    });

    expect(store.getState().acceptAllFile('/repo/file.ts')).toBe(true);
    expect(store.getState().hunkDecisions).toEqual({});
    expect(store.getState().fileDecisions).toEqual({ '/repo/file.ts': 'accepted' });
  });

  it('preserves legacy path-keyed rejection when a ledger changeKey is present', () => {
    const store = createSliceStore();
    const changeSet = makeAgentChangeSet();
    const ledgerFile = { ...changeSet.files[0], changeKey: 'rename:old->new' };
    changeSet.files[0] = ledgerFile;
    store.setState({
      activeChangeSet: changeSet,
      fileChunkCounts: { '/repo/file.ts': 2 },
      hunkDecisions: { '/repo/file.ts:0': 'rejected' },
      fileDecisions: {},
    });

    expect(store.getState().acceptAllFile('/repo/file.ts')).toBe(true);
    expect(store.getState().hunkDecisions).toEqual({
      '/repo/file.ts:0': 'rejected',
      'rename:old->new:1': 'accepted',
    });
    expect(store.getState().fileDecisions).toEqual({});
  });
});
