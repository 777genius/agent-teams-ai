import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { TaskLogsPanel } from '../../../../../src/renderer/components/team/taskLogs/TaskLogsPanel';

import type { TeamChangeEvent } from '../../../../../src/shared/types';
import type { TeamTaskWithKanban } from '../../../../../src/shared/types';

const apiState = {
  onTeamChange: vi.fn<(callback: (event: unknown, data: TeamChangeEvent) => void) => () => void>(),
  getTaskLogStreamSummary: vi.fn<
    (teamName: string, taskId: string) => Promise<{ segmentCount: number }>
  >(),
  setTaskLogStreamTracking: vi.fn<(teamName: string, enabled: boolean) => Promise<void>>(),
};

vi.mock('@renderer/api', () => ({
  api: {
    teams: {
      onTeamChange: (...args: Parameters<typeof apiState.onTeamChange>) =>
        apiState.onTeamChange(...args),
      getTaskLogStreamSummary: (...args: Parameters<typeof apiState.getTaskLogStreamSummary>) =>
        apiState.getTaskLogStreamSummary(...args),
      setTaskLogStreamTracking: (...args: Parameters<typeof apiState.setTaskLogStreamTracking>) =>
        apiState.setTaskLogStreamTracking(...args),
    },
  },
}));

const featureGateState = {
  activityEnabled: true,
  exactLogsEnabled: true,
};

const taskActivityProps = vi.hoisted(() => ({
  calls: [] as Array<Record<string, unknown>>,
}));

vi.mock('../../../../../src/renderer/components/team/taskLogs/TaskActivitySection', () => ({
  TaskActivitySection: (props: Record<string, unknown>) => {
    taskActivityProps.calls.push(props);
    return React.createElement('div', { 'data-testid': 'task-activity' }, 'activity');
  },
}));

const taskLogStreamProps = vi.hoisted(() => ({
  calls: [] as Array<Record<string, unknown>>,
}));

const executionSessionsProps = vi.hoisted(() => ({
  calls: [] as Array<Record<string, unknown>>,
}));

vi.mock('../../../../../src/renderer/components/team/taskLogs/TaskLogStreamSection', () => ({
  TaskLogStreamSection: (props: Record<string, unknown>) => {
    taskLogStreamProps.calls.push(props);
    return React.createElement('div', { 'data-testid': 'task-log-stream' }, 'stream');
  },
}));

vi.mock('../../../../../src/renderer/components/team/taskLogs/ExecutionSessionsSection', () => ({
  ExecutionSessionsSection: (props: Record<string, unknown>) => {
    executionSessionsProps.calls.push(props);
    return React.createElement('div', { 'data-testid': 'execution-sessions' }, 'sessions');
  },
}));

vi.mock('../../../../../src/renderer/components/team/taskLogs/featureGates', () => ({
  isBoardTaskActivityUiEnabled: () => featureGateState.activityEnabled,
  isBoardTaskExactLogsUiEnabled: () => featureGateState.exactLogsEnabled,
}));

vi.mock('../../../../../src/renderer/components/ui/tabs', async () => {
  const ReactModule = await import('react');
  const TabsContext = ReactModule.createContext<{
    value: string;
    onValueChange: (value: string) => void;
  } | null>(null);

  return {
    Tabs: ({
      value,
      onValueChange,
      children,
    }: {
      value: string;
      onValueChange: (value: string) => void;
      children: React.ReactNode;
    }) =>
      ReactModule.createElement(
        TabsContext.Provider,
        { value: { value, onValueChange } },
        children
      ),
    TabsList: ({ children }: { children: React.ReactNode }) =>
      ReactModule.createElement('div', null, children),
    TabsTrigger: ({
      value,
      children,
    }: {
      value: string;
      children: React.ReactNode;
    }) => {
      const context = ReactModule.useContext(TabsContext);
      return ReactModule.createElement(
        'button',
        {
          type: 'button',
          'data-state': context?.value === value ? 'active' : 'inactive',
          onClick: () => context?.onValueChange(value),
        },
        children
      );
    },
    TabsContent: ({
      value,
      children,
    }: {
      value: string;
      children: React.ReactNode;
      className?: string;
    }) => {
      const context = ReactModule.useContext(TabsContext);
      if (context?.value !== value) {
        return null;
      }
      return ReactModule.createElement('div', { 'data-state': 'active' }, children);
    },
  };
});

function flushMicrotasks(): Promise<void> {
  return Promise.resolve();
}

function findTabButton(host: HTMLElement, label: string): HTMLButtonElement | null {
  return (
    Array.from(host.querySelectorAll('button')).find((button) => button.textContent?.includes(label)) ??
    null
  ) as HTMLButtonElement | null;
}

function makeTask(overrides: Partial<TeamTaskWithKanban> = {}): TeamTaskWithKanban {
  return {
    id: 'task-1',
    displayId: 'abc12345',
    teamName: 'demo',
    subject: 'Test task',
    description: '',
    status: 'in_progress',
    owner: 'bob',
    createdAt: '2026-04-13T10:00:00.000Z',
    updatedAt: '2026-04-13T10:05:00.000Z',
    reviewState: 'none',
    reviewNotes: [],
    blockedBy: [],
    blocks: [],
    comments: [],
    attachments: [],
    workIntervals: [],
    kanbanColumnId: null,
    ...overrides,
  } as TeamTaskWithKanban;
}

describe('TaskLogsPanel', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    featureGateState.activityEnabled = true;
    featureGateState.exactLogsEnabled = true;
    taskActivityProps.calls = [];
    taskLogStreamProps.calls = [];
    executionSessionsProps.calls = [];
    apiState.onTeamChange.mockReset();
    apiState.getTaskLogStreamSummary.mockReset();
    apiState.setTaskLogStreamTracking.mockReset();
    apiState.getTaskLogStreamSummary.mockResolvedValue({ segmentCount: 0 });
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('defaults to Task Log Stream and switches between the three tabs', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(React.createElement(TaskLogsPanel, { teamName: 'demo', task: makeTask() }));
      await flushMicrotasks();
    });

    expect(host.textContent).toContain('Task Log Stream');
    expect(host.textContent).toContain('Task Activity');
    expect(host.textContent).toContain('Execution Sessions');
    expect(findTabButton(host, 'Task Log Stream')?.getAttribute('data-state')).toBe('active');
    expect(host.querySelector('[data-testid="task-log-stream"]')).not.toBeNull();
    expect(taskLogStreamProps.calls.at(-1)).toMatchObject({
      teamName: 'demo',
      taskId: 'task-1',
      taskStatus: 'in_progress',
      liveEnabled: true,
    });

    const activityTab = findTabButton(host, 'Task Activity');
    expect(activityTab).not.toBeNull();

    await act(async () => {
      activityTab?.click();
      await flushMicrotasks();
    });

    expect(findTabButton(host, 'Task Activity')?.getAttribute('data-state')).toBe('active');
    expect(host.querySelector('[data-testid="task-activity"]')).not.toBeNull();
    expect(taskActivityProps.calls.at(-1)).toMatchObject({
      teamName: 'demo',
      taskId: 'task-1',
      enabled: true,
    });

    const sessionsTab = findTabButton(host, 'Execution Sessions');
    expect(sessionsTab).not.toBeNull();

    await act(async () => {
      sessionsTab?.click();
      await flushMicrotasks();
    });

    expect(findTabButton(host, 'Execution Sessions')?.getAttribute('data-state')).toBe('active');
    expect(host.querySelector('[data-testid="execution-sessions"]')).not.toBeNull();
    expect(executionSessionsProps.calls.at(-1)).toMatchObject({
      teamName: 'demo',
      taskId: 'task-1',
      enabled: true,
    });

    await act(async () => {
      root.unmount();
      await flushMicrotasks();
    });
  });

  it('falls back to Task Activity when Task Log Stream is disabled', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    featureGateState.exactLogsEnabled = false;
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(React.createElement(TaskLogsPanel, { teamName: 'demo', task: makeTask() }));
      await flushMicrotasks();
    });

    expect(host.querySelector('[data-testid="task-log-stream"]')).toBeNull();
    expect(findTabButton(host, 'Task Activity')?.getAttribute('data-state')).toBe('active');
    expect(host.querySelector('[data-testid="task-activity"]')).not.toBeNull();
    expect(host.textContent).not.toContain('Task Log Stream');
    expect(apiState.setTaskLogStreamTracking).not.toHaveBeenCalled();
    expect(apiState.onTeamChange).not.toHaveBeenCalled();

    await act(async () => {
      root.unmount();
      await flushMicrotasks();
    });
  });

  it('does not mount Task Activity content while the section is collapsed and stream is disabled', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    featureGateState.exactLogsEnabled = false;

    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        React.createElement(TaskLogsPanel, {
          teamName: 'demo',
          task: makeTask(),
          isOpen: false,
        })
      );
      await flushMicrotasks();
    });

    expect(host.querySelector('[data-testid="task-log-stream"]')).toBeNull();
    expect(host.querySelector('[data-testid="task-activity"]')).toBeNull();
    expect(taskLogStreamProps.calls).toHaveLength(0);
    expect(apiState.setTaskLogStreamTracking).not.toHaveBeenCalled();
    expect(apiState.onTeamChange).not.toHaveBeenCalled();

    await act(async () => {
      root.unmount();
      await flushMicrotasks();
    });
  });

  it('keeps task-log tracking active across tab switches and pulses on matching live updates', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.useFakeTimers();

    const activityStates: boolean[] = [];
    let handler: ((event: unknown, data: TeamChangeEvent) => void) | null = null;
    apiState.onTeamChange.mockImplementation((callback) => {
      handler = callback;
      return () => {
        handler = null;
      };
    });

    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        React.createElement(TaskLogsPanel, {
          teamName: 'demo',
          task: makeTask(),
          onTaskLogActivityChange: (isActive: boolean) => activityStates.push(isActive),
        })
      );
      await flushMicrotasks();
    });

    expect(apiState.setTaskLogStreamTracking).toHaveBeenCalledTimes(1);
    expect(apiState.setTaskLogStreamTracking).toHaveBeenCalledWith('demo', true);
    expect(handler).toBeTypeOf('function');
    expect(activityStates).toEqual([false]);

    const activityTab = findTabButton(host, 'Task Activity');
    expect(activityTab).not.toBeNull();

    await act(async () => {
      activityTab?.click();
      await flushMicrotasks();
    });

    expect(apiState.setTaskLogStreamTracking).toHaveBeenCalledTimes(1);

    await act(async () => {
      handler?.(null, {
        teamName: 'other-team',
        type: 'task-log-change',
        taskId: 'task-1',
        taskSignalKind: 'log',
      });
      handler?.(null, {
        teamName: 'demo',
        type: 'task-log-change',
        taskId: 'task-2',
        taskSignalKind: 'log',
      });
      handler?.(null, {
        teamName: 'demo',
        type: 'task-log-change',
        taskId: 'task-1',
        taskSignalKind: 'change',
      });
      await flushMicrotasks();
    });

    expect(activityStates).toEqual([false]);

    await act(async () => {
      handler?.(null, {
        teamName: 'demo',
        type: 'task-log-change',
        taskId: 'task-1',
        taskSignalKind: 'log',
      });
      await flushMicrotasks();
    });

    expect(activityStates).toEqual([false, true]);

    await act(async () => {
      vi.advanceTimersByTime(1800);
      await flushMicrotasks();
    });

    expect(activityStates).toEqual([false, true, false]);

    await act(async () => {
      root.unmount();
      await flushMicrotasks();
    });

    expect(apiState.setTaskLogStreamTracking).toHaveBeenLastCalledWith('demo', false);
  });

  it('tracks header activity while collapsed but defers Task Log Stream content until first open', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.useFakeTimers();

    const activityStates: boolean[] = [];
    const onTaskLogActivityChange = (isActive: boolean): void => {
      activityStates.push(isActive);
    };
    let handler: ((event: unknown, data: TeamChangeEvent) => void) | null = null;
    apiState.onTeamChange.mockImplementation((callback) => {
      handler = callback;
      return () => {
        handler = null;
      };
    });

    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        React.createElement(TaskLogsPanel, {
          teamName: 'demo',
          task: makeTask(),
          isOpen: false,
          onTaskLogActivityChange,
        })
      );
      await flushMicrotasks();
    });

    expect(host.querySelector('[data-testid="task-log-stream"]')).toBeNull();
    expect(taskLogStreamProps.calls).toHaveLength(0);
    expect(apiState.getTaskLogStreamSummary).not.toHaveBeenCalled();
    expect(apiState.setTaskLogStreamTracking).toHaveBeenCalledWith('demo', true);
    expect(apiState.onTeamChange).toHaveBeenCalledTimes(1);
    expect(handler).toBeTypeOf('function');
    expect(activityStates).toEqual([false]);

    await act(async () => {
      handler?.(null, {
        teamName: 'demo',
        type: 'task-log-change',
        taskId: 'task-1',
        taskSignalKind: 'log',
      });
      await flushMicrotasks();
    });

    expect(activityStates).toEqual([false, true]);
    expect(apiState.getTaskLogStreamSummary).not.toHaveBeenCalled();

    await act(async () => {
      vi.advanceTimersByTime(1800);
      await flushMicrotasks();
    });

    expect(activityStates).toEqual([false, true, false]);

    await act(async () => {
      root.render(
        React.createElement(TaskLogsPanel, {
          teamName: 'demo',
          task: makeTask(),
          isOpen: true,
          onTaskLogActivityChange,
        })
      );
      await flushMicrotasks();
      await flushMicrotasks();
    });

    expect(host.querySelector('[data-testid="task-log-stream"]')).not.toBeNull();
    expect(apiState.getTaskLogStreamSummary).toHaveBeenCalledWith('demo', 'task-1');
    expect(handler).toBeTypeOf('function');

    await act(async () => {
      handler?.(null, {
        teamName: 'demo',
        type: 'task-log-change',
        taskId: 'task-1',
        taskSignalKind: 'log',
      });
      await flushMicrotasks();
    });

    expect(activityStates).toEqual([false, true, false, true]);

    await act(async () => {
      vi.advanceTimersByTime(1800);
      await flushMicrotasks();
    });

    expect(activityStates).toEqual([false, true, false, true, false]);

    await act(async () => {
      root.unmount();
      await flushMicrotasks();
    });

    expect(apiState.setTaskLogStreamTracking).toHaveBeenLastCalledWith('demo', false);
  });

  it('pauses mounted activity and sessions tabs when the section collapses', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);

    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(React.createElement(TaskLogsPanel, { teamName: 'demo', task: makeTask() }));
      await flushMicrotasks();
    });

    const activityTab = findTabButton(host, 'Task Activity');
    expect(activityTab).not.toBeNull();

    await act(async () => {
      activityTab?.click();
      await flushMicrotasks();
    });

    expect(taskActivityProps.calls.at(-1)).toMatchObject({ enabled: true });

    await act(async () => {
      root.render(
        React.createElement(TaskLogsPanel, {
          teamName: 'demo',
          task: makeTask(),
          isOpen: false,
        })
      );
      await flushMicrotasks();
    });

    expect(taskActivityProps.calls.at(-1)).toMatchObject({ enabled: false });

    const sessionsTab = findTabButton(host, 'Execution Sessions');
    expect(sessionsTab).not.toBeNull();

    await act(async () => {
      root.render(React.createElement(TaskLogsPanel, { teamName: 'demo', task: makeTask() }));
      sessionsTab?.click();
      await flushMicrotasks();
    });

    expect(executionSessionsProps.calls.at(-1)).toMatchObject({ enabled: true });

    await act(async () => {
      root.render(
        React.createElement(TaskLogsPanel, {
          teamName: 'demo',
          task: makeTask(),
          isOpen: false,
        })
      );
      await flushMicrotasks();
    });

    expect(executionSessionsProps.calls.at(-1)).toMatchObject({ enabled: false });

    await act(async () => {
      root.unmount();
      await flushMicrotasks();
    });
  });

  it('loads task log count for the header badge and refreshes it on matching live updates', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.useFakeTimers();

    const counts: Array<number | undefined> = [];
    let handler: ((event: unknown, data: TeamChangeEvent) => void) | null = null;
    apiState.onTeamChange.mockImplementation((callback) => {
      handler = callback;
      return () => {
        handler = null;
      };
    });
    apiState.getTaskLogStreamSummary
      .mockResolvedValueOnce({ segmentCount: 4 })
      .mockResolvedValueOnce({ segmentCount: 5 });

    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        React.createElement(TaskLogsPanel, {
          teamName: 'demo',
          task: makeTask(),
          onTaskLogCountChange: (count) => counts.push(count),
        })
      );
      await flushMicrotasks();
    });

    expect(apiState.getTaskLogStreamSummary).toHaveBeenCalledWith('demo', 'task-1');
    expect(counts).toEqual([undefined, 4]);

    await act(async () => {
      handler?.(null, {
        teamName: 'demo',
        type: 'task-log-change',
        taskId: 'task-1',
        taskSignalKind: 'log',
      });
      vi.advanceTimersByTime(350);
      await flushMicrotasks();
    });

    expect(apiState.getTaskLogStreamSummary).toHaveBeenCalledTimes(2);
    expect(counts).toEqual([undefined, 4, 5]);

    await act(async () => {
      root.unmount();
      await flushMicrotasks();
    });
  });
});
