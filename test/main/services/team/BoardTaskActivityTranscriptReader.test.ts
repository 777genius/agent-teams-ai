import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

import { afterEach, describe, expect, it } from 'vitest';

import { BoardTaskActivityTranscriptReader } from '../../../../src/main/services/team/taskLogs/activity/BoardTaskActivityTranscriptReader';

const tempPaths: string[] = [];

async function createTempTranscript(lines: unknown[]): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'board-task-activity-'));
  const filePath = path.join(dir, 'transcript.jsonl');
  tempPaths.push(dir);
  await fs.writeFile(
    filePath,
    lines.map(line => JSON.stringify(line)).join('\n'),
    'utf8',
  );
  return filePath;
}

afterEach(async () => {
  await Promise.all(
    tempPaths.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })),
  );
});

describe('BoardTaskActivityTranscriptReader', () => {
  it('skips transcript rows without a stable timestamp', async () => {
    const filePath = await createTempTranscript([
      {
        uuid: 'missing-timestamp',
        sessionId: 'session-1',
        boardTaskLinks: [
          {
            schemaVersion: 1,
            task: { ref: 'abcd1234', refKind: 'display' },
            targetRole: 'subject',
            linkKind: 'execution',
            actorContext: { relation: 'same_task' },
          },
        ],
      },
      {
        uuid: 'valid-row',
        timestamp: '2026-04-12T10:00:00.000Z',
        sessionId: 'session-1',
        boardTaskLinks: [
          {
            schemaVersion: 1,
            task: { ref: 'abcd1234', refKind: 'display' },
            targetRole: 'subject',
            linkKind: 'execution',
            actorContext: { relation: 'same_task' },
          },
        ],
      },
    ]);

    const rows = await new BoardTaskActivityTranscriptReader().readFiles([filePath]);

    expect(rows).toHaveLength(1);
    expect(rows[0]?.uuid).toBe('valid-row');
    expect(rows[0]?.timestamp).toBe('2026-04-12T10:00:00.000Z');
  });
});
