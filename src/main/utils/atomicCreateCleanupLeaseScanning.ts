import * as fs from 'fs';

/** Enumerate at most one more lease than capacity so overload fails closed. */
export async function boundedLeaseDirectories(
  directoryPath: string,
  prefixes: readonly string[],
  capacity: number
): Promise<string[]> {
  const directory = await fs.promises.opendir(directoryPath);
  const names: string[] = [];
  try {
    for await (const entry of directory) {
      if (!entry.isDirectory() || !prefixes.some((prefix) => entry.name.startsWith(prefix))) continue;
      names.push(entry.name);
      if (names.length > capacity) break;
    }
  } finally {
    await directory.close().catch(() => undefined);
  }
  return names;
}
