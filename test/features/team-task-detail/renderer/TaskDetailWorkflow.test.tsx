import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import {
  TaskImplementationDurationBadge,
  WorkflowTimelineWithDuration,
} from '@features/team-task-detail/renderer/ui/TaskDetailWorkflow';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { TeamTaskWithKanban } from '@shared/types';

vi.mock('@features/localization/renderer', () => ({
  useAppTranslation: () => ({
    t: (_key: string, values?: Record<string, string>) => values?.duration ?? _key,
  }),
}));

vi.mock('@renderer/components/team/dialogs/StatusHistoryTimeline', () => ({
  WorkflowTimeline: () => <div data-workflow-timeline />,
}));

vi.mock('@renderer/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: () => null,
}));

describe('task detail workflow duration visibility', () => {
  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = '';
  });

  it('stops both mounted duration intervals while hidden and resumes them when visible', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-14T12:00:10.000Z'));
    const task = {
      id: 'task-1',
      status: 'in_progress',
      workIntervals: [{ startedAt: '2026-10-14T12:00:00.000Z' }],
      historyEvents: [],
    } as unknown as TeamTaskWithKanban;
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const view = (active: boolean): React.ReactElement => (
      <>
        <TaskImplementationDurationBadge task={task} active={active} />
        <WorkflowTimelineWithDuration
          task={task}
          events={[]}
          memberColorMap={new Map()}
          active={active}
        />
      </>
    );

    await act(async () => {
      root.render(view(false));
      await Promise.resolve();
    });
    expect(vi.getTimerCount()).toBe(0);

    await act(async () => {
      root.render(view(true));
      await Promise.resolve();
    });
    expect(vi.getTimerCount()).toBe(2);

    await act(async () => {
      root.render(view(false));
      await Promise.resolve();
    });
    expect(vi.getTimerCount()).toBe(0);

    await act(async () => root.unmount());
  });
});
