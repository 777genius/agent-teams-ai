import { BackendSelectingMemberWorkSyncStore } from '../infrastructure/BackendSelectingMemberWorkSyncStore';
import { createMemberWorkSyncStatusVersion } from '../infrastructure/memberWorkSyncStatusVersion';
import { readMemberWorkSyncBackupCandidate } from '../infrastructure/readMemberWorkSyncBackupCandidate';
import { restoreMemberWorkSyncJsonBackup } from '../infrastructure/restoreMemberWorkSyncJsonBackup';

import type { HmacMemberWorkSyncReportTokenAdapter } from '../infrastructure/HmacMemberWorkSyncReportTokenAdapter';
import type { JsonMemberWorkSyncStore } from '../infrastructure/JsonMemberWorkSyncStore';
import type { MemberWorkSyncStorePaths } from '../infrastructure/MemberWorkSyncStorePaths';
import type { MemberWorkSyncBackupCandidate } from '../infrastructure/mergeMemberWorkSyncBackupHistory';

function restoredMemberNames(candidate: MemberWorkSyncBackupCandidate): string[] {
  const names = new Set<string>();
  for (const status of candidate.history.statuses) names.add(status.memberName);
  const replica =
    candidate.replica.state === 'clean'
      ? candidate.replica.snapshot
      : candidate.replica.state === 'dirty'
        ? candidate.replica.candidate
        : null;
  for (const status of replica?.statuses ?? []) names.add(status.memberName);
  return [...names];
}

async function reissueRestoredReportTokens(
  store: BackendSelectingMemberWorkSyncStore | JsonMemberWorkSyncStore,
  tokens: HmacMemberWorkSyncReportTokenAdapter,
  candidate: MemberWorkSyncBackupCandidate
): Promise<void> {
  const issuedAt = new Date().toISOString();
  for (const memberName of restoredMemberNames(candidate)) {
    const current = await store.read({ teamName: candidate.identity.teamName, memberName });
    if (!current?.reportToken?.trim()) continue;
    const issued = await tokens.create({
      teamName: current.teamName,
      memberName: current.memberName,
      agendaFingerprint: current.agenda.fingerprint,
      issuedAt,
    });
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
          incarnation: candidate.identity.incarnation,
          backend: store instanceof BackendSelectingMemberWorkSyncStore ? 'sqlite' : 'json',
        }
      )
    );
  }
}

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
          const { rotated } = await tokens.restoreBackupSecret(
            input.teamName,
            candidate.secretJson,
            candidate.identity
          );
          if (rotated) await reissueRestoredReportTokens(store, tokens, candidate);
        },
      };
    },
  };
}

export type MemberWorkSyncRestoreParticipant = ReturnType<
  typeof createMemberWorkSyncRestoreParticipant
>;
