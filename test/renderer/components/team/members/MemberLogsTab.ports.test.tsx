import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { MemberLogsTab } from '@renderer/components/team/members/MemberLogsTab';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { MemberLogSummary } from '@shared/types';
import type { Root } from 'react-dom/client';

const portsMock = vi.hoisted(() => ({
  readTaskLogs: vi.fn(),
  readMemberLogs: vi.fn(),
  readMemberLogStream: vi.fn(),
  setStreamTracking: vi.fn(),
  subscribeToChanges: vi.fn(),
}));

vi.mock('@features/member-log-stream/renderer', () => ({
  memberLogObservationPorts: portsMock,
}));

vi.mock('@features/localization/renderer', () => ({
  useAppTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@renderer/contexts/useTabUIContext', () => ({
  useTabIdOptional: () => undefined,
}));

vi.mock('@renderer/store', () => ({
  useStore: (selector: (state: { activeTabId: string | null }) => unknown) =>
    selector({ activeTabId: null }),
}));

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}

function staleLog(): MemberLogSummary {
  return {
    kind: 'lead_session',
    sessionId: 'stale-session',
    projectId: 'project-1',
    description: 'stale task log',
    memberName: 'lead',
    startTime: '2026-04-03T00:00:00.000Z',
    durationMs: 1_000,
    messageCount: 1,
    isOngoing: false,
  };
}

describe('MemberLogsTab member-log renderer ports', () => {
  let host: HTMLDivElement;
  let root: Root | null;

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    portsMock.readTaskLogs.mockReset();
    portsMock.readMemberLogs.mockReset();
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    if (root) {
      act(() => {
        root?.unmount();
      });
    }
    root = null;
    document.body.innerHTML = '';
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  async function render(props: React.ComponentProps<typeof MemberLogsTab>): Promise<void> {
    await act(async () => {
      root?.render(<MemberLogsTab {...props} />);
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  it('routes the member query through the feature port and preserves errors in the UI', async () => {
    portsMock.readMemberLogs.mockRejectedValue(new Error('member query failed'));

    await render({ teamName: 'alpha-team', memberName: 'alice' });

    expect(portsMock.readMemberLogs).toHaveBeenCalledWith('alpha-team', 'alice');
    expect(portsMock.readTaskLogs).not.toHaveBeenCalled();
    expect(host.textContent).toContain('member query failed');
  });

  it('preserves the task query shape and five-second in-progress polling', async () => {
    vi.useFakeTimers();
    portsMock.readTaskLogs.mockResolvedValue([]);
    const intervals = [{ startedAt: '2026-04-03T00:00:00.000Z' }];
    const expectedQuery = {
      owner: 'alice',
      status: 'in_progress',
      intervals,
      since: '2026-04-02T23:00:00.000Z',
    };

    await render({
      teamName: 'alpha-team',
      taskId: 'task-7',
      taskOwner: 'alice',
      taskStatus: 'in_progress',
      taskWorkIntervals: intervals,
      taskSince: '2026-04-02T23:00:00.000Z',
    });

    expect(portsMock.readTaskLogs).toHaveBeenCalledTimes(1);
    expect(portsMock.readTaskLogs).toHaveBeenLastCalledWith('alpha-team', 'task-7', expectedQuery);
    expect(portsMock.readMemberLogs).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });

    expect(portsMock.readTaskLogs).toHaveBeenCalledTimes(2);
    expect(portsMock.readTaskLogs).toHaveBeenLastCalledWith('alpha-team', 'task-7', expectedQuery);
  });

  it('suppresses a cancelled task result after the query changes', async () => {
    const oldTask = createDeferred<MemberLogSummary[]>();
    portsMock.readTaskLogs.mockImplementation(
      (_teamName: string, taskId: string): Promise<MemberLogSummary[]> =>
        taskId === 'task-old' ? oldTask.promise : Promise.resolve([])
    );

    await render({ teamName: 'alpha-team', taskId: 'task-old' });
    await render({ teamName: 'alpha-team', taskId: 'task-new' });

    await act(async () => {
      oldTask.resolve([staleLog()]);
      await Promise.resolve();
    });

    expect(portsMock.readTaskLogs.mock.calls.map(([, taskId]) => taskId)).toEqual([
      'task-old',
      'task-new',
    ]);
    expect(host.textContent).not.toContain('stale task log');
    expect(host.textContent).toContain('members.logs.empty');
  });
});
