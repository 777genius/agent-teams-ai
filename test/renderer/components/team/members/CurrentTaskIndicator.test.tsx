import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CurrentTaskIndicator } from '@renderer/components/team/members/CurrentTaskIndicator';
import {
  createMemberActivityTimerId,
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
});
