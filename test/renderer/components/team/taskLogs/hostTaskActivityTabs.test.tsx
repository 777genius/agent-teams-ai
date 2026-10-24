import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { ExactTaskLogsSection } from '@renderer/components/team/taskLogs/ExactTaskLogsSection';
import { HostTaskActivityIndex } from '@renderer/components/team/taskLogs/HostTaskActivityViews';
import { TaskActivitySection } from '@renderer/components/team/taskLogs/TaskActivitySection';
import { TaskLogStreamSection } from '@renderer/components/team/taskLogs/TaskLogStreamSection';
import { afterEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  activity: vi.fn(),
  detail: vi.fn(),
  stream: vi.fn(),
  exact: vi.fn(),
  exactDetail: vi.fn(),
  legacyChunks: vi.fn((_props: { stream: unknown }) => null),
  normalize: vi.fn(() => {
    throw new Error('Host facts must not become transcript chunks');
  }),
}));
vi.mock('@renderer/api', () => ({
  api: {
    teams: {
      getTaskActivity: mocks.activity,
      getTaskActivityDetail: mocks.detail,
      getTaskLogStream: mocks.stream,
      getTaskExactLogSummaries: mocks.exact,
      getTaskExactLogDetail: mocks.exactDetail,
    },
  },
}));
vi.mock('@features/localization/renderer', () => ({
  useAppTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('@renderer/store', () => ({ useStore: () => [] }));
vi.mock('@features/member-log-stream/renderer', () => ({
  ExecutionLogStreamView: mocks.legacyChunks,
  normalizeExecutionLogStream: mocks.normalize,
}));
const summary = {
  id: 'source/input/original',
  sourceGeneration: 'source-generation-original',
  sessionId: 'source',
  memberId: 'alice-id',
  memberName: 'alice',
  generation: 'original',
  inputId: 'original',
  eventCount: 1,
  messageCount: 0,
  gaps: [],
};
const log = {
  kind: 'host_activity' as const,
  sessionId: 'source',
  memberId: 'alice-id',
  memberName: 'alice',
  generation: 'original',
  taskId: 'task',
  description: 'Captured runtime activity',
  startTime: null,
  durationMs: null,
  messageCount: 0,
  isOngoing: false,
  gaps: ['retention'],
  events: [
    {
      eventId: 'actual-source:3',
      sequence: 3,
      inputId: 'original',
      data: {
        kind: 'tool-result' as const,
        toolRef: 'native-tool',
        content: 'actual exit seven',
        isError: true,
      },
    },
  ],
};
const activity = {
  kind: 'host_task_activity' as const,
  taskId: 'task',
  items: [summary],
  gaps: [],
  historyEvents: [
    {
      id: 'actual-history',
      type: 'status_changed' as const,
      from: 'pending' as const,
      to: 'in_progress' as const,
      timestamp: '2026-10-23T01:00:00Z',
      actor: 'user',
    },
  ],
};
const detail = {
  status: 'ok' as const,
  detail: {
    kind: 'host_task_log_detail' as const,
    id: summary.id,
    taskId: 'task',
    sourceGeneration: summary.sourceGeneration,
    log,
  },
};
afterEach(() => vi.clearAllMocks());
it('original Activity/Stream/Exact surfaces show actual source facts or stale refusal without transcript fabrication', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  mocks.activity.mockResolvedValue(activity);
  mocks.detail.mockResolvedValue(detail);
  mocks.stream.mockResolvedValue({
    kind: 'host_task_log_stream',
    taskId: 'task',
    logs: [log],
    gaps: ['retention'],
  });
  mocks.exact.mockResolvedValue({
    kind: 'host_task_exact_logs',
    taskId: 'task',
    items: [summary],
    gaps: [],
  });
  mocks.exactDetail.mockResolvedValue({ status: 'stale' });
  const node = document.createElement('div'),
    root = createRoot(node);
  document.body.appendChild(node);
  try {
    await act(async () => {
      root.render(<TaskActivitySection teamName="host-team:original" taskId="task" />);
    });
    expect(node.textContent).toContain('status changed');
    expect(node.textContent).toContain('2026-10-23T01:00:00Z');
    await act(async () => {
      node.querySelector<HTMLButtonElement>('[aria-expanded]')!.click();
    });
    expect(mocks.detail).toHaveBeenCalledWith('host-team:original', 'task', summary.id);
    expect(node.textContent).toContain('actual exit seven');
    expect(node.textContent).toContain('"isError": true');
    expect(node.textContent).toContain('timestamps unavailable');
    await act(async () => {
      root.render(
        <TaskLogStreamSection teamName="host-team:original" taskId="task" liveEnabled={false} />
      );
    });
    expect(node.textContent).toContain('original input causes');
    await act(async () => {
      node.querySelector<HTMLButtonElement>('[aria-expanded]')!.click();
    });
    expect(node.textContent).toContain('actual exit seven');
    expect(mocks.normalize).not.toHaveBeenCalled();
    expect(mocks.legacyChunks.mock.calls.every((call) => !call[0]?.stream)).toBe(true);
    await act(async () => {
      root.render(<ExactTaskLogsSection teamName="host-team:original" taskId="task" />);
    });
    await act(async () => {
      node.querySelector<HTMLButtonElement>('[aria-expanded]')!.click();
    });
    expect(mocks.exactDetail).toHaveBeenCalledWith(
      'host-team:original',
      'task',
      summary.id,
      summary.sourceGeneration
    );
    expect(node.textContent).toContain('Retained source changed');
    expect(mocks.exact).toHaveBeenCalledTimes(1);
  } finally {
    await act(async () => root.unmount());
    node.remove();
  }
});
it('an old expanded detail cannot paint after Task/context changes', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  let finish!: (value: typeof detail) => void;
  mocks.detail.mockReturnValue(
    new Promise((resolve) => {
      finish = resolve;
    })
  );
  const node = document.createElement('div'),
    root = createRoot(node);
  document.body.appendChild(node);
  try {
    await act(async () => {
      root.render(
        <HostTaskActivityIndex teamName="host-team:original" value={activity} mode="activity" />
      );
    });
    await act(async () => {
      node.querySelector<HTMLButtonElement>('[aria-expanded]')!.click();
    });
    await act(async () => {
      root.render(
        <HostTaskActivityIndex
          teamName="host-team:next"
          value={{ ...activity, taskId: 'other-task' }}
          mode="activity"
        />
      );
    });
    await act(async () => finish(detail));
    expect(node.textContent).not.toContain('actual exit seven');
    expect(node.querySelector('[aria-expanded="true"]')).toBeNull();
  } finally {
    await act(async () => root.unmount());
    node.remove();
  }
});
