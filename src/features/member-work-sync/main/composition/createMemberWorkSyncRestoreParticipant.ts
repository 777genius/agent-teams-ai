import { BackendSelectingMemberWorkSyncStore } from '../infrastructure/BackendSelectingMemberWorkSyncStore';
import { JsonMemberWorkSyncStore } from '../infrastructure/JsonMemberWorkSyncStore';
import { createMemberWorkSyncStatusVersion } from '../infrastructure/memberWorkSyncStatusVersion';
import { readMemberWorkSyncBackupCandidate } from '../infrastructure/readMemberWorkSyncBackupCandidate';
import { restoreMemberWorkSyncJsonBackup } from '../infrastructure/restoreMemberWorkSyncJsonBackup';

import type { HmacMemberWorkSyncReportTokenAdapter } from '../infrastructure/HmacMemberWorkSyncReportTokenAdapter';
import type { MemberWorkSyncStorePaths } from '../infrastructure/MemberWorkSyncStorePaths';
import type { TokenSecretIdentity } from '../infrastructure/memberWorkSyncTokenSecret';

type RestoreStore = BackendSelectingMemberWorkSyncStore | JsonMemberWorkSyncStore;

async function listLiveStatusMemberNames(store: RestoreStore, teamName: string): Promise<string[]> {
  if (store instanceof JsonMemberWorkSyncStore) {
    return [
      ...new Set(
        (await store.readSnapshotForImport(teamName))?.statuses.map(
          (status) => status.memberName
        ) ?? []
      ),
    ];
  }
  return store.listLiveStatusMemberNames(teamName);
}

async function reissueRestoredReportTokens(
  store: RestoreStore,
  tokens: HmacMemberWorkSyncReportTokenAdapter,
  identity: TokenSecretIdentity
): Promise<void> {
  const issuedAt = new Date().toISOString();
  const backend = store instanceof BackendSelectingMemberWorkSyncStore ? 'sqlite' : 'json';
  for (const memberName of await listLiveStatusMemberNames(store, identity.teamName)) {
    const current = await store.read({ teamName: identity.teamName, memberName });
    if (!current?.reportToken?.trim()) continue;
    const verified = await tokens.verifyForRestore(
      {
        teamName: current.teamName,
        memberName: current.memberName,
        agendaFingerprint: current.agenda.fingerprint,
        token: current.reportToken,
        nowIso: issuedAt,
      },
      identity
    );
    if (verified.ok) continue;
    const issued = await tokens.createForRestore(
      {
        teamName: current.teamName,
        memberName: current.memberName,
        agendaFingerprint: current.agenda.fingerprint,
        issuedAt,
      },
      identity
    );
    await store.write(
      createMemberWorkSyncStatusVersion(
        current,
        {
          ...current,
          reportToken: issued.token,
          reportTokenExpiresAt: issued.expiresAt,
        },
        {
          teamName: current.teamName,
          memberName: current.memberName,
          incarnation: identity.incarnation,
          backend,
        }
      )
    );
  }
}

/** Bound only to the backup owner, never exposed through IPC or the model tool facade. */
export function createMemberWorkSyncRestoreParticipant(
  store: RestoreStore,
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
          await reissueRestoredReportTokens(store, tokens, candidate.identity);
        },
      };
    },
  };
}

export type MemberWorkSyncRestoreParticipant = ReturnType<
  typeof createMemberWorkSyncRestoreParticipant
>;
