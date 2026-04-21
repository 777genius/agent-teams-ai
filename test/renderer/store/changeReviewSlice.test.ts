import { beforeEach, describe, expect, it, vi } from 'vitest';
import { create } from 'zustand';

import { createChangeReviewSlice } from '../../../src/renderer/store/slices/changeReviewSlice';
import { buildTaskChangePresenceKey } from '../../../src/renderer/utils/taskChangeRequest';

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

function createSliceStore() {
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

  it('treats warning-only summaries as needs_attention and rechecks after invalidation', async () => {
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

    expect(store.getState().setSelectedTeamTaskChangePresence).toHaveBeenCalledWith(
      teamName,
      taskId,
      'needs_attention'
    );
    expect(store.getState().taskChangePresenceByKey[cacheKey]).toBe('needs_attention');

    store.getState().invalidateTaskChangePresence([cacheKey]);
    await store.getState().checkTaskHasChanges(teamName, taskId, OPTIONS_A);

    expect(hoisted.getTaskChanges).toHaveBeenCalledTimes(2);
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
    const first = deferred<any>();
    const second = deferred<any>();
    hoisted.getTaskChanges.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);

    const firstFetch = store.getState().fetchTaskChanges('team-a', '1', OPTIONS_A);
    const secondFetch = store.getState().fetchTaskChanges('team-a', '2', OPTIONS_B);

    second.resolve({
      teamName: 'team-a',
      taskId: '2',
      files: [{ filePath: '/repo/new.ts', relativePath: 'new.ts', snippets: [], linesAdded: 1, linesRemoved: 0, isNewFile: true }],
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
      files: [{ filePath: '/repo/old.ts', relativePath: 'old.ts', snippets: [], linesAdded: 1, linesRemoved: 0, isNewFile: true }],
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
    await store
      .getState()
      .warmTaskChangeSummaries([{ teamName, taskId, options: OPTIONS_A }]);

    expect(hoisted.getTaskChanges).toHaveBeenCalledTimes(3);
    expect(
      store.getState().taskChangePresenceByKey[
        buildTaskChangePresenceKey(teamName, taskId, OPTIONS_A)
      ]
    ).toBe('has_changes');
  });

  it('warms task summaries with bounded concurrency', async () => {
    const store = createSliceStore();
    const pending = Array.from({ length: 6 }, () => deferred<any>());
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

  it('ignores stale fetchFileContent responses after change-set replacement', async () => {
    const store = createSliceStore();
    const pending = deferred<any>();
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
    const pending = deferred<any>();
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
    const pending = deferred<any>();
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

  it('keeps restored file content when a stale fetch resolves after remove and re-add', async () => {
    const store = createSliceStore();
    const pending = deferred<any>();
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
    const fetchPending = deferred<any>();
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
    const savePromise = store.getState().saveEditedFile('/repo/file.ts');
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
    expect(store.getState().fileContents['/repo/file.ts']?.modifiedFullContent).toBe('saved-content');
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
      editedContents: { '/repo/new.ts': 'saved-content' },
      fileContentVersionByPath: {},
    });

    await store.getState().saveEditedFile('/repo/new.ts');

    expect(hoisted.saveEditedFile).toHaveBeenCalledWith('/repo/new.ts', 'saved-content', undefined);
    expect(store.getState().hunkContextHashesByFile).toEqual({});
    expect(store.getState().fileChunkCounts).toEqual({});
    expect(store.getState().fileContents['/repo/new.ts']?.modifiedFullContent).toBe('saved-content');
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
      reviewUndoStack: [{ hunkDecisions: { '/repo/file.ts:0': 'rejected' }, fileDecisions: { '/repo/file.ts': 'rejected' } }],
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
      decisions: [
        expect.objectContaining({
          filePath: '/repo/a.ts',
        }),
      ],
    });
    expect(store.getState().activeChangeSet).toEqual(current);
  });
});
