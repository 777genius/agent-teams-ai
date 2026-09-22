import * as fs from 'fs/promises';

import type { BoardTaskExactLogFileVersion } from './BoardTaskExactLogTypes';

const FILE_VERSION_STAT_CONCURRENCY = process.platform === 'win32' ? 8 : 16;

async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let index = 0;
  const workerCount = Math.max(1, Math.min(limit, items.length));
  const workers = new Array(workerCount).fill(0).map(async () => {
    while (true) {
      const currentIndex = index;
      index += 1;
      if (currentIndex >= items.length) {
        return;
      }
      results[currentIndex] = await fn(items[currentIndex]);
    }
  });
  await Promise.all(workers);
  return results;
}

export async function getBoardTaskExactLogFileVersions(
  filePaths: Iterable<string>
): Promise<Map<string, BoardTaskExactLogFileVersion>> {
  const uniqueFilePaths = [...new Set(filePaths)];
  const results = await mapLimit(
    uniqueFilePaths,
    FILE_VERSION_STAT_CONCURRENCY,
    async (filePath) => {
      try {
        const stat = await fs.stat(filePath);
        if (!stat.isFile()) {
          return null;
        }
        return {
          filePath,
          mtimeMs: stat.mtimeMs,
          size: stat.size,
        } satisfies BoardTaskExactLogFileVersion;
      } catch {
        return null;
      }
    }
  );

  const byPath = new Map<string, BoardTaskExactLogFileVersion>();
  for (const item of results) {
    if (!item) continue;
    byPath.set(item.filePath, item);
  }
  return byPath;
}
