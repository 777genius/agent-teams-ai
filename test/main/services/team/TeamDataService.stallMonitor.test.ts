import { describe, expect, it, vi } from 'vitest';

import { TeamDataService } from '../../../../src/main/services/team/TeamDataService';

import type { SendMessageResult, TaskRef, TeamSummary } from '../../../../src/shared/types';

function createService(configReaderOverrides: Record<string, unknown> = {}): TeamDataService {
  return new TeamDataService(
    {
      getConfig: vi.fn(async () => null),
      listTeams: vi.fn(async () => []),
      ...configReaderOverrides,
    } as never,
    { getTasks: vi.fn(async () => []) } as never,
    { listInboxNames: vi.fn(async () => []), getMessages: vi.fn(async () => []) } as never,
    {} as never,
    {} as never,
    { resolveMembers: vi.fn(() => []) } as never,
    { getState: vi.fn(async () => ({ teamName: 'demo', reviewers: [], tasks: {} })) } as never,
    {} as never,
    { getMembers: vi.fn(async () => []), writeMembers: vi.fn(async () => {}) } as never,
    { readMessages: vi.fn(async () => []) } as never
  );
}

describe('TeamDataService stall-monitor helpers', () => {
  it('lists alive process teams using non-stopped processes and ignores per-team read errors', async () => {
    const teams: TeamSummary[] = [
      {
        teamName: 'beta',
        displayName: 'beta',
        description: '',
        memberCount: 0,
        taskCount: 0,
        lastActivity: null,
      },
      {
        teamName: 'alpha',
        displayName: 'alpha',
        description: '',
        memberCount: 0,
        taskCount: 0,
        lastActivity: null,
      },
      {
        teamName: 'gamma',
        displayName: 'gamma',
        description: '',
        memberCount: 0,
        taskCount: 0,
        lastActivity: null,
      },
      {
        teamName: 'deleted',
        displayName: 'deleted',
        description: '',
        memberCount: 0,
        taskCount: 0,
        lastActivity: null,
        deletedAt: '2026-04-19T12:09:00.000Z',
      },
    ];

    const service = createService({
      listTeams: vi.fn(async () => teams),
    });

    const readProcesses = vi.fn(async (teamName: string) => {
      if (teamName === 'alpha') {
        return [{ id: '1', label: 'alpha', pid: 101, registeredAt: '2026-04-19T12:00:00.000Z' }];
      }
      if (teamName === 'beta') {
        return [
          {
            id: '2',
            label: 'beta',
            pid: 202,
            registeredAt: '2026-04-19T12:00:00.000Z',
            stoppedAt: '2026-04-19T12:05:00.000Z',
          },
        ];
      }
      if (teamName === 'deleted') {
        return [{ id: '9', label: 'deleted', pid: 909, registeredAt: '2026-04-19T12:00:00.000Z' }];
      }
      throw new Error('boom');
    });

    (service as unknown as { readProcesses: typeof readProcesses }).readProcesses = readProcesses;

    await expect(service.listAliveProcessTeams()).resolves.toEqual(['alpha']);
    expect(readProcesses).not.toHaveBeenCalledWith('deleted');
  });

  it('routes system notifications to the resolved lead via sendMessage', async () => {
    const leadTaskRef: TaskRef = {
      taskId: 'task-1',
      displayId: '1',
      teamName: 'demo',
    };

    const service = createService({
      getConfig: vi.fn(async () => ({
        name: 'demo',
        members: [{ name: 'lead', role: 'Team Lead' }],
      })),
    });

    const expectedResult = { messageId: 'msg-1' } as SendMessageResult;
    const sendMessageSpy = vi.spyOn(service, 'sendMessage').mockResolvedValue(expectedResult);

    await expect(
      service.sendSystemNotificationToLead({
        teamName: 'demo',
        summary: 'Potential stalled tasks detected',
        text: 'Task #1 looks stalled.',
        taskRefs: [leadTaskRef],
      })
    ).resolves.toBe(expectedResult);

    expect(sendMessageSpy).toHaveBeenCalledWith(
      'demo',
      expect.objectContaining({
        member: 'lead',
        from: 'system',
        summary: 'Potential stalled tasks detected',
        text: 'Task #1 looks stalled.',
        taskRefs: [leadTaskRef],
        source: 'system_notification',
      })
    );
  });
});
