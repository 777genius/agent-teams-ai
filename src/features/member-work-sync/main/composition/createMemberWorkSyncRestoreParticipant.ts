import { BackendSelectingMemberWorkSyncStore } from '../infrastructure/BackendSelectingMemberWorkSyncStore';
import { readMemberWorkSyncBackupCandidate } from '../infrastructure/readMemberWorkSyncBackupCandidate';
import { restoreMemberWorkSyncJsonBackup } from '../infrastructure/restoreMemberWorkSyncJsonBackup';

import type { HmacMemberWorkSyncReportTokenAdapter } from '../infrastructure/HmacMemberWorkSyncReportTokenAdapter';
import type { JsonMemberWorkSyncStore } from '../infrastructure/JsonMemberWorkSyncStore';
import type { MemberWorkSyncStorePaths } from '../infrastructure/MemberWorkSyncStorePaths';

/** Bound only to the backup owner, never exposed through IPC or the model tool facade. */
export function createMemberWorkSyncRestoreParticipant(
  store: BackendSelectingMemberWorkSyncStore | JsonMemberWorkSyncStore,
  tokens: HmacMemberWorkSyncReportTokenAdapter,
  paths: MemberWorkSyncStorePaths
) {
  return {
    /** Caller owns lifecycle fence and team mutex, and has drained admissions. */
    async prepare(input: { backupTeamsRoot: string; teamName: string; incarnation: string }) {
      const candidate = await readMemberWorkSyncBackupCandidate(input);
      if (store instanceof BackendSelectingMemberWorkSyncStore)
        await store.preflightValidatedBackup(candidate);
      else await restoreMemberWorkSyncJsonBackup(store, paths, candidate, true);
      return {
        async importAndVerify(): Promise<void> {
          if (store instanceof BackendSelectingMemberWorkSyncStore)
            await store.restoreValidatedBackup(candidate);
          else await restoreMemberWorkSyncJsonBackup(store, paths, candidate);
          await tokens.restoreBackupSecret(
            input.teamName,
            candidate.secretJson,
            candidate.identity
          );
        },
      };
    },
  };
}

export type MemberWorkSyncRestoreParticipant = ReturnType<
  typeof createMemberWorkSyncRestoreParticipant
>;
