import { resolveMemberWorkSyncRefreshSettlement } from '@features/member-work-sync/main/composition/refreshMemberWorkSyncStatus';
import {
  rememberMemberWorkSyncLastSettlement,
  resetMemberWorkSyncLastSettlements,
} from '@features/member-work-sync/main/infrastructure/memberWorkSyncLastSettlementStore';
import { mkdir, mkdtemp, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';

describe('resolveMemberWorkSyncRefreshSettlement', () => {
  afterEach(() => {
    resetMemberWorkSyncLastSettlements();
  });

  it('does not invent a successful settlement from session evidence alone', async () => {
    const root = await mkdtemp(join(tmpdir(), 'work-sync-refresh-'));
    const laneDir = join(root, 'team-a', '.opencode-runtime', 'lanes', 'lane-bob');
    await mkdir(laneDir, { recursive: true });
    await writeFile(
      join(laneDir, 'opencode-sessions.json'),
      `${JSON.stringify({
        updatedAt: '2026-05-06T00:05:00.000Z',
        sessions: [{ id: 'ses-new', memberName: 'bob', laneId: 'lane-bob' }],
      })}\n`
    );

    await expect(
      resolveMemberWorkSyncRefreshSettlement({
        request: { teamName: 'team-a', memberName: 'bob' },
        teamsBasePath: root,
        nowIso: '2026-05-06T00:05:00.000Z',
      })
    ).resolves.toBeUndefined();
  });

  it('replays a remembered turn-settled settlement on refresh', async () => {
    const settlement = {
      sourceId: 'settle-1',
      recordedAt: '2026-05-06T00:04:00.000Z',
      runtimeInstanceId: 'opencode:lane-bob:ses-new',
      completedGeneration: 7,
      outcome: 'success' as const,
    };
    rememberMemberWorkSyncLastSettlement({
      teamName: 'team-a',
      memberName: 'bob',
      settlement,
    });

    await expect(
      resolveMemberWorkSyncRefreshSettlement({
        request: { teamName: 'team-a', memberName: 'bob' },
        teamsBasePath: '/tmp/unused',
        nowIso: '2026-05-06T00:05:00.000Z',
      })
    ).resolves.toEqual(settlement);
  });
});
