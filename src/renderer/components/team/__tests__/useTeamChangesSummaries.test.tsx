import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { TooltipProvider } from '@renderer/components/ui/tooltip';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { TEAM_CHANGES_LOAD_TIMEOUT_MS } from '../teamChangesLoadTimeout';
import { TeamChangesSection } from '../TeamChangesSection';
import { type TeamChangeSummaryState, useTeamChangesSummaries } from '../useTeamChangesSummaries';

import type {
  TaskChangeSetV2,
  TeamTaskChangeSummariesResponse,
  TeamTaskChangeSummaryRequest,
  TeamTaskWithKanban,
} from '@shared/types';

const hoisted = vi.hoisted(() => ({
  fetchConfig: vi.fn(),
  getTeamTaskChangeSummaries: vi.fn(),
  recordTaskChangePresence: vi.fn(),
  setSelectedTeamTaskChangePresence: vi.fn(),
}));

vi.mock('@renderer/api', () => ({
  api: {
    review: {
      getTeamTaskChangeSummaries: hoisted.getTeamTaskChangeSummaries,
    },
  },
}));

vi.mock('@renderer/store', () => ({
  useStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      appConfig: { general: { theme: 'dark' } },
      configLoading: false,
      fetchConfig: hoisted.fetchConfig,
      memberActivityMetaByTeam: {},
      recordTaskChangePresence: hoisted.recordTaskChangePresence,
      setSelectedTeamTaskChangePresence: hoisted.setSelectedTeamTaskChangePresence,
      selectedTeamData: null,
      selectedTeamName: undefined,
      teamDataCacheByName: {},
    }),
}));

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function task(overrides: Partial<TeamTaskWithKanban> = {}): TeamTaskWithKanban {
  return {
    id: 'task-1',
    subject: 'Task 1',
    status: 'completed',
    owner: 'alice',
    createdAt: '2026-05-10T10:00:00.000Z',
    updatedAt: '2026-05-10T10:00:00.000Z',
    changePresence: 'unknown',
    ...overrides,
  };
}

function changedTasks(count: number): TeamTaskWithKanban[] {
  return Array.from({ length: count }, (_, index) =>
    task({
      id: `changed-${index}`,
      subject: `Changed ${index}`,
      changePresence: 'has_changes',
      updatedAt: `2026-05-10T10:${String(index).padStart(2, '0')}:00.000Z`,
    })
  );
}

function changeSet(taskId = 'task-1'): TaskChangeSetV2 {
  return {
    teamName: 'team-a',
    taskId,
    files: [],
    totalFiles: 0,
    totalLinesAdded: 0,
    totalLinesRemoved: 0,
    confidence: 'high',
    computedAt: '2026-05-10T10:00:00.000Z',
    scope: {
      taskId,
      memberName: 'alice',
      startLine: 0,
      endLine: 0,
      startTimestamp: '2026-05-10T10:00:00.000Z',
      endTimestamp: '2026-05-10T10:01:00.000Z',
      toolUseIds: [],
      filePaths: [],
      confidence: { tier: 1, label: 'high', reason: 'test' },
    },
    warnings: [],
  };
}

function fileChange(
  overrides: Partial<TaskChangeSetV2['files'][number]> = {}
): TaskChangeSetV2['files'][number] {
  return {
    filePath: '/repo/src/app.ts',
    relativePath: 'src/app.ts',
    snippets: [],
    linesAdded: 1,
    linesRemoved: 0,
    isNewFile: false,
    ...overrides,
  };
}

function response(summary: TaskChangeSetV2 = changeSet()): TeamTaskChangeSummariesResponse {
  return {
    teamName: 'team-a',
    computedAt: '2026-05-10T10:00:01.000Z',
    items: [{ taskId: 'task-1', changeSet: summary }],
  };
}

function responseForRequests(
  requests: TeamTaskChangeSummaryRequest[]
): TeamTaskChangeSummariesResponse {
  return {
    teamName: 'team-a',
    computedAt: '2026-05-10T10:00:01.000Z',
    items: requests.map((request) => ({
      taskId: request.taskId,
      changeSet: changeSet(request.taskId),
    })),
  };
}

function malformedLegacyChangeSet(): TaskChangeSetV2 {
  return {
    ...changeSet(),
    files: undefined,
    scope: undefined,
    totalFiles: 1,
    warnings: ['legacy warning'],
  } as unknown as TaskChangeSetV2;
}

function malformedUnknownChangeSet(): TaskChangeSetV2 {
  return {
    ...changeSet(),
    confidence: 'fallback',
    files: undefined,
    warnings: undefined,
  } as unknown as TaskChangeSetV2;
}

function malformedResponse(): TeamTaskChangeSummariesResponse {
  return {
    teamName: 'team-a',
    computedAt: '2026-05-10T10:00:01.000Z',
    items: undefined,
  } as unknown as TeamTaskChangeSummariesResponse;
}

function malformedItemResponse(): TeamTaskChangeSummariesResponse {
  return {
    teamName: 'team-a',
    computedAt: '2026-05-10T10:00:01.000Z',
    items: [
      {
        taskId: ' task-1 ',
        changeSet: 'not-a-change-set',
        error: { message: 'not a string' },
      },
    ],
  } as unknown as TeamTaskChangeSummariesResponse;
}

function incompleteChangeSetResponse(): TeamTaskChangeSummariesResponse {
  return {
    teamName: 'team-a',
    computedAt: '2026-05-10T10:00:01.000Z',
    items: [
      {
        taskId: 'task-1',
        changeSet: {
          teamName: 'team-a',
          taskId: 'task-1',
          files: [],
          warnings: [],
          confidence: 'high',
        },
      },
    ],
  } as unknown as TeamTaskChangeSummariesResponse;
}

function quietNoLogChangeSet(): TaskChangeSetV2 {
  return {
    ...changeSet(),
    confidence: 'fallback',
    scope: {
      taskId: 'task-1',
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
  };
}

function lowConfidenceFileResponse(): TeamTaskChangeSummariesResponse {
  return response({
    ...changeSet(),
    confidence: 'low',
    files: [fileChange()],
    totalFiles: 1,
    totalLinesAdded: 1,
  });
}

function intervalScopedFileResponse(): TeamTaskChangeSummariesResponse {
  return response({
    ...changeSet(),
    confidence: 'medium',
    files: [
      fileChange({
        filePath: '/repo/791/calculator.js',
        relativePath: '791/calculator.js',
      }),
    ],
    totalFiles: 1,
    totalLinesAdded: 162,
    scope: {
      ...changeSet().scope,
      confidence: {
        tier: 2,
        label: 'medium',
        reason: 'Scoped by persisted task workIntervals (timestamp-based)',
      },
    },
    warnings: ['Task start boundary missing - scoped by persisted workIntervals timestamps.'],
  });
}

function warningFileResponse(): TeamTaskChangeSummariesResponse {
  return response({
    ...changeSet(),
    files: [fileChange()],
    totalFiles: 1,
    totalLinesAdded: 1,
    warnings: ['Unexpected ledger warning.'],
  });
}

function invalidFileSummaryResponse(): TeamTaskChangeSummariesResponse {
  return response({
    ...changeSet(),
    confidence: 'low',
    files: [{} as TaskChangeSetV2['files'][number]],
    totalFiles: 1,
    totalLinesAdded: 1,
  });
}

interface HookSnapshot {
  loading: boolean;
  refreshing: boolean;
  error: string | null;
  badgeCount: number | null;
  summariesByTaskId: Record<string, TeamChangeSummaryState>;
  refresh: () => void;
}

const HookHarness = ({
  tasks,
  sectionOpen = true,
  onSnapshot,
}: {
  tasks: TeamTaskWithKanban[];
  sectionOpen?: boolean;
  onSnapshot: (snapshot: HookSnapshot) => void;
}): null => {
  const state = useTeamChangesSummaries({
    teamName: 'team-a',
    tasks,
    sectionOpen,
  });
  React.useEffect(() => {
    onSnapshot({
      loading: state.loading,
      refreshing: state.refreshing,
      error: state.error,
      badgeCount: state.badgeCount,
      summariesByTaskId: state.summariesByTaskId,
      refresh: state.refresh,
    });
  }, [
    onSnapshot,
    state.badgeCount,
    state.error,
    state.loading,
    state.refresh,
    state.refreshing,
    state.summariesByTaskId,
  ]);
  return null;
};

describe('useTeamChangesSummaries', () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  afterEach(() => {
    if (root) {
      act(() => {
        root?.unmount();
      });
    }
    container?.remove();
    container = null;
    root = null;
    vi.clearAllMocks();
  });

  it('does not keep initial loading stuck when tasks change during an active request', async () => {
    const first = createDeferred<TeamTaskChangeSummariesResponse>();
    const second = createDeferred<TeamTaskChangeSummariesResponse>();
    hoisted.getTeamTaskChangeSummaries
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);

    const snapshots: HookSnapshot[] = [];
    const onSnapshot = (snapshot: HookSnapshot): void => {
      snapshots.push(snapshot);
    };
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    await act(async () => {
      root?.render(React.createElement(HookHarness, { tasks: [task()], onSnapshot }));
    });

    expect(snapshots.at(-1)?.loading).toBe(true);

    await act(async () => {
      root?.render(
        React.createElement(HookHarness, {
          tasks: [task({ updatedAt: '2026-05-10T10:00:02.000Z' })],
          onSnapshot,
        })
      );
    });

    await act(async () => {
      first.resolve(response());
      await first.promise;
    });

    expect(hoisted.getTeamTaskChangeSummaries).toHaveBeenCalledTimes(2);
    expect(snapshots.at(-1)?.loading).toBe(false);
    expect(snapshots.at(-1)?.refreshing).toBe(true);
  });

  it('does not cache a stale active response when a newer task snapshot is queued', async () => {
    const first = createDeferred<TeamTaskChangeSummariesResponse>();
    const second = createDeferred<TeamTaskChangeSummariesResponse>();
    hoisted.getTeamTaskChangeSummaries
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);

    const snapshots: HookSnapshot[] = [];
    const onSnapshot = (snapshot: HookSnapshot): void => {
      snapshots.push(snapshot);
    };
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    await act(async () => {
      root?.render(React.createElement(HookHarness, { tasks: [task()], onSnapshot }));
    });

    await act(async () => {
      root?.render(
        React.createElement(HookHarness, {
          tasks: [task({ updatedAt: '2026-05-10T10:00:02.000Z' })],
          onSnapshot,
        })
      );
    });

    await act(async () => {
      first.resolve(
        response({
          ...changeSet(),
          files: [fileChange({ filePath: '/repo/src/stale.ts', relativePath: 'src/stale.ts' })],
          totalFiles: 1,
          totalLinesAdded: 1,
        })
      );
      await first.promise;
    });

    expect(hoisted.getTeamTaskChangeSummaries).toHaveBeenCalledTimes(2);
    expect(hoisted.recordTaskChangePresence).not.toHaveBeenCalled();
    expect(snapshots.at(-1)?.summariesByTaskId).toEqual({});

    await act(async () => {
      second.resolve(response());
      await second.promise;
    });

    expect(hoisted.recordTaskChangePresence).toHaveBeenCalledWith(
      'team-a',
      'task-1',
      expect.any(Object),
      'no_changes'
    );
    expect(hoisted.setSelectedTeamTaskChangePresence).toHaveBeenCalledWith(
      'team-a',
      'task-1',
      'no_changes'
    );
  });

  it('retries the initial load after React StrictMode effect remount replay', async () => {
    const first = createDeferred<TeamTaskChangeSummariesResponse>();
    const second = createDeferred<TeamTaskChangeSummariesResponse>();
    hoisted.getTeamTaskChangeSummaries
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);

    const snapshots: HookSnapshot[] = [];
    const onSnapshot = (snapshot: HookSnapshot): void => {
      snapshots.push(snapshot);
    };
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    await act(async () => {
      root?.render(
        React.createElement(
          React.StrictMode,
          null,
          React.createElement(HookHarness, { tasks: [task()], onSnapshot })
        )
      );
    });

    expect(hoisted.getTeamTaskChangeSummaries).toHaveBeenCalledTimes(2);

    await act(async () => {
      first.resolve(response());
      await first.promise;
    });

    expect(snapshots.at(-1)?.loading).toBe(true);

    await act(async () => {
      second.resolve(response());
      await second.promise;
    });

    expect(snapshots.at(-1)?.loading).toBe(false);
    expect(snapshots.at(-1)?.summariesByTaskId['task-1']?.changeSet?.taskId).toBe('task-1');
  });

  it('clears initial loading and reports an error when the batch request times out', async () => {
    vi.useFakeTimers();
    try {
      hoisted.getTeamTaskChangeSummaries.mockReturnValue(new Promise(() => undefined));

      const snapshots: HookSnapshot[] = [];
      const onSnapshot = (snapshot: HookSnapshot): void => {
        snapshots.push(snapshot);
      };
      container = document.createElement('div');
      document.body.appendChild(container);
      root = createRoot(container);

      await act(async () => {
        root?.render(React.createElement(HookHarness, { tasks: [task()], onSnapshot }));
      });

      expect(snapshots.at(-1)?.loading).toBe(true);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(TEAM_CHANGES_LOAD_TIMEOUT_MS);
      });

      expect(snapshots.at(-1)?.loading).toBe(false);
      expect(snapshots.at(-1)?.refreshing).toBe(false);
      expect(snapshots.at(-1)?.error).toBe('Team changes request timed out. Refresh to try again.');
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not immediately run a queued refresh after a request failure', async () => {
    const first = createDeferred<TeamTaskChangeSummariesResponse>();
    hoisted.getTeamTaskChangeSummaries.mockReturnValue(first.promise);

    const snapshots: HookSnapshot[] = [];
    const onSnapshot = (snapshot: HookSnapshot): void => {
      snapshots.push(snapshot);
    };
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    await act(async () => {
      root?.render(React.createElement(HookHarness, { tasks: [task()], onSnapshot }));
    });

    await act(async () => {
      root?.render(
        React.createElement(HookHarness, {
          tasks: [task({ updatedAt: '2026-05-10T10:00:02.000Z' })],
          onSnapshot,
        })
      );
    });

    await act(async () => {
      first.reject(new Error('boom'));
      await first.promise.catch(() => undefined);
      await Promise.resolve();
    });

    expect(hoisted.getTeamTaskChangeSummaries).toHaveBeenCalledTimes(1);
    expect(snapshots.at(-1)?.loading).toBe(false);
    expect(snapshots.at(-1)?.refreshing).toBe(false);
    expect(snapshots.at(-1)?.error).toBe('boom');
  });

  it('clears loading and reports an error for a malformed batch response', async () => {
    hoisted.getTeamTaskChangeSummaries.mockResolvedValue(malformedResponse());

    const snapshots: HookSnapshot[] = [];
    const onSnapshot = (snapshot: HookSnapshot): void => {
      snapshots.push(snapshot);
    };
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    await act(async () => {
      root?.render(React.createElement(HookHarness, { tasks: [task()], onSnapshot }));
      await Promise.resolve();
    });

    expect(snapshots.at(-1)?.loading).toBe(false);
    expect(snapshots.at(-1)?.refreshing).toBe(false);
    expect(snapshots.at(-1)?.error).toBe('Team changes response was malformed.');
    expect(snapshots.at(-1)?.summariesByTaskId).toEqual({});
  });

  it('normalizes malformed batch response items before storing summaries', async () => {
    hoisted.getTeamTaskChangeSummaries.mockResolvedValue(malformedItemResponse());

    const snapshots: HookSnapshot[] = [];
    const onSnapshot = (snapshot: HookSnapshot): void => {
      snapshots.push(snapshot);
    };
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    await act(async () => {
      root?.render(React.createElement(HookHarness, { tasks: [task()], onSnapshot }));
      await Promise.resolve();
    });

    expect(snapshots.at(-1)?.error).toBeNull();
    expect(snapshots.at(-1)?.summariesByTaskId['task-1']).toEqual({
      taskId: 'task-1',
      changeSet: null,
    });
    expect(hoisted.recordTaskChangePresence).not.toHaveBeenCalled();
  });

  it('does not cache presence for incomplete change summaries', async () => {
    hoisted.getTeamTaskChangeSummaries.mockResolvedValue(incompleteChangeSetResponse());

    const snapshots: HookSnapshot[] = [];
    const onSnapshot = (snapshot: HookSnapshot): void => {
      snapshots.push(snapshot);
    };
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    await act(async () => {
      root?.render(React.createElement(HookHarness, { tasks: [task()], onSnapshot }));
      await Promise.resolve();
    });

    expect(snapshots.at(-1)?.loading).toBe(false);
    expect(snapshots.at(-1)?.summariesByTaskId['task-1']?.changeSet).not.toBeNull();
    expect(hoisted.recordTaskChangePresence).not.toHaveBeenCalled();
    expect(hoisted.setSelectedTeamTaskChangePresence).not.toHaveBeenCalled();
  });

  it('caches has_changes for low-confidence summaries with safe file details', async () => {
    hoisted.getTeamTaskChangeSummaries.mockResolvedValue(lowConfidenceFileResponse());

    const snapshots: HookSnapshot[] = [];
    const onSnapshot = (snapshot: HookSnapshot): void => {
      snapshots.push(snapshot);
    };
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    await act(async () => {
      root?.render(React.createElement(HookHarness, { tasks: [task()], onSnapshot }));
      await Promise.resolve();
    });

    expect(snapshots.at(-1)?.summariesByTaskId['task-1']?.changeSet?.confidence).toBe('low');
    expect(hoisted.recordTaskChangePresence).toHaveBeenCalledWith(
      'team-a',
      'task-1',
      expect.any(Object),
      'has_changes'
    );
    expect(hoisted.setSelectedTeamTaskChangePresence).toHaveBeenCalledWith(
      'team-a',
      'task-1',
      'has_changes'
    );
  });

  it('does not cache presence for summaries with unsafe file details', async () => {
    hoisted.getTeamTaskChangeSummaries.mockResolvedValue(invalidFileSummaryResponse());

    const snapshots: HookSnapshot[] = [];
    const onSnapshot = (snapshot: HookSnapshot): void => {
      snapshots.push(snapshot);
    };
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    await act(async () => {
      root?.render(React.createElement(HookHarness, { tasks: [task()], onSnapshot }));
      await Promise.resolve();
    });

    expect(snapshots.at(-1)?.summariesByTaskId['task-1']?.changeSet).not.toBeNull();
    expect(hoisted.recordTaskChangePresence).not.toHaveBeenCalled();
    expect(hoisted.setSelectedTeamTaskChangePresence).not.toHaveBeenCalled();
  });

  it('renders legacy malformed summaries without crashing the section', async () => {
    hoisted.getTeamTaskChangeSummaries.mockResolvedValue(response(malformedLegacyChangeSet()));

    const scrollIntoViewDescriptor = Object.getOwnPropertyDescriptor(
      Element.prototype,
      'scrollIntoView'
    );
    Object.defineProperty(Element.prototype, 'scrollIntoView', {
      configurable: true,
      value: vi.fn(),
    });
    try {
      container = document.createElement('div');
      document.body.appendChild(container);
      root = createRoot(container);

      await act(async () => {
        root?.render(
          React.createElement(
            TooltipProvider,
            null,
            React.createElement(TeamChangesSection, {
              teamName: 'team-a',
              tasks: [task()],
              onOpenTask: vi.fn(),
              onViewChanges: vi.fn(),
            })
          )
        );
      });

      const expandButton = container.querySelector<HTMLButtonElement>(
        'button[aria-label="Expand section"]'
      );
      expect(expandButton).not.toBeNull();

      await act(async () => {
        expandButton?.click();
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(container.textContent).toContain('legacy warning');
      expect(container.textContent).toContain(
        'The change summary reported one file without safe review details.'
      );
      expect(hoisted.recordTaskChangePresence).not.toHaveBeenCalled();
    } finally {
      if (scrollIntoViewDescriptor) {
        Object.defineProperty(Element.prototype, 'scrollIntoView', scrollIntoViewDescriptor);
      } else {
        delete (Element.prototype as { scrollIntoView?: Element['scrollIntoView'] }).scrollIntoView;
      }
    }
  });

  it('does not render active no-log summaries as Changes warnings', async () => {
    hoisted.getTeamTaskChangeSummaries.mockResolvedValue(response(quietNoLogChangeSet()));

    const scrollIntoViewDescriptor = Object.getOwnPropertyDescriptor(
      Element.prototype,
      'scrollIntoView'
    );
    Object.defineProperty(Element.prototype, 'scrollIntoView', {
      configurable: true,
      value: vi.fn(),
    });
    try {
      container = document.createElement('div');
      document.body.appendChild(container);
      root = createRoot(container);

      await act(async () => {
        root?.render(
          React.createElement(
            TooltipProvider,
            null,
            React.createElement(TeamChangesSection, {
              teamName: 'team-a',
              tasks: [task({ status: 'in_progress', changePresence: 'needs_attention' })],
              onOpenTask: vi.fn(),
              onViewChanges: vi.fn(),
            })
          )
        );
      });

      const expandButton = container.querySelector<HTMLButtonElement>(
        'button[aria-label="Expand section"]'
      );
      expect(expandButton).not.toBeNull();

      await act(async () => {
        expandButton?.click();
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(container.textContent).toContain('No file changes recorded');
      expect(container.textContent).not.toContain('No log files found for this task.');
      expect(hoisted.recordTaskChangePresence).not.toHaveBeenCalled();
      expect(hoisted.setSelectedTeamTaskChangePresence).toHaveBeenCalledWith(
        'team-a',
        'task-1',
        'unknown'
      );
    } finally {
      if (scrollIntoViewDescriptor) {
        Object.defineProperty(Element.prototype, 'scrollIntoView', scrollIntoViewDescriptor);
      } else {
        delete (Element.prototype as { scrollIntoView?: Element['scrollIntoView'] }).scrollIntoView;
      }
    }
  });

  it('hides work-interval scoping advisories in the compact Changes list when files are present', async () => {
    hoisted.getTeamTaskChangeSummaries.mockResolvedValue(intervalScopedFileResponse());

    const scrollIntoViewDescriptor = Object.getOwnPropertyDescriptor(
      Element.prototype,
      'scrollIntoView'
    );
    Object.defineProperty(Element.prototype, 'scrollIntoView', {
      configurable: true,
      value: vi.fn(),
    });
    try {
      container = document.createElement('div');
      document.body.appendChild(container);
      root = createRoot(container);

      await act(async () => {
        root?.render(
          React.createElement(
            TooltipProvider,
            null,
            React.createElement(TeamChangesSection, {
              teamName: 'team-a',
              tasks: [task({ status: 'completed', owner: 'jack' })],
              onOpenTask: vi.fn(),
              onViewChanges: vi.fn(),
            })
          )
        );
      });

      const expandButton = container.querySelector<HTMLButtonElement>(
        'button[aria-label="Expand section"]'
      );
      expect(expandButton).not.toBeNull();

      await act(async () => {
        expandButton?.click();
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(container.textContent).toContain('791/calculator.js');
      expect(container.textContent).not.toContain(
        'Task start boundary missing - scoped by persisted workIntervals timestamps.'
      );
    } finally {
      if (scrollIntoViewDescriptor) {
        Object.defineProperty(Element.prototype, 'scrollIntoView', scrollIntoViewDescriptor);
      } else {
        delete (Element.prototype as { scrollIntoView?: Element['scrollIntoView'] }).scrollIntoView;
      }
    }
  });

  it('keeps unrelated file warnings visible in the compact Changes list', async () => {
    hoisted.getTeamTaskChangeSummaries.mockResolvedValue(warningFileResponse());

    const scrollIntoViewDescriptor = Object.getOwnPropertyDescriptor(
      Element.prototype,
      'scrollIntoView'
    );
    Object.defineProperty(Element.prototype, 'scrollIntoView', {
      configurable: true,
      value: vi.fn(),
    });
    try {
      container = document.createElement('div');
      document.body.appendChild(container);
      root = createRoot(container);

      await act(async () => {
        root?.render(
          React.createElement(
            TooltipProvider,
            null,
            React.createElement(TeamChangesSection, {
              teamName: 'team-a',
              tasks: [task({ status: 'completed' })],
              onOpenTask: vi.fn(),
              onViewChanges: vi.fn(),
            })
          )
        );
      });

      const expandButton = container.querySelector<HTMLButtonElement>(
        'button[aria-label="Expand section"]'
      );
      expect(expandButton).not.toBeNull();

      await act(async () => {
        expandButton?.click();
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(container.textContent).toContain('src/app.ts');
      expect(container.textContent).toContain('Unexpected ledger warning.');
    } finally {
      if (scrollIntoViewDescriptor) {
        Object.defineProperty(Element.prototype, 'scrollIntoView', scrollIntoViewDescriptor);
      } else {
        delete (Element.prototype as { scrollIntoView?: Element['scrollIntoView'] }).scrollIntoView;
      }
    }
  });

  it('does not clear completed task presence from an uncertain empty summary', async () => {
    hoisted.getTeamTaskChangeSummaries.mockResolvedValue(response(quietNoLogChangeSet()));

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    await act(async () => {
      root?.render(
        React.createElement(HookHarness, {
          tasks: [task({ status: 'completed', changePresence: 'needs_attention' })],
          onSnapshot: vi.fn(),
        })
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(hoisted.recordTaskChangePresence).not.toHaveBeenCalled();
    expect(hoisted.setSelectedTeamTaskChangePresence).not.toHaveBeenCalled();
  });

  it('clears stale selected presence for newly created pending tasks without logs', async () => {
    hoisted.getTeamTaskChangeSummaries.mockResolvedValue(response(quietNoLogChangeSet()));

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    await act(async () => {
      root?.render(
        React.createElement(HookHarness, {
          tasks: [task({ status: 'pending', changePresence: 'needs_attention' })],
          onSnapshot: vi.fn(),
        })
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(hoisted.recordTaskChangePresence).not.toHaveBeenCalled();
    expect(hoisted.setSelectedTeamTaskChangePresence).toHaveBeenCalledWith(
      'team-a',
      'task-1',
      'unknown'
    );
  });

  it('uses the first duplicate task id when deciding whether to clear stale presence', async () => {
    hoisted.getTeamTaskChangeSummaries.mockResolvedValue(response(quietNoLogChangeSet()));

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    await act(async () => {
      root?.render(
        React.createElement(HookHarness, {
          tasks: [
            task({ status: 'completed', changePresence: 'needs_attention' }),
            task({ status: 'in_progress', changePresence: 'needs_attention' }),
          ],
          onSnapshot: vi.fn(),
        })
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(hoisted.recordTaskChangePresence).not.toHaveBeenCalled();
    expect(hoisted.setSelectedTeamTaskChangePresence).not.toHaveBeenCalled();
  });

  it('does not clear task presence from malformed unknown summaries', async () => {
    hoisted.getTeamTaskChangeSummaries.mockResolvedValue(response(malformedUnknownChangeSet()));

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    await act(async () => {
      root?.render(
        React.createElement(HookHarness, {
          tasks: [task({ status: 'in_progress', changePresence: 'needs_attention' })],
          onSnapshot: vi.fn(),
        })
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(hoisted.recordTaskChangePresence).not.toHaveBeenCalled();
    expect(hoisted.setSelectedTeamTaskChangePresence).not.toHaveBeenCalled();
  });

  it('shows the closed-section counter only after the background count load resolves', async () => {
    const deferred = createDeferred<TeamTaskChangeSummariesResponse>();
    hoisted.getTeamTaskChangeSummaries.mockReturnValue(deferred.promise);

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    await act(async () => {
      root?.render(
        React.createElement(
          TooltipProvider,
          null,
          React.createElement(TeamChangesSection, {
            teamName: 'team-a',
            tasks: [task()],
            onOpenTask: vi.fn(),
            onViewChanges: vi.fn(),
          })
        )
      );
    });

    expect(container.textContent).toContain('Changes');
    expect(container.textContent).not.toContain('0');
    expect(hoisted.getTeamTaskChangeSummaries).toHaveBeenCalledTimes(1);

    await act(async () => {
      deferred.resolve(response());
      await deferred.promise;
      await Promise.resolve();
    });

    expect(container.textContent).toContain('0');
  });

  it('loads the closed-section counter without rendering full change rows', async () => {
    hoisted.getTeamTaskChangeSummaries.mockResolvedValue(lowConfidenceFileResponse());

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    await act(async () => {
      root?.render(
        React.createElement(
          TooltipProvider,
          null,
          React.createElement(TeamChangesSection, {
            teamName: 'team-a',
            tasks: [task()],
            onOpenTask: vi.fn(),
            onViewChanges: vi.fn(),
          })
        )
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(hoisted.getTeamTaskChangeSummaries).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain('1');
    expect(container.textContent).not.toContain('src/app.ts');
  });

  it('counts files instead of changed tasks in the closed-section counter', async () => {
    hoisted.getTeamTaskChangeSummaries.mockImplementation(
      async (_teamName: string, requests: TeamTaskChangeSummaryRequest[]) => ({
        teamName: 'team-a',
        computedAt: '2026-05-10T10:00:01.000Z',
        items: requests.map((request, index) => {
          const totalFiles = index === 0 ? 3 : 4;
          return {
            taskId: request.taskId,
            changeSet: {
              ...changeSet(request.taskId),
              files: [
                fileChange({
                  filePath: `/repo/src/${request.taskId}.ts`,
                  relativePath: `src/${request.taskId}.ts`,
                }),
              ],
              totalFiles,
              totalLinesAdded: totalFiles,
            },
          };
        }),
      })
    );

    const snapshots: HookSnapshot[] = [];
    const onSnapshot = (snapshot: HookSnapshot): void => {
      snapshots.push(snapshot);
    };
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    await act(async () => {
      root?.render(
        React.createElement(HookHarness, {
          tasks: changedTasks(2),
          sectionOpen: false,
          onSnapshot,
        })
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(hoisted.getTeamTaskChangeSummaries).toHaveBeenCalledTimes(1);
    expect(snapshots.at(-1)?.badgeCount).toBe(7);
  });

  it('keeps the previous file counter for tasks whose summary refresh errors', async () => {
    const getTotalFilesForTaskId = (taskId: string): number => (taskId === 'changed-0' ? 3 : 4);

    hoisted.getTeamTaskChangeSummaries
      .mockImplementationOnce(
        async (_teamName: string, requests: TeamTaskChangeSummaryRequest[]) => ({
          teamName: 'team-a',
          computedAt: '2026-05-10T10:00:01.000Z',
          items: requests.map((request) => {
            const totalFiles = getTotalFilesForTaskId(request.taskId);
            return {
              taskId: request.taskId,
              changeSet: {
                ...changeSet(request.taskId),
                files: [
                  fileChange({
                    filePath: `/repo/src/${request.taskId}.ts`,
                    relativePath: `src/${request.taskId}.ts`,
                  }),
                ],
                totalFiles,
                totalLinesAdded: totalFiles,
              },
            };
          }),
        })
      )
      .mockImplementationOnce(
        async (_teamName: string, requests: TeamTaskChangeSummaryRequest[]) => ({
          teamName: 'team-a',
          computedAt: '2026-05-10T10:00:02.000Z',
          items: requests.map((request) =>
            request.taskId === 'changed-0'
              ? { taskId: request.taskId, changeSet: null, error: 'summary timed out' }
              : {
                  taskId: request.taskId,
                  changeSet: {
                    ...changeSet(request.taskId),
                    files: [
                      fileChange({
                        filePath: `/repo/src/${request.taskId}.ts`,
                        relativePath: `src/${request.taskId}.ts`,
                      }),
                    ],
                    totalFiles: 4,
                    totalLinesAdded: 4,
                  },
                }
          ),
        })
      );

    const snapshots: HookSnapshot[] = [];
    const onSnapshot = (snapshot: HookSnapshot): void => {
      snapshots.push(snapshot);
    };
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    const initialTasks = changedTasks(2);
    await act(async () => {
      root?.render(
        React.createElement(HookHarness, {
          tasks: initialTasks,
          sectionOpen: false,
          onSnapshot,
        })
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(snapshots.at(-1)?.badgeCount).toBe(7);

    await act(async () => {
      root?.render(
        React.createElement(HookHarness, {
          tasks: initialTasks.map((item) => ({
            ...item,
            updatedAt: '2026-05-10T10:05:00.000Z',
          })),
          sectionOpen: false,
          onSnapshot,
        })
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(hoisted.getTeamTaskChangeSummaries).toHaveBeenCalledTimes(2);
    expect(snapshots.at(-1)?.badgeCount).toBe(7);
  });

  it('loads staged open batches without repeating successful tasks', async () => {
    const first = createDeferred<TeamTaskChangeSummariesResponse>();
    const second = createDeferred<TeamTaskChangeSummariesResponse>();
    const third = createDeferred<TeamTaskChangeSummariesResponse>();
    hoisted.getTeamTaskChangeSummaries
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
      .mockReturnValueOnce(third.promise);

    const tasks = changedTasks(30);
    const snapshots: HookSnapshot[] = [];
    const onSnapshot = (snapshot: HookSnapshot): void => {
      snapshots.push(snapshot);
    };
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    await act(async () => {
      root?.render(React.createElement(HookHarness, { tasks, onSnapshot }));
    });

    expect(hoisted.getTeamTaskChangeSummaries).toHaveBeenCalledTimes(1);
    const firstRequests = hoisted.getTeamTaskChangeSummaries.mock
      .calls[0][1] as TeamTaskChangeSummaryRequest[];
    expect(firstRequests).toHaveLength(3);
    expect(firstRequests[0]?.taskId).toBe('changed-29');

    await act(async () => {
      first.resolve(responseForRequests(firstRequests));
      await first.promise;
      await Promise.resolve();
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(hoisted.getTeamTaskChangeSummaries).toHaveBeenCalledTimes(2);
    const secondRequests = hoisted.getTeamTaskChangeSummaries.mock
      .calls[1][1] as TeamTaskChangeSummaryRequest[];
    expect(secondRequests).toHaveLength(9);
    expect(Object.keys(snapshots.at(-1)?.summariesByTaskId ?? {})).toHaveLength(3);
    expect(snapshots.at(-1)?.loading).toBe(false);
    expect(snapshots.at(-1)?.refreshing).toBe(true);
    expect(
      secondRequests.some((request) =>
        firstRequests.some((firstRequest) => firstRequest.taskId === request.taskId)
      )
    ).toBe(false);

    await act(async () => {
      second.resolve(responseForRequests(secondRequests));
      await second.promise;
      await Promise.resolve();
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(hoisted.getTeamTaskChangeSummaries).toHaveBeenCalledTimes(3);
    const thirdRequests = hoisted.getTeamTaskChangeSummaries.mock
      .calls[2][1] as TeamTaskChangeSummaryRequest[];
    expect(thirdRequests).toHaveLength(18);
    expect(
      thirdRequests.some((request) =>
        [...firstRequests, ...secondRequests].some(
          (previousRequest) => previousRequest.taskId === request.taskId
        )
      )
    ).toBe(false);

    await act(async () => {
      third.resolve(responseForRequests(thirdRequests));
      await third.promise;
      await Promise.resolve();
    });

    expect(Object.keys(snapshots.at(-1)?.summariesByTaskId ?? {})).toHaveLength(30);
    expect(snapshots.at(-1)?.loading).toBe(false);
  });

  it('does not skip failed first-pass tasks from the queued full refresh', async () => {
    const first = createDeferred<TeamTaskChangeSummariesResponse>();
    const second = createDeferred<TeamTaskChangeSummariesResponse>();
    const third = createDeferred<TeamTaskChangeSummariesResponse>();
    hoisted.getTeamTaskChangeSummaries
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
      .mockReturnValueOnce(third.promise);

    const tasks = changedTasks(30);
    const snapshots: HookSnapshot[] = [];
    const onSnapshot = (snapshot: HookSnapshot): void => {
      snapshots.push(snapshot);
    };
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    await act(async () => {
      root?.render(React.createElement(HookHarness, { tasks, onSnapshot }));
    });

    const firstRequests = hoisted.getTeamTaskChangeSummaries.mock
      .calls[0][1] as TeamTaskChangeSummaryRequest[];
    expect(firstRequests).toHaveLength(3);
    const failedTaskId = firstRequests[0]?.taskId ?? '';

    await act(async () => {
      first.resolve({
        teamName: 'team-a',
        computedAt: '2026-05-10T10:00:01.000Z',
        items: firstRequests.map((request, index) =>
          index === 0
            ? { taskId: request.taskId, changeSet: null, error: 'first pass failed' }
            : { taskId: request.taskId, changeSet: changeSet(request.taskId) }
        ),
      });
      await first.promise;
      await Promise.resolve();
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(hoisted.getTeamTaskChangeSummaries).toHaveBeenCalledTimes(2);
    const secondRequests = hoisted.getTeamTaskChangeSummaries.mock
      .calls[1][1] as TeamTaskChangeSummaryRequest[];
    expect(secondRequests).toHaveLength(9);
    expect(secondRequests.some((request) => request.taskId === failedTaskId)).toBe(true);
    expect(secondRequests.some((request) => request.taskId === firstRequests[1]?.taskId)).toBe(
      false
    );

    await act(async () => {
      second.resolve(responseForRequests(secondRequests));
      await second.promise;
      await Promise.resolve();
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(hoisted.getTeamTaskChangeSummaries).toHaveBeenCalledTimes(3);
    const thirdRequests = hoisted.getTeamTaskChangeSummaries.mock
      .calls[2][1] as TeamTaskChangeSummaryRequest[];
    expect(thirdRequests).toHaveLength(19);

    await act(async () => {
      third.resolve(responseForRequests(thirdRequests));
      await third.promise;
      await Promise.resolve();
    });

    expect(Object.keys(snapshots.at(-1)?.summariesByTaskId ?? {})).toHaveLength(30);
  });

  it('does not apply staged in-flight results after the section closes', async () => {
    const first = createDeferred<TeamTaskChangeSummariesResponse>();
    const second = createDeferred<TeamTaskChangeSummariesResponse>();
    hoisted.getTeamTaskChangeSummaries
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);

    const tasks = changedTasks(30);
    const snapshots: HookSnapshot[] = [];
    const onSnapshot = (snapshot: HookSnapshot): void => {
      snapshots.push(snapshot);
    };
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    await act(async () => {
      root?.render(React.createElement(HookHarness, { tasks, onSnapshot }));
    });
    const firstRequests = hoisted.getTeamTaskChangeSummaries.mock
      .calls[0][1] as TeamTaskChangeSummaryRequest[];

    await act(async () => {
      first.resolve(responseForRequests(firstRequests));
      await first.promise;
      await Promise.resolve();
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(hoisted.getTeamTaskChangeSummaries).toHaveBeenCalledTimes(2);
    expect(Object.keys(snapshots.at(-1)?.summariesByTaskId ?? {})).toHaveLength(3);
    const secondRequests = hoisted.getTeamTaskChangeSummaries.mock
      .calls[1][1] as TeamTaskChangeSummaryRequest[];

    await act(async () => {
      root?.render(
        React.createElement(HookHarness, {
          tasks: [],
          sectionOpen: false,
          onSnapshot,
        })
      );
      await Promise.resolve();
    });

    await act(async () => {
      second.resolve(responseForRequests(secondRequests));
      await second.promise;
      await Promise.resolve();
    });

    expect(snapshots.at(-1)?.loading).toBe(false);
    expect(snapshots.at(-1)?.refreshing).toBe(false);
    expect(snapshots.at(-1)?.summariesByTaskId).toEqual({});
  });

  it('starts force refresh from the first staged batch after a completed staged load', async () => {
    const first = createDeferred<TeamTaskChangeSummariesResponse>();
    const second = createDeferred<TeamTaskChangeSummariesResponse>();
    const third = createDeferred<TeamTaskChangeSummariesResponse>();
    const fourth = createDeferred<TeamTaskChangeSummariesResponse>();
    hoisted.getTeamTaskChangeSummaries
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
      .mockReturnValueOnce(third.promise)
      .mockReturnValueOnce(fourth.promise);

    const tasks = changedTasks(30);
    const snapshots: HookSnapshot[] = [];
    const onSnapshot = (snapshot: HookSnapshot): void => {
      snapshots.push(snapshot);
    };
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    await act(async () => {
      root?.render(React.createElement(HookHarness, { tasks, onSnapshot }));
    });
    const firstRequests = hoisted.getTeamTaskChangeSummaries.mock
      .calls[0][1] as TeamTaskChangeSummaryRequest[];

    await act(async () => {
      first.resolve(responseForRequests(firstRequests));
      await first.promise;
      await Promise.resolve();
    });
    await act(async () => {
      await Promise.resolve();
    });
    const secondRequests = hoisted.getTeamTaskChangeSummaries.mock
      .calls[1][1] as TeamTaskChangeSummaryRequest[];
    await act(async () => {
      second.resolve(responseForRequests(secondRequests));
      await second.promise;
      await Promise.resolve();
    });
    await act(async () => {
      await Promise.resolve();
    });
    const thirdRequests = hoisted.getTeamTaskChangeSummaries.mock
      .calls[2][1] as TeamTaskChangeSummaryRequest[];
    await act(async () => {
      third.resolve(responseForRequests(thirdRequests));
      await third.promise;
      await Promise.resolve();
    });

    expect(Object.keys(snapshots.at(-1)?.summariesByTaskId ?? {})).toHaveLength(30);

    await act(async () => {
      snapshots.at(-1)?.refresh();
      await Promise.resolve();
    });

    expect(hoisted.getTeamTaskChangeSummaries).toHaveBeenCalledTimes(4);
    const refreshRequests = hoisted.getTeamTaskChangeSummaries.mock
      .calls[3][1] as TeamTaskChangeSummaryRequest[];
    expect(refreshRequests).toHaveLength(3);
    expect(refreshRequests.map((request) => request.taskId)).toEqual(
      firstRequests.map((request) => request.taskId)
    );
    expect(refreshRequests.every((request) => request.options?.forceFresh === true)).toBe(true);

    await act(async () => {
      fourth.resolve(responseForRequests(refreshRequests));
      await fourth.promise;
      await Promise.resolve();
    });
  });

  it('runs a queued closed counter refresh when tasks change during an active count load', async () => {
    const first = createDeferred<TeamTaskChangeSummariesResponse>();
    const second = createDeferred<TeamTaskChangeSummariesResponse>();
    hoisted.getTeamTaskChangeSummaries
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    await act(async () => {
      root?.render(
        React.createElement(
          TooltipProvider,
          null,
          React.createElement(TeamChangesSection, {
            teamName: 'team-a',
            tasks: [task()],
            onOpenTask: vi.fn(),
            onViewChanges: vi.fn(),
          })
        )
      );
    });

    expect(hoisted.getTeamTaskChangeSummaries).toHaveBeenCalledTimes(1);

    await act(async () => {
      root?.render(
        React.createElement(
          TooltipProvider,
          null,
          React.createElement(TeamChangesSection, {
            teamName: 'team-a',
            tasks: [task({ updatedAt: '2026-05-10T10:00:02.000Z' })],
            onOpenTask: vi.fn(),
            onViewChanges: vi.fn(),
          })
        )
      );
    });

    await act(async () => {
      first.resolve(lowConfidenceFileResponse());
      await first.promise;
      await Promise.resolve();
    });

    expect(hoisted.getTeamTaskChangeSummaries).toHaveBeenCalledTimes(2);

    await act(async () => {
      second.resolve(response());
      await second.promise;
      await Promise.resolve();
    });

    expect(container.textContent).toContain('0');
  });

  it('starts the full load immediately when opening during an active count load', async () => {
    const first = createDeferred<TeamTaskChangeSummariesResponse>();
    const second = createDeferred<TeamTaskChangeSummariesResponse>();
    hoisted.getTeamTaskChangeSummaries
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);

    const scrollIntoViewDescriptor = Object.getOwnPropertyDescriptor(
      Element.prototype,
      'scrollIntoView'
    );
    Object.defineProperty(Element.prototype, 'scrollIntoView', {
      configurable: true,
      value: vi.fn(),
    });
    try {
      container = document.createElement('div');
      document.body.appendChild(container);
      root = createRoot(container);

      await act(async () => {
        root?.render(
          React.createElement(
            TooltipProvider,
            null,
            React.createElement(TeamChangesSection, {
              teamName: 'team-a',
              tasks: [task()],
              onOpenTask: vi.fn(),
              onViewChanges: vi.fn(),
            })
          )
        );
      });

      const expandButton = container.querySelector<HTMLButtonElement>(
        'button[aria-label="Expand section"]'
      );
      expect(expandButton).not.toBeNull();

      await act(async () => {
        expandButton?.click();
      });

      expect(container.textContent).toContain('Loading changes...');
      expect(hoisted.getTeamTaskChangeSummaries).toHaveBeenCalledTimes(2);

      await act(async () => {
        first.resolve(lowConfidenceFileResponse());
        await first.promise;
        await Promise.resolve();
      });

      expect(container.textContent).toContain('Loading changes...');
      expect(container.textContent).not.toContain('src/app.ts');
      expect(hoisted.getTeamTaskChangeSummaries).toHaveBeenCalledTimes(2);

      await act(async () => {
        second.resolve(lowConfidenceFileResponse());
        await second.promise;
        await Promise.resolve();
      });

      expect(container.textContent).toContain('src/app.ts');
    } finally {
      if (scrollIntoViewDescriptor) {
        Object.defineProperty(Element.prototype, 'scrollIntoView', scrollIntoViewDescriptor);
      } else {
        delete (Element.prototype as { scrollIntoView?: Element['scrollIntoView'] }).scrollIntoView;
      }
    }
  });

  it('opens the task popup from summary header and keeps diff on the review action', async () => {
    const taskItem = task({ changePresence: 'has_changes' });
    const onOpenTask = vi.fn();
    const onViewChanges = vi.fn();
    hoisted.getTeamTaskChangeSummaries.mockResolvedValue(lowConfidenceFileResponse());

    const scrollIntoViewDescriptor = Object.getOwnPropertyDescriptor(
      Element.prototype,
      'scrollIntoView'
    );
    Object.defineProperty(Element.prototype, 'scrollIntoView', {
      configurable: true,
      value: vi.fn(),
    });
    try {
      container = document.createElement('div');
      document.body.appendChild(container);
      root = createRoot(container);

      await act(async () => {
        root?.render(
          React.createElement(
            TooltipProvider,
            null,
            React.createElement(TeamChangesSection, {
              teamName: 'team-a',
              tasks: [taskItem],
              memberColorMap: new Map([['alice', 'blue']]),
              onOpenTask,
              onViewChanges,
            })
          )
        );
      });

      const expandButton = container.querySelector<HTMLButtonElement>(
        'button[aria-label="Expand section"]'
      );
      expect(expandButton).not.toBeNull();

      await act(async () => {
        expandButton?.click();
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(container.querySelector('img')).not.toBeNull();

      const openTaskButton = container.querySelector<HTMLButtonElement>(
        'button[aria-label="Open task Task 1"]'
      );
      expect(openTaskButton).not.toBeNull();

      await act(async () => {
        openTaskButton?.click();
      });

      expect(onOpenTask).toHaveBeenCalledWith(taskItem);
      expect(onViewChanges).not.toHaveBeenCalled();

      const reviewTaskDiffButton = container.querySelector<HTMLButtonElement>(
        'button[aria-label="Review task diff"]'
      );
      expect(reviewTaskDiffButton).not.toBeNull();

      await act(async () => {
        reviewTaskDiffButton?.click();
      });

      expect(onViewChanges).toHaveBeenCalledWith('task-1');

      onViewChanges.mockClear();

      const fileRow = container.querySelector<HTMLElement>('[role="button"][title="src/app.ts"]');
      expect(fileRow).not.toBeNull();

      await act(async () => {
        fileRow?.click();
      });

      expect(onViewChanges).toHaveBeenCalledTimes(1);
      expect(onViewChanges).toHaveBeenCalledWith('task-1', '/repo/src/app.ts');

      onViewChanges.mockClear();

      const reviewFileDiffButton = container.querySelector<HTMLButtonElement>(
        'button[aria-label="Review diff"]'
      );
      expect(reviewFileDiffButton).not.toBeNull();

      await act(async () => {
        reviewFileDiffButton?.click();
      });

      expect(onViewChanges).toHaveBeenCalledTimes(1);
      expect(onViewChanges).toHaveBeenCalledWith('task-1', '/repo/src/app.ts');
    } finally {
      if (scrollIntoViewDescriptor) {
        Object.defineProperty(Element.prototype, 'scrollIntoView', scrollIntoViewDescriptor);
      } else {
        delete (Element.prototype as { scrollIntoView?: Element['scrollIntoView'] }).scrollIntoView;
      }
    }
  });
});
