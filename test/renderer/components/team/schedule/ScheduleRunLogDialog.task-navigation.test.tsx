import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { ScheduleRunLogDialog } from '@renderer/components/team/schedule/ScheduleRunLogDialog';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ScheduleRun } from '@shared/types';

const mocks = vi.hoisted(() => ({
  contextId: 'workspace-1' as string | null,
  openTaskDetailTab: vi.fn(),
}));

vi.mock('@features/localization/renderer', () => ({
  useAppTranslation: () => ({
    t: (key: string) => key === 'schedule.runLog.openTask' ? 'Open task' : key,
  }),
}));

vi.mock('@renderer/store', () => ({
  useStore: (select: (state: unknown) => unknown) => select({
    activeContextId: mocks.contextId,
    openTaskDetailTab: mocks.openTaskDetailTab,
    scheduleRuns: {},
  }),
}));

vi.mock('zustand/react/shallow', () => ({ useShallow: (selector: unknown) => selector }));
vi.mock('@renderer/api', () => ({ api: { schedules: { getRunLogs: vi.fn() } } }));
vi.mock('@renderer/components/ui/dialog', () => {
  const Slot = ({ children }: { children?: React.ReactNode }) => children;
  return {
    Dialog: Slot,
    DialogContent: Slot,
    DialogFooter: Slot,
    DialogHeader: Slot,
    DialogTitle: Slot,
  };
});
vi.mock('@renderer/components/team/CliLogsRichView', () => ({
  CliLogsRichView: () => null,
}));

const run: ScheduleRun = {
  id: 'run-1',
  scheduleId: 'schedule-1',
  teamName: 'dev-team',
  status: 'dispatched',
  scheduledFor: '2026-11-08T10:00:00.000Z',
  startedAt: '2026-11-08T10:00:00.000Z',
  retryCount: 0,
  linkedTaskId: 'task-1',
};

describe('ScheduleRunLogDialog task navigation', () => {
  let host: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    mocks.contextId = 'workspace-1';
    mocks.openTaskDetailTab.mockReset().mockReturnValue({ tabId: 'task-tab' });
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
  });

  it('opens the exact persisted board task from a linked schedule run', async () => {
    const onClose = vi.fn();
    await act(async () => {
      root.render(
        <ScheduleRunLogDialog open run={run} scheduleId={run.scheduleId} onClose={onClose} />
      );
    });
    const button = [...host.querySelectorAll('button')].find(
      (item) => item.textContent?.trim() === 'Open task'
    );
    expect(button).toBeTruthy();
    await act(async () => button?.click());
    expect(mocks.openTaskDetailTab).toHaveBeenCalledExactlyOnceWith({
      contextId: 'workspace-1', teamName: 'dev-team', taskId: 'task-1',
    });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('does not create a fake task link for one-shot runs', async () => {
    await act(async () => {
      root.render(
        <ScheduleRunLogDialog open run={{ ...run, linkedTaskId: undefined }}
          scheduleId={run.scheduleId} onClose={vi.fn()} />
      );
    });
    expect(host.textContent).not.toContain('Open task');
    expect(mocks.openTaskDetailTab).not.toHaveBeenCalled();
  });

  it('does not close the run log when task tab navigation cannot be confirmed', async () => {
    mocks.openTaskDetailTab.mockReturnValueOnce(null);
    const onClose = vi.fn();
    await act(async () => {
      root.render(
        <ScheduleRunLogDialog open run={run} scheduleId={run.scheduleId} onClose={onClose} />
      );
    });
    const button = [...host.querySelectorAll('button')].find(
      (item) => item.textContent?.trim() === 'Open task'
    );
    await act(async () => button?.click());
    expect(mocks.openTaskDetailTab).toHaveBeenCalledOnce();
    expect(onClose).not.toHaveBeenCalled();
  });
});
