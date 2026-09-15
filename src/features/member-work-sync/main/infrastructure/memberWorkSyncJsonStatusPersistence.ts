import { readFile } from 'node:fs/promises';

import { withFileLock } from '@main/services/team/fileLock';
import { atomicWriteAsync } from '@main/utils/atomicWrite';

import type { MemberWorkSyncStatus } from '../../contracts';

export type MemberWorkSyncJsonStatusSnapshot =
  | { state: 'absent'; raw: null }
  | { state: 'present'; raw: string; payload: Record<string, unknown> }
  | { state: 'corrupt' | 'unavailable'; raw?: string };

export type MemberWorkSyncJsonStatusCommit =
  | { committed: true; raw: string; projectionDegraded: boolean }
  | { committed: false; reason: 'conflict'; current: MemberWorkSyncJsonStatusSnapshot }
  | { committed: false; reason: 'corrupt' | 'unavailable' | 'write_failed' }
  | { committed: 'unknown'; reason: 'commit_unknown'; mutationId: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Canonical-file read only. Never quarantines, falls back to legacy, or repairs evidence. */
export async function readMemberWorkSyncJsonStatus(
  path: string
): Promise<MemberWorkSyncJsonStatusSnapshot> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT'
      ? { state: 'absent', raw: null }
      : { state: 'unavailable' };
  }
  try {
    const file: unknown = JSON.parse(raw);
    if (!isRecord(file) || file.schemaVersion !== 2 || !isRecord(file.status)) {
      return { state: 'corrupt', raw };
    }
    // Domain/lifecycle validation belongs to the authority adapter. Keeping the
    // payload unknown prevents this envelope check being mistaken for that proof.
    return { state: 'present', raw, payload: file.status };
  } catch {
    return { state: 'corrupt', raw };
  }
}

/**
 * Caller holds the existing team queue and metrics-index lock, in that order.
 * This primitive adds the member lock last; lifecycle admission stays outside
 * the entire operation. No caller may treat a raw snapshot as fresh incarnation proof.
 */
export async function compareAndWriteMemberWorkSyncJsonStatus(input: {
  path: string;
  expectedRaw: string | null;
  mutationId: string;
  nextStatus: MemberWorkSyncStatus;
  project: () => Promise<void>;
}): Promise<MemberWorkSyncJsonStatusCommit> {
  return withFileLock(
    input.path,
    async () => {
      const current = await readMemberWorkSyncJsonStatus(input.path);
      if (current.state === 'corrupt' || current.state === 'unavailable') {
        return { committed: false, reason: current.state };
      }
      if (current.raw !== input.expectedRaw) {
        return { committed: false, reason: 'conflict', current };
      }
      const raw = `${JSON.stringify({ schemaVersion: 2, status: input.nextStatus }, null, 2)}\n`;
      let publishStarted = false;
      try {
        await atomicWriteAsync(input.path, raw, {
          durability: 'strict',
          syncDirectory: true,
          beforeCommit: async () => {
            publishStarted = true;
          },
        });
      } catch {
        return publishStarted
          ? { committed: 'unknown', reason: 'commit_unknown', mutationId: input.mutationId }
          : { committed: false, reason: 'write_failed' };
      }
      try {
        await input.project();
        return { committed: true, raw, projectionDegraded: false };
      } catch {
        // Metrics are a projection. A post-commit failure cannot invite a second
        // accepted lease or budget debit by pretending the authority write failed.
        return { committed: true, raw, projectionDegraded: true };
      }
    },
    { preventLiveOwnerTakeover: true }
  );
}
