import { InternalStorageOperationInterruptedError } from '@features/internal-storage/main';

import type { TeamWorkSyncRestoreAttemptOwner } from './TeamWorkSyncRestoreAttemptOwner';
import type { TeamWorkSyncRestorePending } from './TeamWorkSyncRestorePending';

/** A prepared candidate is validated under the owner fence before any publication. */
export interface TeamWorkSyncBackupRestoreCandidate {
  identityId: string;
  restoreGeneric(): Promise<void>;
  importAndVerify(): Promise<void>;
  invalidate(): Promise<void>;
}

export interface TeamWorkSyncBackupRestorePorts {
  attempts: TeamWorkSyncRestoreAttemptOwner;
  pending: TeamWorkSyncRestorePending;
  /** Startup may continue other teams while this attempt retains its physical locks. */
  reportInterrupted?: (error: InternalStorageOperationInterruptedError) => void;
  withTeamMutex(teamName: string, operation: () => Promise<void>): Promise<void>;
  /** Must revalidate deletion, config identity and the complete backup candidate. */
  prepare(
    teamName: string
  ): Promise<TeamWorkSyncBackupRestoreCandidate | { outcome: 'not_applicable' }>;
}

/** Single restore ordering shared by startup and retries; callers do not hold locks. */
export function restoreTeamWorkSyncBackup(
  ports: TeamWorkSyncBackupRestorePorts,
  teamName: string
): Promise<void> {
  return ports.attempts.run(teamName, () =>
    ports.withTeamMutex(teamName, async () => {
      try {
        const candidate = await ports.prepare(teamName);
        if ('outcome' in candidate) return;
        const pending = await ports.pending.begin(teamName, candidate.identityId);
        await candidate.restoreGeneric();
        await candidate.importAndVerify();
        await candidate.invalidate();
        await ports.pending.clear(teamName, pending);
      } catch (error) {
        if (error instanceof InternalStorageOperationInterruptedError) {
          ports.reportInterrupted?.(error);
          try {
            await error.settled;
          } catch (settlementError) {
            throw new AggregateError(
              [error, settlementError],
              'Restore physical settlement failed'
            );
          }
        }
        throw error;
      }
    })
  );
}
