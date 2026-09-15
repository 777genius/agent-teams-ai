import {
  assertMemberWorkSyncDirtyContinuity,
  validateMemberWorkSyncAuthoritySnapshot,
} from './memberWorkSyncAuthorityPreparation';
import { mergeDomainSnapshots } from './memberWorkSyncDomainSnapshotMerge';
import { MemberWorkSyncSafetyJsonReadError } from './memberWorkSyncSafetyJson';

import type { MemberWorkSyncStoreSnapshot } from './JsonMemberWorkSyncStore';
import type { readMemberWorkSyncBackupCandidate } from './readMemberWorkSyncBackupCandidate';

export type MemberWorkSyncBackupCandidate = Awaited<
  ReturnType<typeof readMemberWorkSyncBackupCandidate>
>;

/** Called under the existing backend mutex before the first target mutation. */
export function mergeMemberWorkSyncBackupHistory(input: {
  identity: { teamName: string; incarnation: string };
  backend: 'json' | 'sqlite';
  recovered: boolean;
  canonical: MemberWorkSyncStoreSnapshot;
  history: MemberWorkSyncStoreSnapshot;
  backup: MemberWorkSyncBackupCandidate;
}): MemberWorkSyncStoreSnapshot {
  const { identity, backup } = input;
  if (
    backup.identity.teamName !== identity.teamName ||
    backup.identity.incarnation !== identity.incarnation
  ) {
    throw new MemberWorkSyncSafetyJsonReadError('corrupt');
  }
  validateMemberWorkSyncAuthoritySnapshot(identity, backup.history);
  const snapshot =
    backup.replica.state === 'clean'
      ? backup.replica.snapshot
      : backup.replica.state === 'dirty'
        ? backup.replica.candidate
        : null;
  if (snapshot) validateMemberWorkSyncAuthoritySnapshot(identity, snapshot);
  if (backup.replica.state === 'dirty') {
    if (input.backend === 'json' || input.recovered)
      throw new MemberWorkSyncSafetyJsonReadError('unavailable');
    assertMemberWorkSyncDirtyContinuity(identity, input.canonical, snapshot);
  }
  const backupHistory = mergeDomainSnapshots(backup.history, snapshot);
  // Source archive paths never become target finalization work.
  return {
    ...mergeDomainSnapshots(input.history, backupHistory),
    filesToArchive: input.history.filesToArchive,
  };
}
