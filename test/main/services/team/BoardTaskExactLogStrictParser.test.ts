import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

import { BoardTaskExactLogStrictParser } from '../../../../src/main/services/team/taskLogs/exact/BoardTaskExactLogStrictParser';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0, tempDirs.length).map(async (dirPath) => {
      await fs.rm(dirPath, { recursive: true, force: true });
    }),
  );
});

describe('BoardTaskExactLogStrictParser', () => {
  it('drops malformed timestamp rows instead of assigning them synthetic time', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'exact-log-parser-'));
    tempDirs.push(tempDir);

    const filePath = path.join(tempDir, 'session.jsonl');
    await fs.writeFile(
      filePath,
      [
        JSON.stringify({
          uuid: 'bad-ts',
          type: 'assistant',
          timestamp: 'not-a-real-date',
          message: { role: 'assistant', content: 'bad row' },
        }),
        JSON.stringify({
          uuid: 'good-ts',
          type: 'assistant',
          timestamp: '2026-04-12T18:00:00.000Z',
          message: { role: 'assistant', content: 'good row' },
        }),
      ].join('\n'),
      'utf8',
    );

    const parsed = await new BoardTaskExactLogStrictParser().parseFiles([filePath]);

    expect(parsed.get(filePath)?.map((message) => message.uuid)).toEqual(['good-ts']);
  });
});
