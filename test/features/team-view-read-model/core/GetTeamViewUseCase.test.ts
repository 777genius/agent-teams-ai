import { beforeEach, describe, expect, it, vi } from 'vitest';

import { GetTeamViewUseCase } from '../../../../src/features/team-view-read-model/core/application/use-cases/GetTeamViewUseCase';

import type { InboxMessage, TeamViewSnapshot } from '@shared/types';

const activeProcess = {
  id: 'process-1',
  label: 'Lead',
  pid: 123,
  registeredAt: '2026-07-23T00:00:00.000Z',
};

function createSnapshot(
  overrides: Partial<TeamViewSnapshot & { messages: InboxMessage[] }> = {}
): TeamViewSnapshot & { messages?: InboxMessage[] } {
  return {
    teamName: 'team-one',
    config: { name: 'Team One', projectPath: '/sandbox/team-one' },
    tasks: [],
    members: [],
    kanbanState: { teamName: 'team-one', reviewers: [], tasks: {} },
    processes: [],
    ...overrides,
  };
}

describe('GetTeamViewUseCase', () => {
  const snapshots = {
    getTeamData: vi.fn(() => Promise.resolve(createSnapshot())),
  };
  const processHealth = {
    trackProcessHealthForTeam: vi.fn(),
    untrackProcessHealthForTeam: vi.fn(),
  };
  const worker = {
    isAvailable: vi.fn(() => false),
    isFatalError: vi.fn(() => false),
    getTeamData: vi.fn(() => Promise.resolve(createSnapshot())),
  };
  const missingTeams = {
    classifyBeforeRead: vi.fn(() => Promise.resolve(null)),
    classifyAfterNotFound: vi.fn(() => Promise.resolve(null)),
  };
  const taskActivity = {
    repairStaleTaskActivityIntervalsBeforeSnapshot: vi.fn(() => Promise.resolve()),
  };
  const runtime = { isTeamAlive: vi.fn(() => true) };
  const liveMessages = {
    getLiveLeadProcessMessages: vi.fn(() => [] as InboxMessage[]),
    getCurrentLeadSessionId: vi.fn(() => null as string | null),
  };
  const notifications = {
    scan: vi.fn(),
    checkRateLimitMessages: vi.fn(),
    checkApiErrorMessages: vi.fn(),
  };
  const merger = {
    mergeMessages: vi.fn((durable: InboxMessage[]) => durable),
    mergePage: vi.fn(),
  };
  const newestMessages = { execute: vi.fn() };
  const engagement = { markEngaged: vi.fn() };
  const operations = { setCurrent: vi.fn() };
  const clock = { now: vi.fn(() => 0) };
  const environment = { isPackaged: vi.fn(() => false) };
  const logger = { debug: vi.fn(), error: vi.fn(), warn: vi.fn() };
  const useCase = new GetTeamViewUseCase({
    snapshots,
    processHealth,
    worker,
    missingTeams,
    taskActivity,
    runtime,
    liveMessages,
    notifications,
    merger,
    newestMessages,
    engagement,
    operations,
    clock,
    environment,
    logger,
  });

  beforeEach(() => {
    vi.clearAllMocks();
    snapshots.getTeamData.mockResolvedValue(createSnapshot());
    worker.isAvailable.mockReturnValue(false);
    missingTeams.classifyBeforeRead.mockResolvedValue(null);
    missingTeams.classifyAfterNotFound.mockResolvedValue(null);
    runtime.isTeamAlive.mockReturnValue(true);
    liveMessages.getLiveLeadProcessMessages.mockReturnValue([]);
  });

  it('always clears the operation tracker when a snapshot read fails', async () => {
    snapshots.getTeamData.mockRejectedValueOnce(new Error('snapshot failed'));

    const result = await useCase.execute('team-one');

    expect(result).toEqual({ kind: 'failure', error: 'snapshot failed' });
    expect(engagement.markEngaged).toHaveBeenCalledWith('team-one');
    expect(operations.setCurrent.mock.calls).toEqual([['team:getData'], [null]]);
    expect(processHealth.trackProcessHealthForTeam).not.toHaveBeenCalled();
  });

  it('tracks active process health and returns runtime liveness without adding messages', async () => {
    snapshots.getTeamData.mockResolvedValueOnce(createSnapshot({ processes: [activeProcess] }));
    runtime.isTeamAlive.mockReturnValue(false);

    const result = await useCase.execute('team-one');

    expect(result).toEqual({
      kind: 'success',
      data: expect.objectContaining({ teamName: 'team-one', isAlive: false }),
    });
    expect(processHealth.trackProcessHealthForTeam).toHaveBeenCalledWith('team-one');
    expect(processHealth.untrackProcessHealthForTeam).not.toHaveBeenCalled();
    expect(notifications.scan).toHaveBeenCalledWith([], {
      teamName: 'team-one',
      teamDisplayName: 'Team One',
      projectPath: '/sandbox/team-one',
    });
  });

  it('untracks stopped teams and scans durable messages through specialized policies', async () => {
    const durableMessage: InboxMessage = {
      from: 'team-lead',
      text: 'Status update',
      timestamp: '2026-07-23T00:00:00.000Z',
      read: true,
      source: 'lead_session',
      messageId: 'message-1',
    };
    snapshots.getTeamData.mockResolvedValueOnce(
      createSnapshot({
        processes: [{ ...activeProcess, stoppedAt: '2026-07-23T00:01:00.000Z' }],
        messages: [durableMessage],
      })
    );

    await useCase.execute('team-one');

    expect(processHealth.untrackProcessHealthForTeam).toHaveBeenCalledWith('team-one');
    expect(notifications.checkRateLimitMessages).toHaveBeenCalledWith(
      [durableMessage],
      expect.objectContaining({ teamName: 'team-one', teamIsAlive: true })
    );
    expect(notifications.checkApiErrorMessages).toHaveBeenCalledWith(
      [durableMessage],
      expect.objectContaining({ teamName: 'team-one' })
    );
    expect(notifications.scan).not.toHaveBeenCalled();
  });
});
