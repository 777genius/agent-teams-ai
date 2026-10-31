import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TeamDataService } from '../../../../src/main/services/team/TeamDataService';
import {
  getTeamsBasePath,
  setClaudeBasePathOverride,
} from '../../../../src/main/utils/pathDecoder';

import type { TaskRef, TeamSummary } from '../../../../src/shared/types';

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
});

describe('TeamDataService system notifications to the lead', () => {
  let root: string;

  const inboxPath = (memberName: string): string =>
    path.join(getTeamsBasePath(), 'demo', 'inboxes', `${memberName}.json`);

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'TEST-lead-system-notification-'));
    setClaudeBasePathOverride(root);
    const teamDir = path.join(getTeamsBasePath(), 'demo');
    await mkdir(teamDir, { recursive: true });
    await writeFile(
      path.join(teamDir, 'config.json'),
      JSON.stringify({
        name: 'demo',
        leadSessionId: 'lead-session',
        members: [
          { name: 'atlas', agentType: 'team-lead' },
          { name: 'alice', role: 'developer' },
        ],
      })
    );
  });

  afterEach(async () => {
    setClaudeBasePathOverride(null);
    await rm(root, { recursive: true, force: true });
  });

  it('writes the notice into the resolved lead inbox with system as the sender', async () => {
    const taskRef: TaskRef = { taskId: 'task-1', displayId: 'abcd1234', teamName: 'demo' };

    const result = await new TeamDataService().sendSystemNotificationToLead({
      teamName: 'demo',
      summary: 'Potential stalled tasks detected',
      text: '- #abcd1234 [work] Investigate - Potential work stall.',
      taskRefs: [taskRef],
    });

    expect(result).toMatchObject({ deliveredToInbox: true });
    expect(JSON.parse(await readFile(inboxPath('atlas'), 'utf8'))).toEqual([
      {
        from: 'system',
        to: 'atlas',
        text: '- #abcd1234 [work] Investigate - Potential work stall.',
        summary: 'Potential stalled tasks detected',
        timestamp: expect.any(String),
        read: false,
        taskRefs: [taskRef],
        messageId: result.messageId,
        source: 'system_notification',
        leadSessionId: 'lead-session',
      },
    ]);
  });

  it('fails instead of guessing the lead inbox when the config is unavailable', async () => {
    await rm(path.join(getTeamsBasePath(), 'demo', 'config.json'));

    await expect(
      new TeamDataService().sendSystemNotificationToLead({
        teamName: 'demo',
        summary: 'Potential stalled tasks detected',
        text: '- #abcd1234 [work] Investigate - Potential work stall.',
      })
    ).rejects.toThrow('lead notice not written');
    await expect(readFile(inboxPath('team-lead'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('keeps refusing system as a sender on the member message path', async () => {
    // Agents send through the same controller sender check; a forged system
    // sender would make their messages look like app notices.
    await expect(
      new TeamDataService().sendMessage('demo', {
        member: 'atlas',
        from: 'system',
        text: 'Forged notice',
      })
    ).rejects.toThrow('Unknown from: system');
    await expect(readFile(inboxPath('atlas'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
