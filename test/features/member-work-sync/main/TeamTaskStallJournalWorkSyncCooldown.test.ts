import { TeamTaskStallJournalWorkSyncCooldown } from '@features/member-work-sync/main/adapters/output/TeamTaskStallJournalWorkSyncCooldown';
import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

describe('TeamTaskStallJournalWorkSyncCooldown', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'member-work-sync-watchdog-cooldown-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('detects recent watchdog alerts for the same task', async () => {
    await mkdir(join(root, 'team-a'), { recursive: true });
    await writeFile(
      join(root, 'team-a', 'stall-monitor-journal.json'),
      JSON.stringify([
        {
          taskId: 'task-1',
          state: 'alerted',
          alertedAt: '2026-04-29T00:05:00.000Z',
        },
      ]),
      'utf8'
    );

    const cooldown = new TeamTaskStallJournalWorkSyncCooldown(root, 10 * 60_000);

    await expect(
      cooldown.hasRecentNudge({
        teamName: 'team-a',
        memberName: 'bob',
        taskIds: ['task-1'],
        nowIso: '2026-04-29T00:10:00.000Z',
      })
    ).resolves.toBe(true);
  });

  it('ignores old watchdog alerts and missing journals', async () => {
    await mkdir(join(root, 'team-a'), { recursive: true });
    await writeFile(
      join(root, 'team-a', 'stall-monitor-journal.json'),
      JSON.stringify([
        {
          taskId: 'task-1',
          state: 'alerted',
          alertedAt: '2026-04-29T00:00:00.000Z',
        },
      ]),
      'utf8'
    );

    const cooldown = new TeamTaskStallJournalWorkSyncCooldown(root, 10 * 60_000);

    await expect(
      cooldown.hasRecentNudge({
        teamName: 'team-a',
        memberName: 'bob',
        taskIds: ['task-1'],
        nowIso: '2026-04-29T00:20:00.000Z',
      })
    ).resolves.toBe(false);
    await expect(
      cooldown.hasRecentNudge({
        teamName: 'team-missing',
        memberName: 'bob',
        taskIds: ['task-1'],
        nowIso: '2026-04-29T00:20:00.000Z',
      })
    ).resolves.toBe(false);
  });

  it('fails open when the watchdog journal is invalid', async () => {
    await mkdir(join(root, 'team-a'), { recursive: true });
    await writeFile(join(root, 'team-a', 'stall-monitor-journal.json'), '{bad json', 'utf8');

    const cooldown = new TeamTaskStallJournalWorkSyncCooldown(root, 10 * 60_000);

    await expect(
      cooldown.hasRecentNudge({
        teamName: 'team-a',
        memberName: 'bob',
        taskIds: ['task-1'],
        nowIso: '2026-04-29T00:10:00.000Z',
      })
    ).resolves.toBe(false);

    await writeFile(
      join(root, 'team-a', 'stall-monitor-journal.json'),
      JSON.stringify({ taskId: 'task-1', state: 'alerted' }),
      'utf8'
    );
    await expect(
      cooldown.hasRecentNudge({
        teamName: 'team-a',
        memberName: 'bob',
        taskIds: ['task-1'],
        nowIso: '2026-04-29T00:10:00.000Z',
      })
    ).resolves.toBe(false);
  });
});
