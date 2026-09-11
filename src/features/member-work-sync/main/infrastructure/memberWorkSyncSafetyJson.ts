import { readFile } from 'node:fs/promises';

import type { MemberWorkSyncStatus } from '../../contracts';

export class MemberWorkSyncSafetyJsonReadError extends Error {
  constructor(readonly reason: 'corrupt' | 'unavailable') {
    super(`Member work sync safety state is ${reason}`);
    this.name = 'MemberWorkSyncSafetyJsonReadError';
  }
}

/** Missing is a distinct input; a failed read never deletes or replaces evidence. */
export async function readMemberWorkSyncSafetyJson<T>(
  path: string,
  guard: (value: unknown) => value is T,
  absent: T,
  allowAbsent = true
): Promise<T> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    if (allowAbsent && (error as NodeJS.ErrnoException).code === 'ENOENT') return absent;
    throw new MemberWorkSyncSafetyJsonReadError('unavailable');
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new MemberWorkSyncSafetyJsonReadError('corrupt');
  }
  if (!guard(value)) throw new MemberWorkSyncSafetyJsonReadError('corrupt');
  return value;
}

/** Envelope validation only; trusted identity and full domain decoding remain separate. */
export function isMemberStatusFile(
  value: unknown
): value is { schemaVersion: 2; status: MemberWorkSyncStatus } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const file = value as Record<string, unknown>;
  return (
    file.schemaVersion === 2 &&
    file.status !== null &&
    typeof file.status === 'object' &&
    !Array.isArray(file.status)
  );
}
