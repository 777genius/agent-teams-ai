import { describe, expect, it, vi } from 'vitest';

const statMock = vi.hoisted(() => vi.fn());

vi.mock('fs/promises', () => ({
  stat: statMock,
}));

import { getBoardTaskExactLogFileVersions } from '../../../../src/main/services/team/taskLogs/exact/fileVersions';

describe('getBoardTaskExactLogFileVersions', () => {
  it('deduplicates paths and bounds concurrent stat calls', async () => {
    let activeStats = 0;
    let maxActiveStats = 0;
    const uniquePaths = Array.from({ length: 40 }, (_value, index) => `/tmp/task-${index}.jsonl`);

    statMock.mockImplementation(async (filePath: string) => {
      activeStats += 1;
      maxActiveStats = Math.max(maxActiveStats, activeStats);
      await new Promise((resolve) => setTimeout(resolve, 1));
      activeStats -= 1;

      return {
        isFile: () => !filePath.endsWith('17.jsonl'),
        mtimeMs: 1000 + uniquePaths.indexOf(filePath),
        size: 2000 + uniquePaths.indexOf(filePath),
      };
    });

    const result = await getBoardTaskExactLogFileVersions([
      ...uniquePaths,
      uniquePaths[0]!,
      uniquePaths[1]!,
    ]);

    expect(statMock).toHaveBeenCalledTimes(uniquePaths.length);
    expect(maxActiveStats).toBeGreaterThan(1);
    expect(maxActiveStats).toBeLessThanOrEqual(16);
    expect(result.size).toBe(uniquePaths.length - 1);
    expect(result.has('/tmp/task-17.jsonl')).toBe(false);
    expect(result.get('/tmp/task-0.jsonl')).toEqual({
      filePath: '/tmp/task-0.jsonl',
      mtimeMs: 1000,
      size: 2000,
    });
  });
});
