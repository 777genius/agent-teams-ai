import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs/promises';

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
});
