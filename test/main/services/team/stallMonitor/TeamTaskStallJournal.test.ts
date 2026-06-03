import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import { TeamTaskStallJournal } from '../../../../../src/main/services/team/stallMonitor/TeamTaskStallJournal';
import { setClaudeBasePathOverride } from '../../../../../src/main/utils/pathDecoder';

describe('TeamTaskStallJournal', () => {
  let tmpDir: string | null = null;

  afterEach(async () => {
    setClaudeBasePathOverride(null);
    if (tmpDir) {
      await fs.rm(tmpDir, { recursive: true, force: true });
      tmpDir = null;
    }
  });

  it('requires two scans before returning an alert-ready candidate', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'stall-journal-'));
    setClaudeBasePathOverride(tmpDir);
    await fs.mkdir(path.join(tmpDir, 'teams', 'demo'), { recursive: true });

    const journal = new TeamTaskStallJournal();
    const evaluation = {
      status: 'alert',
      taskId: 'task-a',
      branch: 'work',
      signal: 'turn_ended_after_touch',
      epochKey: 'task-a:epoch-1',
      reason: 'Potential work stall',
    } as const;

    const firstReady = await journal.reconcileScan({
      teamName: 'demo',
      evaluations: [evaluation],
      activeTaskIds: ['task-a'],
      now: '2026-04-19T12:10:00.000Z',
    });
    const secondReady = await journal.reconcileScan({
      teamName: 'demo',
      evaluations: [evaluation],
      activeTaskIds: ['task-a'],
      now: '2026-04-19T12:11:00.000Z',
    });

    expect(firstReady).toEqual([]);
    expect(secondReady).toEqual([evaluation]);
  });

  it('allows the same stalled epoch to alert again after the cooldown expires', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'stall-journal-'));
    setClaudeBasePathOverride(tmpDir);
    await fs.mkdir(path.join(tmpDir, 'teams', 'demo'), { recursive: true });

    const journal = new TeamTaskStallJournal({ alertCooldownMs: 10 * 60_000 });
    const evaluation = {
      status: 'alert',
      taskId: 'task-a',
      branch: 'work',
      signal: 'turn_ended_after_touch',
      epochKey: 'task-a:epoch-1',
      reason: 'Potential work stall',
    } as const;

    await journal.reconcileScan({
      teamName: 'demo',
      evaluations: [evaluation],
      activeTaskIds: ['task-a'],
      now: '2026-04-19T12:00:00.000Z',
    });
    await expect(
      journal.reconcileScan({
        teamName: 'demo',
        evaluations: [evaluation],
        activeTaskIds: ['task-a'],
        now: '2026-04-19T12:01:00.000Z',
      })
    ).resolves.toEqual([evaluation]);
    await journal.markAlerted('demo', 'task-a:epoch-1', '2026-04-19T12:01:00.000Z');

    await expect(
      journal.reconcileScan({
        teamName: 'demo',
        evaluations: [evaluation],
        activeTaskIds: ['task-a'],
        now: '2026-04-19T12:05:00.000Z',
      })
    ).resolves.toEqual([]);
    await expect(
      journal.reconcileScan({
        teamName: 'demo',
        evaluations: [evaluation],
        activeTaskIds: ['task-a'],
        now: '2026-04-19T12:12:00.000Z',
      })
    ).resolves.toEqual([evaluation]);
  });

  it('does not suppress a stalled epoch forever when alertedAt is in the future', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'stall-journal-'));
    setClaudeBasePathOverride(tmpDir);
    const teamDir = path.join(tmpDir, 'teams', 'demo');
    await fs.mkdir(teamDir, { recursive: true });
    await fs.writeFile(
      path.join(teamDir, 'stall-monitor-journal.json'),
      JSON.stringify([
        {
          epochKey: 'task-a:epoch-1',
          teamName: 'demo',
          taskId: 'task-a',
          branch: 'work',
          signal: 'turn_ended_after_touch',
          state: 'alerted',
          consecutiveScans: 2,
          createdAt: '2026-04-19T12:00:00.000Z',
          updatedAt: '2026-04-19T12:01:00.000Z',
          alertedAt: '2026-04-19T13:00:00.000Z',
        },
      ]),
      'utf8'
    );

    const journal = new TeamTaskStallJournal({ alertCooldownMs: 10 * 60_000 });
    const evaluation = {
      status: 'alert',
      taskId: 'task-a',
      branch: 'work',
      signal: 'turn_ended_after_touch',
      epochKey: 'task-a:epoch-1',
      reason: 'Potential work stall',
    } as const;

    await expect(
      journal.reconcileScan({
        teamName: 'demo',
        evaluations: [evaluation],
        activeTaskIds: ['task-a'],
        now: '2026-04-19T12:05:00.000Z',
      })
    ).resolves.toEqual([evaluation]);
  });

  it('does not prune journal entries outside an explicit task scope', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'stall-journal-'));
    setClaudeBasePathOverride(tmpDir);
    const teamDir = path.join(tmpDir, 'teams', 'demo');
    await fs.mkdir(teamDir, { recursive: true });
    const journalPath = path.join(teamDir, 'stall-monitor-journal.json');
    await fs.writeFile(
      journalPath,
      JSON.stringify(
        [
          {
            epochKey: 'task-codex:epoch-1',
            teamName: 'demo',
            taskId: 'task-codex',
            branch: 'work',
            signal: 'turn_ended_after_touch',
            state: 'suspected',
            consecutiveScans: 1,
            createdAt: '2026-04-19T12:00:00.000Z',
            updatedAt: '2026-04-19T12:00:00.000Z',
          },
          {
            epochKey: 'task-opencode:epoch-1',
            teamName: 'demo',
            taskId: 'task-opencode',
            branch: 'work',
            signal: 'turn_ended_after_touch',
            state: 'suspected',
            consecutiveScans: 1,
            createdAt: '2026-04-19T12:00:00.000Z',
            updatedAt: '2026-04-19T12:00:00.000Z',
          },
        ],
        null,
        2
      )
    );

    const journal = new TeamTaskStallJournal();
    await journal.reconcileScan({
      teamName: 'demo',
      evaluations: [],
      activeTaskIds: ['task-codex', 'task-opencode'],
      scopeTaskIds: ['task-opencode'],
      now: '2026-04-19T12:10:00.000Z',
    });

    const saved = JSON.parse(await fs.readFile(journalPath, 'utf8')) as Array<{
      epochKey: string;
    }>;
    expect(saved.map((entry) => entry.epochKey)).toEqual(['task-codex:epoch-1']);
  });

  it('backfills member name on existing stall entries before alerting', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'stall-journal-'));
    setClaudeBasePathOverride(tmpDir);
    const teamDir = path.join(tmpDir, 'teams', 'demo');
    await fs.mkdir(teamDir, { recursive: true });
    const journalPath = path.join(teamDir, 'stall-monitor-journal.json');
    await fs.writeFile(
      journalPath,
      JSON.stringify([
        {
          epochKey: 'task-a:epoch-1',
          teamName: 'demo',
          taskId: 'task-a',
          branch: 'work',
          signal: 'turn_ended_after_touch',
          state: 'suspected',
          consecutiveScans: 1,
          createdAt: '2026-04-19T12:00:00.000Z',
          updatedAt: '2026-04-19T12:00:00.000Z',
        },
      ]),
      'utf8'
    );

    const journal = new TeamTaskStallJournal();
    const evaluation = {
      status: 'alert',
      taskId: 'task-a',
      memberName: 'bob',
      branch: 'work',
      signal: 'turn_ended_after_touch',
      epochKey: 'task-a:epoch-1',
      reason: 'Potential work stall',
    } as const;

    await expect(
      journal.reconcileScan({
        teamName: 'demo',
        evaluations: [evaluation],
        activeTaskIds: ['task-a'],
        now: '2026-04-19T12:10:00.000Z',
      })
    ).resolves.toEqual([evaluation]);

    const saved = JSON.parse(await fs.readFile(journalPath, 'utf8')) as Array<{
      epochKey: string;
      memberName?: string;
      state: string;
    }>;
    expect(saved).toEqual([
      expect.objectContaining({
        epochKey: 'task-a:epoch-1',
        memberName: 'bob',
        state: 'alert_ready',
      }),
    ]);
  });

  it('recovers from an invalid journal file on the next scan', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'stall-journal-'));
    setClaudeBasePathOverride(tmpDir);
    const teamDir = path.join(tmpDir, 'teams', 'demo');
    await fs.mkdir(teamDir, { recursive: true });
    const journalPath = path.join(teamDir, 'stall-monitor-journal.json');
    await fs.writeFile(journalPath, '{bad json', 'utf8');

    const journal = new TeamTaskStallJournal();
    const evaluation = {
      status: 'alert',
      taskId: 'task-a',
      branch: 'work',
      signal: 'turn_ended_after_touch',
      epochKey: 'task-a:epoch-1',
      reason: 'Potential work stall',
    } as const;

    await expect(
      journal.reconcileScan({
        teamName: 'demo',
        evaluations: [evaluation],
        activeTaskIds: ['task-a'],
        now: '2026-04-19T12:10:00.000Z',
      })
    ).resolves.toEqual([]);

    const saved = JSON.parse(await fs.readFile(journalPath, 'utf8')) as Array<{
      epochKey: string;
      state: string;
    }>;
    expect(saved).toEqual([
      expect.objectContaining({
        epochKey: 'task-a:epoch-1',
        state: 'suspected',
      }),
    ]);
  });
});
