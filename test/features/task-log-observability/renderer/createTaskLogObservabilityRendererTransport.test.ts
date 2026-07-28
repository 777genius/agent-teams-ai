import type { TaskLogObservabilityRendererPort } from '@features/task-log-observability/renderer';
import { createTaskLogObservabilityRendererTransport } from '@renderer/composition/team/createTaskLogObservabilityRendererTransport';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { BoardTaskActivityEntry, TeamChangeEvent } from '@shared/types';

const hoisted = vi.hoisted(() => {
  const capabilities = {
    summary: true,
    subscription: true,
    tracking: true,
  };
  const mocks = {
    getTaskActivity: vi.fn(),
    getTaskActivityDetail: vi.fn(),
    getTaskExactLogDetail: vi.fn(),
    getTaskExactLogSummaries: vi.fn(),
    getTaskLogStream: vi.fn(),
    getTaskLogStreamSummary: vi.fn(),
    onTeamChange: vi.fn(),
    setTaskLogStreamTracking: vi.fn(),
  };

  return {
    capabilities,
    mocks,
    teams: {
      getTaskActivity: mocks.getTaskActivity,
      getTaskActivityDetail: mocks.getTaskActivityDetail,
      getTaskExactLogDetail: mocks.getTaskExactLogDetail,
      getTaskExactLogSummaries: mocks.getTaskExactLogSummaries,
      getTaskLogStream: mocks.getTaskLogStream,
      get getTaskLogStreamSummary() {
        return capabilities.summary ? mocks.getTaskLogStreamSummary : undefined;
      },
      get onTeamChange() {
        return capabilities.subscription ? mocks.onTeamChange : undefined;
      },
      get setTaskLogStreamTracking() {
        return capabilities.tracking ? mocks.setTaskLogStreamTracking : undefined;
      },
    },
  };
});

vi.mock('@renderer/api', () => ({
  api: {
    teams: hoisted.teams,
  },
}));

describe('createTaskLogObservabilityRendererTransport', () => {
  let transport: TaskLogObservabilityRendererPort;

  beforeEach(() => {
    vi.clearAllMocks();
    hoisted.capabilities.summary = true;
    hoisted.capabilities.subscription = true;
    hoisted.capabilities.tracking = true;
    transport = createTaskLogObservabilityRendererTransport();
  });

  it('forwards task-log reads and tracking without changing arguments or results', async () => {
    const activity: BoardTaskActivityEntry[] = [];
    const activityDetail = { status: 'missing' as const };
    const exactDetail = { status: 'missing' as const };
    const exactSummaries = { items: [] };
    const stream = {
      defaultFilter: 'all' as const,
      participants: [],
      segments: [],
    };
    const streamSummary = { segmentCount: 4 };

    hoisted.mocks.getTaskActivity.mockResolvedValue(activity);
    hoisted.mocks.getTaskActivityDetail.mockResolvedValue(activityDetail);
    hoisted.mocks.getTaskExactLogDetail.mockResolvedValue(exactDetail);
    hoisted.mocks.getTaskExactLogSummaries.mockResolvedValue(exactSummaries);
    hoisted.mocks.getTaskLogStream.mockResolvedValue(stream);
    hoisted.mocks.getTaskLogStreamSummary.mockResolvedValue(streamSummary);
    hoisted.mocks.setTaskLogStreamTracking.mockResolvedValue(undefined);

    await expect(transport.getTaskActivity('sandbox-team', 'task-1')).resolves.toBe(activity);
    await expect(
      transport.getTaskActivityDetail('sandbox-team', 'task-1', 'activity-1')
    ).resolves.toBe(activityDetail);
    await expect(
      transport.getTaskExactLogDetail('sandbox-team', 'task-1', 'exact-1', 'generation-1')
    ).resolves.toBe(exactDetail);
    await expect(transport.getTaskExactLogSummaries('sandbox-team', 'task-1')).resolves.toBe(
      exactSummaries
    );
    await expect(transport.getTaskLogStream('sandbox-team', 'task-1')).resolves.toBe(stream);
    await expect(transport.getTaskLogStreamSummary?.('sandbox-team', 'task-1')).resolves.toBe(
      streamSummary
    );
    await expect(
      transport.setTaskLogStreamTracking?.('sandbox-team', true)
    ).resolves.toBeUndefined();

    expect(hoisted.mocks.getTaskActivity).toHaveBeenCalledWith('sandbox-team', 'task-1');
    expect(hoisted.mocks.getTaskActivityDetail).toHaveBeenCalledWith(
      'sandbox-team',
      'task-1',
      'activity-1'
    );
    expect(hoisted.mocks.getTaskExactLogDetail).toHaveBeenCalledWith(
      'sandbox-team',
      'task-1',
      'exact-1',
      'generation-1'
    );
    expect(hoisted.mocks.getTaskExactLogSummaries).toHaveBeenCalledWith('sandbox-team', 'task-1');
    expect(hoisted.mocks.getTaskLogStream).toHaveBeenCalledWith('sandbox-team', 'task-1');
    expect(hoisted.mocks.getTaskLogStreamSummary).toHaveBeenCalledWith('sandbox-team', 'task-1');
    expect(hoisted.mocks.setTaskLogStreamTracking).toHaveBeenCalledWith('sandbox-team', true);
  });

  it('projects team-change payloads and returns the exact subscription cleanup', () => {
    const cleanup = vi.fn();
    let legacyListener: ((event: unknown, data: TeamChangeEvent) => void) | undefined;
    hoisted.mocks.onTeamChange.mockImplementation(
      (listener: (event: unknown, data: TeamChangeEvent) => void) => {
        legacyListener = listener;
        return cleanup;
      }
    );
    const listener = vi.fn();
    const event: TeamChangeEvent = {
      teamName: 'sandbox-team',
      taskId: 'task-1',
      taskSignalKind: 'log',
      type: 'task-log-change',
    };

    const unsubscribe = transport.subscribeToTeamChanges(listener);
    legacyListener?.({ legacyEnvelope: true }, event);
    unsubscribe();

    expect(hoisted.mocks.onTeamChange).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledWith(event);
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it('keeps optional summary, tracking, and subscription capabilities safe when absent', () => {
    hoisted.capabilities.summary = false;
    hoisted.capabilities.subscription = false;
    hoisted.capabilities.tracking = false;

    const compatibilityTransport = createTaskLogObservabilityRendererTransport();
    const listener = vi.fn();
    const unsubscribe = compatibilityTransport.subscribeToTeamChanges(listener);

    expect(compatibilityTransport.getTaskLogStreamSummary).toBeUndefined();
    expect(compatibilityTransport.setTaskLogStreamTracking).toBeUndefined();
    expect(unsubscribe()).toBeUndefined();
    expect(listener).not.toHaveBeenCalled();
    expect(hoisted.mocks.onTeamChange).not.toHaveBeenCalled();
  });
});
