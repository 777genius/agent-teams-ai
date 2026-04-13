import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { TaskLogsPanel } from '../../../../../src/renderer/components/team/taskLogs/TaskLogsPanel';

import type { TeamTaskWithKanban } from '../../../../../src/shared/types';

const featureGateState = {
  activityEnabled: true,
  exactLogsEnabled: true,
};

vi.mock('../../../../../src/renderer/components/team/taskLogs/TaskActivitySection', () => ({
  TaskActivitySection: () => React.createElement('div', { 'data-testid': 'task-activity' }, 'activity'),
}));

vi.mock('../../../../../src/renderer/components/team/taskLogs/TaskLogStreamSection', () => ({
  TaskLogStreamSection: () =>
    React.createElement('div', { 'data-testid': 'task-log-stream' }, 'stream'),
}));

vi.mock('../../../../../src/renderer/components/team/taskLogs/ExecutionSessionsSection', () => ({
  ExecutionSessionsSection: () =>
    React.createElement('div', { 'data-testid': 'execution-sessions' }, 'sessions'),
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

    const activityTab = findTabButton(host, 'Task Activity');
    expect(activityTab).not.toBeNull();

    await act(async () => {
      activityTab?.click();
      await flushMicrotasks();
    });

    expect(findTabButton(host, 'Task Activity')?.getAttribute('data-state')).toBe('active');
    expect(host.querySelector('[data-testid="task-activity"]')).not.toBeNull();

    const sessionsTab = findTabButton(host, 'Execution Sessions');
    expect(sessionsTab).not.toBeNull();

    await act(async () => {
      sessionsTab?.click();
      await flushMicrotasks();
    });

    expect(findTabButton(host, 'Execution Sessions')?.getAttribute('data-state')).toBe('active');
    expect(host.querySelector('[data-testid="execution-sessions"]')).not.toBeNull();

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

    await act(async () => {
      root.unmount();
      await flushMicrotasks();
    });
  });
});
