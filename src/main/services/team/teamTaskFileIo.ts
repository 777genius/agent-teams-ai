import { readFileUtf8WithTimeout } from '@main/utils/fsRead';
import { mapWithConcurrency } from '@main/utils/mapWithConcurrency';
import * as fs from 'fs';

/**
 * Task directories hold one small JSON file per task. Reading them strictly one
 * await at a time makes a cold open latency-bound (a team with ~1000 tasks pays
 * ~1000 sequential disk round trips), so stats and reads run in bounded
 * parallel batches. Results keep input order and carry errors as values so the
 * caller keeps its per-file skip semantics.
 */
export const TASK_FILE_IO_CONCURRENCY = 32;

export type TaskFileStatResult = { stat: fs.Stats } | { error: unknown };
export type TaskFileReadResult = { raw: string } | { error: unknown };

export function statTaskFiles(paths: readonly string[]): Promise<TaskFileStatResult[]> {
  return mapWithConcurrency(paths, TASK_FILE_IO_CONCURRENCY, (filePath) =>
    fs.promises.stat(filePath).then(
      (stat) => ({ stat }),
      (error: unknown) => ({ error })
    )
  );
}

/** Task JSON files in a team tasks directory (skips dotfiles and the lock/watermark files). */
export function listTaskFileNames(entries: readonly string[]): string[] {
  return entries.filter(
    (file) =>
      file.endsWith('.json') &&
      !file.startsWith('.') &&
      file !== '.lock' &&
      file !== '.highwatermark'
  );
}

/**
 * At each batch boundary, reads the next batch of not-yet-cached files in parallel
 * and stores the results by path; the caller consumes them in order.
 */
export async function prefetchTaskFileBatch<T extends { taskPath: string }>(
  files: readonly T[],
  index: number,
  isCached: (file: T) => boolean,
  into: Map<string, TaskFileReadResult>
): Promise<void> {
  if (index % TASK_FILE_IO_CONCURRENCY !== 0) return;
  const batch = files.slice(index, index + TASK_FILE_IO_CONCURRENCY).filter((f) => !isCached(f));
  const reads = await readTaskFiles(batch.map((f) => f.taskPath));
  batch.forEach((f, i) => into.set(f.taskPath, reads[i]));
}

export function readTaskFiles(paths: readonly string[]): Promise<TaskFileReadResult[]> {
  return mapWithConcurrency(paths, TASK_FILE_IO_CONCURRENCY, (filePath) =>
    readFileUtf8WithTimeout(filePath, 5_000).then(
      (raw) => ({ raw }),
      (error: unknown) => ({ error })
    )
  );
}
