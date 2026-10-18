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

interface StoredTimerPayload {
  version: number;
  startedAtMs: number;
  baseElapsedMs: number;
  elapsedMs: number;
  updatedAtMs: number;
  running: boolean;
  runId?: string | null;
}

function writtenPayloads(calls: readonly [string, string][]): StoredTimerPayload[] {
  return calls.map(([, value]) => JSON.parse(value) as StoredTimerPayload);
}

describe('CurrentTaskIndicator', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
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
    const storageKey = `member-activity-timer:${timerId}`;
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
    // Six simulated seconds only carry the one five second persistence tick.
    expect(writtenPayloads(setItem.mock.calls)).toHaveLength(1);
    expect(writtenPayloads(setItem.mock.calls)[0]).toMatchObject({
      baseElapsedMs: 0,
      running: true,
    });
    expect(setItem.mock.calls[0][0]).toBe(storageKey);
    expect(setIntervalSpy).not.toHaveBeenCalled();
    expect(clearIntervalSpy).not.toHaveBeenCalled();
    expect(host.textContent).toContain('1m 11s');
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
    // Re-arming both effects is part of the contract: the retired sync must land before the
    // new one takes over, and the polling interval must not keep the previous anchor.
    expect(writtenPayloads(setItem.mock.calls).map((payload) => payload.baseElapsedMs)).toEqual([
      0, 60_000,
    ]);
    expect(setIntervalSpy).toHaveBeenCalledTimes(1);
    expect(clearIntervalSpy).toHaveBeenCalledTimes(1);
    // The store floors the record at the baseline with `max`, so a mid-life `baseElapsedMs`
    // increase adds on top of nothing. Advancing the clock here proves both halves: the label
    // did not double-count (it would read 2m 16s) and the render path picked the new anchor up
    // instead of freezing at the value before the change.
    await act(async () => {
      vi.advanceTimersByTime(5_000);
      await Promise.resolve();
    });
    expect(host.textContent).toContain('1m 16s');
    setItem.mockClear();
    setIntervalSpy.mockClear();
    clearIntervalSpy.mockClear();

    await act(async () => {
      root.render(
        <CurrentTaskIndicator
          task={task}
          borderColor="#22c55e"
          activityTimer={{ ...anchor, baseElapsedMs: 60_000, runId: 'run-2' }}
        />
      );
      await Promise.resolve();
    });
    // A new run retires the previous sync before arming its own, interval included.
    expect(writtenPayloads(setItem.mock.calls).map((payload) => payload.runId)).toEqual([
      'run-1',
      'run-2',
    ]);
    expect(setIntervalSpy).toHaveBeenCalledTimes(1);
    expect(clearIntervalSpy).toHaveBeenCalledTimes(1);
    setItem.mockClear();
    setIntervalSpy.mockClear();
    clearIntervalSpy.mockClear();

    await act(async () => {
      root.render(
        <CurrentTaskIndicator
          task={task}
          borderColor="#22c55e"
          isTimerRunning={false}
          activityTimer={{ ...anchor, baseElapsedMs: 60_000, runId: 'run-2' }}
        />
      );
      await Promise.resolve();
    });
    expect(writtenPayloads(setItem.mock.calls).map((payload) => payload.running)).toEqual([
      true,
      false,
    ]);
    expect(clearIntervalSpy).toHaveBeenCalledTimes(1);
    expect(setIntervalSpy).not.toHaveBeenCalled();

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('retires the timer once when the anchor disappears', async () => {
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
    expect(host.textContent).toContain('1m 05s');

    const setItem = vi.spyOn(globalThis.localStorage, 'setItem');
    const setIntervalSpy = vi.spyOn(window, 'setInterval');
    const clearIntervalSpy = vi.spyOn(window, 'clearInterval');

    await act(async () => {
      vi.advanceTimersByTime(20_000);
      await Promise.resolve();
    });
    expect(host.textContent).toContain('1m 25s');
    expect(setIntervalSpy).not.toHaveBeenCalled();
    setItem.mockClear();

    await act(async () => {
      root.render(<CurrentTaskIndicator task={task} borderColor="#22c55e" activityTimer={null} />);
      await Promise.resolve();
    });

    const retiredPayloads = writtenPayloads(setItem.mock.calls);
    expect(retiredPayloads).toHaveLength(1);
    expect(retiredPayloads[0]).toMatchObject({ running: true, runId: 'run-1', elapsedMs: 85_000 });
    expect(setItem.mock.calls[0][0]).toBe(`member-activity-timer:${timerId}`);
    expect(clearIntervalSpy).toHaveBeenCalledTimes(1);
    expect(setIntervalSpy).not.toHaveBeenCalled();
    expect(host.textContent).not.toContain('1m 25s');

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('writes nothing while a paused timer stays on screen', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-07T09:01:05.000Z'));
    const startedAt = '2026-05-07T09:00:00.000Z';
    const startedAtMs = Date.parse(startedAt);
    const timerId = createMemberActivityTimerId({
      teamName: 'alpha',
      memberName: 'bob',
      phase: 'work',
      taskId: task.id,
      startedAt,
    });
    const anchor = {
      startedAt,
      startedAtMs,
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

    await act(async () => {
      root.render(
        <CurrentTaskIndicator
          task={task}
          borderColor="#22c55e"
          isTimerRunning={false}
          activityTimer={anchor}
        />
      );
      await Promise.resolve();
    });

    const setItem = vi.spyOn(globalThis.localStorage, 'setItem');
    const setIntervalSpy = vi.spyOn(window, 'setInterval');
    expect(host.textContent).toContain('1m 05s');

    for (let render = 0; render < 3; render += 1) {
      await act(async () => {
        root.render(
          <CurrentTaskIndicator
            task={task}
            borderColor="#22c55e"
            isTimerRunning={false}
            activityTimer={{ ...anchor }}
          />
        );
        vi.advanceTimersByTime(5_000);
        await Promise.resolve();
      });
    }

    expect(setItem).not.toHaveBeenCalled();
    expect(setIntervalSpy).not.toHaveBeenCalled();
    expect(host.textContent).toContain('1m 05s');
    expect(
      readMemberActivityTimerElapsed({
        timerId,
        startedAtMs,
        baseElapsedMs: 0,
        running: false,
        runId: 'run-1',
        nowMs: Date.parse('2026-05-07T09:17:20.000Z'),
      })
    ).toBe(65_000);

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('keeps the latest visible elapsed on pause before persistence and excludes paused time on resume', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.useFakeTimers();
    const startedAt = '2026-05-07T09:00:00.000Z';
    const startedAtMs = Date.parse(startedAt);
    vi.setSystemTime(startedAtMs + 10_000);
    const anchor = {
      startedAt,
      startedAtMs,
      baseElapsedMs: 0,
      runId: 'run-1',
      timerId: createMemberActivityTimerId({
        teamName: 'alpha',
        memberName: 'bob',
        phase: 'work',
        taskId: task.id,
        startedAt,
      }),
    };
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const renderIndicator = (running: boolean) =>
      root.render(
        <CurrentTaskIndicator
          task={task}
          borderColor="#22c55e"
          isTimerRunning={running}
          activityTimer={{ ...anchor }}
        />
      );
    const timerText = () => host.querySelector('span.tabular-nums')?.textContent;

    await act(async () => {
      renderIndicator(true);
    });
    expect(timerText()).toBe('10s');
    const setItem = vi.spyOn(globalThis.localStorage, 'setItem');
    const setIntervalSpy = vi.spyOn(window, 'setInterval');
    const clearIntervalSpy = vi.spyOn(window, 'clearInterval');
    await act(async () => {
      vi.advanceTimersByTime(2_000);
    });
    expect(timerText()).toBe('12s');
    expect(setItem).not.toHaveBeenCalled();

    // Two seconds is short of the five-second disk tick. The pause effect must display the
    // elapsed it just banked, even when its clock equals the most recent render tick exactly.
    await act(async () => {
      renderIndicator(false);
    });
    expect(timerText()).toBe('12s');
    expect(
      writtenPayloads(setItem.mock.calls).map(({ running, elapsedMs }) => ({ running, elapsedMs }))
    ).toEqual([
      { running: true, elapsedMs: 12_000 },
      { running: false, elapsedMs: 12_000 },
    ]);
    expect(clearIntervalSpy).toHaveBeenCalledTimes(1);
    expect(setIntervalSpy).not.toHaveBeenCalled();
    setItem.mockClear();
    clearIntervalSpy.mockClear();

    await act(async () => {
      vi.advanceTimersByTime(30_000);
    });
    expect(timerText()).toBe('12s');
    await act(async () => {
      renderIndicator(false);
    });
    expect(timerText()).toBe('12s');
    expect(setItem).not.toHaveBeenCalled();
    expect(setIntervalSpy).not.toHaveBeenCalled();
    expect(clearIntervalSpy).not.toHaveBeenCalled();

    await act(async () => {
      renderIndicator(true);
    });
    expect(timerText()).toBe('12s');
    expect(setIntervalSpy).toHaveBeenCalledTimes(1);
    await act(async () => {
      vi.advanceTimersByTime(2_000);
    });
    expect(timerText()).toBe('14s');

    await act(async () => {
      root.unmount();
    });
  });

  it('re-arms both effects when only the anchor timestamp changes', async () => {
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

    // Invariant, not a hazard: the shared key is total over `MemberActivityTimerAnchor`, so a
    // field added later cannot be silently dropped from it. This input — `startedAt` moved while
    // `timerId` was held — is not something `derive*Anchor`/`withActivityTimerRunId` can emit
    // (`startedAt` is the trailing segment of `timerId`), and neither effect body reads it.
    await act(async () => {
      root.render(
        <CurrentTaskIndicator
          task={task}
          borderColor="#22c55e"
          activityTimer={{ ...anchor, startedAt: '2026-05-07T09:00:01.000Z' }}
        />
      );
      await Promise.resolve();
    });

    // Retire then arm, both against the timer the anchor names — not just "two writes happened".
    expect(setItem.mock.calls.map(([key]) => key)).toEqual([
      `member-activity-timer:${timerId}`,
      `member-activity-timer:${timerId}`,
    ]);
    expect(writtenPayloads(setItem.mock.calls)).toHaveLength(2);
    expect(setIntervalSpy).toHaveBeenCalledTimes(1);
    expect(clearIntervalSpy).toHaveBeenCalledTimes(1);

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });
});
