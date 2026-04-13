import * as fs from 'fs/promises';

import type { BoardTaskExactLogFileVersion } from './BoardTaskExactLogTypes';

export async function getBoardTaskExactLogFileVersions(
  filePaths: Iterable<string>
): Promise<Map<string, BoardTaskExactLogFileVersion>> {
  const uniqueFilePaths = [...new Set(filePaths)];
  const results = await Promise.all(
    uniqueFilePaths.map(async (filePath) => {
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
    })
  );

  const byPath = new Map<string, BoardTaskExactLogFileVersion>();
  for (const item of results) {
    if (!item) continue;
    byPath.set(item.filePath, item);
  }
  return byPath;
}
