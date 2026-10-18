import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CurrentTaskIndicator } from '@renderer/components/team/members/CurrentTaskIndicator';
import {
  createMemberActivityTimerId,
  readMemberActivityTimerElapsed,
  resetMemberActivityTimerStoreForTests,
} from '@renderer/utils/memberActivityTimer';

import type { TeamTaskWithKanban } from '@shared/types';

const task: TeamTaskWithKanban = {
  id: 'task-1',
  displayId: 'abc12345',
  subject: 'Build feature',
  status: 'in_progress',
};

describe('CurrentTaskIndicator', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    resetMemberActivityTimerStoreForTests();
    globalThis.localStorage?.clear();
    document.body.innerHTML = '';
  });

  it('renders a compact activity timer from the persisted task start anchor', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-07T09:01:05.000Z'));
    const startedAt = '2026-05-07T09:00:00.000Z';
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        <CurrentTaskIndicator
          task={task}
          borderColor="#22c55e"
          activityTimer={{
            startedAt,
            startedAtMs: Date.parse(startedAt),
            baseElapsedMs: 0,
            runId: 'run-1',
            timerId: createMemberActivityTimerId({
              teamName: 'alpha',
              memberName: 'bob',
              phase: 'work',
              taskId: task.id,
              startedAt,
            }),
          }}
        />
      );
      await Promise.resolve();
    });

    expect(host.textContent).toContain('1m 05s');

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('keeps the persisted activity timer running across unmount', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-07T09:01:05.000Z'));
    const startedAt = '2026-05-07T09:00:00.000Z';
    const timerId = createMemberActivityTimerId({
      teamName: 'alpha',
      memberName: 'bob',
      phase: 'work',
      taskId: task.id,
      startedAt,
    });
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        <CurrentTaskIndicator
          task={task}
          borderColor="#22c55e"
          activityTimer={{
            startedAt,
            startedAtMs: Date.parse(startedAt),
            baseElapsedMs: 0,
            runId: 'run-1',
            timerId,
          }}
        />
      );
      await Promise.resolve();
    });

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });

    vi.setSystemTime(new Date('2026-05-07T09:17:20.000Z'));
    expect(
      readMemberActivityTimerElapsed({
        timerId,
        startedAtMs: Date.parse(startedAt),
        baseElapsedMs: 0,
        running: true,
        runId: 'run-1',
        nowMs: Date.parse('2026-05-07T09:17:20.000Z'),
      })
    ).toBe(1_040_000);
  });

  it('persists the activity timer only when an anchor value changes', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-07T09:01:05.000Z'));
    const startedAt = '2026-05-07T09:00:00.000Z';
    const timerId = createMemberActivityTimerId({
      teamName: 'alpha',
      memberName: 'bob',
      phase: 'work',
      taskId: task.id,
      startedAt,
    });
    const anchor = {
      startedAt,
      startedAtMs: Date.parse(startedAt),
      baseElapsedMs: 0,
      runId: 'run-1',
      timerId,
    };
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        <CurrentTaskIndicator task={task} borderColor="#22c55e" activityTimer={anchor} />
      );
      await Promise.resolve();
    });

    const setItem = vi.spyOn(globalThis.localStorage, 'setItem');
    const setIntervalSpy = vi.spyOn(window, 'setInterval');
    const clearIntervalSpy = vi.spyOn(window, 'clearInterval');
    for (let render = 0; render < 3; render += 1) {
      await act(async () => {
        root.render(
          <CurrentTaskIndicator task={task} borderColor="#22c55e" activityTimer={{ ...anchor }} />
        );
        vi.advanceTimersByTime(2_000);
        await Promise.resolve();
      });
    }
    const identityWrites = setItem.mock.calls.map(([, value]) => JSON.parse(String(value)));
    // Six simulated seconds only carry the one five second persistence tick.
    expect(identityWrites).toHaveLength(1);
    expect(identityWrites[0]).toMatchObject({ baseElapsedMs: 0, running: true });
    expect(setIntervalSpy).not.toHaveBeenCalled();
    expect(clearIntervalSpy).not.toHaveBeenCalled();
    setItem.mockClear();

    await act(async () => {
      root.render(
        <CurrentTaskIndicator
          task={task}
          borderColor="#22c55e"
          activityTimer={{ ...anchor, baseElapsedMs: 60_000 }}
        />
      );
      await Promise.resolve();
    });
    const retiredPayloads = setItem.mock.calls.map(([, value]) => JSON.parse(String(value)));
    expect(retiredPayloads.map((payload) => payload.baseElapsedMs)).toEqual([0, 60_000]);
    setItem.mockRestore();
    setIntervalSpy.mockRestore();
    clearIntervalSpy.mockRestore();

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });
});
