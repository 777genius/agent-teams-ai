import { createTeamOperationalReadTransport } from '@renderer/composition/team/createTeamOperationalReadTransport';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { TeamOperationalLogPage } from '@features/team-view-read-model/renderer';
import type { MemberFullStats } from '@shared/types';

const mocks = vi.hoisted(() => ({
  getClaudeLogs: vi.fn(),
  getMemberStats: vi.fn(),
}));

vi.mock('@renderer/api', () => ({
  api: {
    teams: mocks,
  },
}));

describe('createTeamOperationalReadTransport', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('delegates provider-neutral operational reads without changing the results', async () => {
    const logs: TeamOperationalLogPage = {
      lines: ['latest'],
      total: 1,
      hasMore: false,
      updatedAt: '2026-07-30T10:00:00.000Z',
    };
    const stats: MemberFullStats = {
      linesAdded: 2,
      linesRemoved: 1,
      filesTouched: ['/sandbox/member.ts'],
      fileStats: { '/sandbox/member.ts': { added: 2, removed: 1 } },
      toolUsage: { Read: 1 },
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 0,
      costUsd: 0,
      tasksCompleted: 1,
      messageCount: 2,
      totalDurationMs: 500,
      sessionCount: 1,
      computedAt: '2026-07-30T10:00:01.000Z',
    };
    mocks.getClaudeLogs.mockResolvedValueOnce(logs);
    mocks.getMemberStats.mockResolvedValueOnce(stats);
    const transport = createTeamOperationalReadTransport();

    await expect(transport.readLeadLogs('sandbox-team', { offset: 4, limit: 20 })).resolves.toBe(
      logs
    );
    await expect(transport.readMemberStats('sandbox-team', 'alice')).resolves.toBe(stats);
    expect(mocks.getClaudeLogs).toHaveBeenCalledWith('sandbox-team', {
      offset: 4,
      limit: 20,
    });
    expect(mocks.getMemberStats).toHaveBeenCalledWith('sandbox-team', 'alice');
  });

  it('preserves transport failures for consumer error policies', async () => {
    const logsFailure = new Error('logs failed');
    const statsFailure = new Error('stats failed');
    mocks.getClaudeLogs.mockRejectedValueOnce(logsFailure);
    mocks.getMemberStats.mockRejectedValueOnce(statsFailure);
    const transport = createTeamOperationalReadTransport();

    await expect(transport.readLeadLogs('sandbox-team')).rejects.toBe(logsFailure);
    await expect(transport.readMemberStats('sandbox-team', 'alice')).rejects.toBe(statsFailure);
  });
});
