import {
  validateMemberWorkSyncAuthoritySnapshot,
  validateMemberWorkSyncPrimaryRecords,
} from './memberWorkSyncAuthorityPreparation';
import { recordsToSnapshot } from './memberWorkSyncSqliteMappers';

import type { MemberWorkSyncStoreSnapshot } from './JsonMemberWorkSyncStore';
import type { StaleIncarnationHealInput } from './memberWorkSyncStaleIncarnationHeal';
import type { MemberWorkSyncStorePaths } from './MemberWorkSyncStorePaths';
import type { AdmittedLegacySourceWrite } from '@agent-teams/legacy-agent-host/lifecycle';
import type { MemberWorkSyncTeamSnapshotRecords } from '@features/internal-storage/contracts/internalStorageContracts';
import type {
  InternalStorageJsonReplica,
  MemberWorkSyncStorageGateway,
} from '@features/internal-storage/main';

export type { PendingPrimaryPurgeMarker } from './memberWorkSyncPurgeMarker';
export { parseDurablePathIdentity as parseMemberWorkSyncDurablePathIdentity } from './memberWorkSyncPurgeMarker';

/** Internal storage restriction reader; privileged lifecycle ownership is composed privately. */
export interface MemberWorkSyncSourcePublication {
  current(teamName: string): AdmittedLegacySourceWrite | undefined;
}

export interface BackendSelectingMemberWorkSyncStoreOptions {
  sourceWriteAdmission?: MemberWorkSyncSourcePublication;
  gateway: MemberWorkSyncStorageGateway;
  paths: MemberWorkSyncStorePaths;
  fallbackRequiresReplica: boolean;
  readTeamRootStats?: StaleIncarnationHealInput['readTeamRootStats'];
  logger?: { warn(message: string, metadata?: Record<string, unknown>): void };
}

/** Local storage work retains the original source admission; absent configured scope is an error. */
export function publishMemberWorkSyncLocal<T>(
  policy: MemberWorkSyncSourcePublication | undefined,
  teamName: string,
  operation: () => Promise<T>
): Promise<T> {
  const admission = policy?.current(teamName);
  return admission ? admission.publish(operation) : operation();
}

/** The existing replica mutex owns this entire capture, mutation and publication sequence. */
export async function captureMemberWorkSyncReplicaPublication(
  teamName: string,
  replica: InternalStorageJsonReplica<MemberWorkSyncStoreSnapshot>,
  gateway: MemberWorkSyncStorageGateway
) {
  const binding = await replica.readBoundClean(teamName);
  const identity = binding ? { teamName, incarnation: binding.incarnation } : undefined;
  if (identity && binding) {
    validateMemberWorkSyncAuthoritySnapshot(identity, binding.snapshot);
    validateMemberWorkSyncPrimaryRecords(identity, await gateway.listTeamSnapshot(teamName));
  }
  return {
    validateImport(
      snapshot: MemberWorkSyncStoreSnapshot,
      records: MemberWorkSyncTeamSnapshotRecords
    ) {
      if (!identity) return;
      validateMemberWorkSyncAuthoritySnapshot(identity, snapshot);
      validateMemberWorkSyncPrimaryRecords(identity, records);
    },
    markDirty: () => replica.markDirty(teamName, identity?.incarnation),
    async writeClean(): Promise<void> {
      const records = await gateway.listTeamSnapshot(teamName);
      if (identity) validateMemberWorkSyncPrimaryRecords(identity, records);
      const snapshot = recordsToSnapshot(teamName, records);
      if (identity) validateMemberWorkSyncAuthoritySnapshot(identity, snapshot);
      await replica.writeClean(teamName, snapshot, identity?.incarnation);
    },
  };
}
