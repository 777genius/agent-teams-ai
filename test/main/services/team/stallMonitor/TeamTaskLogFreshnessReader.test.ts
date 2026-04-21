import { createHash } from 'crypto';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import { TeamTaskLogFreshnessReader } from '../../../../../src/main/services/team/stallMonitor/TeamTaskLogFreshnessReader';

const tempDirs: string[] = [];

function safeTaskIdSegment(taskId: string): string {
  return `task-id-${createHash('sha256').update(taskId).digest('hex').slice(0, 32)}`;
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map(async (dirPath) => {
      await fs.rm(dirPath, { recursive: true, force: true });
    })
  );
});

describe('TeamTaskLogFreshnessReader', () => {
  it('reads valid freshness signals and normalizes transcript basename', async () => {
    const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'stall-freshness-'));
    tempDirs.push(projectDir);
    const signalDir = path.join(projectDir, '.board-task-log-freshness');
    await fs.mkdir(signalDir, { recursive: true });

    await fs.writeFile(
      path.join(signalDir, `${encodeURIComponent('task-a')}.json`),
      JSON.stringify({
        taskId: 'task-a',
        updatedAt: '2026-04-19T12:00:00.000Z',
        transcriptFile: '/tmp/nested/session-a.jsonl',
      }),
      'utf8'
    );
    await fs.writeFile(
      path.join(signalDir, `${encodeURIComponent('task-b')}.json`),
      JSON.stringify({
        taskId: 'task-b',
        updatedAt: 'not-a-date',
      }),
      'utf8'
    );

    const signals = await new TeamTaskLogFreshnessReader().readSignals(projectDir, [
      'task-a',
      'task-b',
      'task-missing',
    ]);

    expect([...signals.keys()]).toEqual(['task-a']);
    expect(signals.get('task-a')).toEqual({
      taskId: 'task-a',
      updatedAt: '2026-04-19T12:00:00.000Z',
      filePath: path.join(signalDir, `${encodeURIComponent('task-a')}.json`),
      transcriptFileBasename: 'session-a.jsonl',
    });
  });

  it('reads Windows-safe hashed freshness files for reserved task ids', async () => {
    const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'stall-freshness-'));
    tempDirs.push(projectDir);
    const signalDir = path.join(projectDir, '.board-task-log-freshness');
    await fs.mkdir(signalDir, { recursive: true });

    await fs.writeFile(
      path.join(signalDir, `${safeTaskIdSegment('CON')}.json`),
      JSON.stringify({
        taskId: 'CON',
        updatedAt: '2026-04-19T12:00:00.000Z',
        transcriptFile: 'session-con.jsonl',
      }),
      'utf8'
    );

    const signals = await new TeamTaskLogFreshnessReader().readSignals(projectDir, ['CON']);

    expect(signals.get('CON')?.filePath).toBe(
      path.join(signalDir, `${safeTaskIdSegment('CON')}.json`)
    );
    expect(signals.get('CON')?.transcriptFileBasename).toBe('session-con.jsonl');
  });
});
