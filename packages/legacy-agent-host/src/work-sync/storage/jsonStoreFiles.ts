import { mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { atomicWriteAsync, renamePathWithRetry } from '@agent-teams/task-change-ledger/review-io';
import type { AtomicWriteOptions } from '@agent-teams/task-change-ledger/review-io';

export async function quarantineFile(filePath: string): Promise<void> {
  try {
    await renamePathWithRetry(filePath, `${filePath}.invalid.${Date.now()}`);
  } catch {
    // If quarantine fails, keep the feature degraded but do not block team operation.
  }
}

export async function readJsonFile<T>(
  filePath: string,
  guard: (value: unknown) => value is T,
  fallback: T,
  options: { quarantineInvalid?: boolean; strict?: boolean; assertCurrent?: () => void } = {}
): Promise<T> {
  try {
    options.assertCurrent?.();
    const raw = await readFile(filePath, 'utf8');
    options.assertCurrent?.();
    const parsed = JSON.parse(raw);
    if (guard(parsed)) {
      return parsed;
    }
    if (options.strict) throw new Error('Invalid member work sync index');
    if (options.quarantineInvalid) {
      await quarantineFile(filePath);
    }
  } catch (error) {
    if (options.strict && (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && options.quarantineInvalid) {
      await quarantineFile(filePath);
    }
  }
  return fallback;
}

export async function writeJsonFile(
  filePath: string,
  value: unknown,
  options: AtomicWriteOptions = {}
): Promise<void> {
  options.assertCurrent?.();
  await mkdir(dirname(filePath), { recursive: true });
  options.assertCurrent?.();
  await atomicWriteAsync(filePath, `${JSON.stringify(value, null, 2)}\n`, options);
}
