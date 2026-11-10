import { readFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { mergeDomainSnapshots } from './memberWorkSyncDomainSnapshotMerge';
import { MemberWorkSyncSafetyJsonReadError } from './memberWorkSyncSafetyJson';
import { areSnapshotRecordSetsEquivalent, snapshotToRecords } from './memberWorkSyncSqliteMappers';
import { mergeMemberWorkSyncBackupHistory } from './mergeMemberWorkSyncBackupHistory';
import { readMemberWorkSyncBackupCandidate } from './readMemberWorkSyncBackupCandidate';

import type { JsonMemberWorkSyncStore } from './JsonMemberWorkSyncStore';
import type { MemberWorkSyncStorePaths } from './MemberWorkSyncStorePaths';
import type { MemberWorkSyncBackupCandidate } from './mergeMemberWorkSyncBackupHistory';

/** Privileged plain-JSON restore; backup owner holds lifecycle + team locks and drains users. */
export async function restoreMemberWorkSyncJsonBackup(
  store: JsonMemberWorkSyncStore,
  paths: MemberWorkSyncStorePaths,
  backup: MemberWorkSyncBackupCandidate,
  preflightOnly = false
): Promise<void> {
  const identity = backup.identity;
  try {
    await readFile(paths.getPendingPrimaryPurgePath(identity.teamName));
    throw new MemberWorkSyncSafetyJsonReadError('unavailable');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const live = await readMemberWorkSyncBackupCandidate({
    ...identity,
    secretReadPolicy: 'live-restore',
    backupTeamsRoot: dirname(paths.getTeamRootDir(identity.teamName)),
  });
  if (live.replica.state === 'dirty') throw new MemberWorkSyncSafetyJsonReadError('unavailable');
  const canonical = mergeDomainSnapshots(
    live.history,
    live.replica.state === 'clean' ? live.replica.snapshot : null
  );
  const merged = mergeMemberWorkSyncBackupHistory({
    identity,
    backend: 'json',
    recovered: false,
    canonical,
    history: canonical,
    backup,
  });
  if (preflightOnly) return;
  await store.restoreReplicaSnapshot(identity.teamName, { ...merged, filesToArchive: [] });
  const actual = await store.readSnapshotForImport(identity.teamName);
  if (
    !actual ||
    !areSnapshotRecordSetsEquivalent(
      snapshotToRecords(identity.teamName, actual),
      snapshotToRecords(identity.teamName, merged)
    )
  )
    throw new MemberWorkSyncSafetyJsonReadError('unavailable');
}
