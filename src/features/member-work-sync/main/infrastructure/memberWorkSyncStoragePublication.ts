import {
  validateMemberWorkSyncAuthoritySnapshot,
  validateMemberWorkSyncPrimaryRecords,
} from './memberWorkSyncAuthorityPreparation';
import { MemberWorkSyncSafetyJsonReadError } from './memberWorkSyncSafetyJson';
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

/** Empty primary state needs durable ownership; legacy nonempty status proof remains valid. */
export async function assertMemberWorkSyncDirtyPrimaryOwnership(
  identity: { teamName: string; incarnation: string },
  canonical: MemberWorkSyncStoreSnapshot,
  primaryIncarnation: string | null,
  gateway: MemberWorkSyncStorageGateway
): Promise<void> {
  if (
    (primaryIncarnation !== identity.incarnation && !canonical.statuses.length) ||
    canonical.statuses.some(
      (status) => status.statusRevision?.incarnation !== identity.incarnation
    ) ||
    (await gateway.ping()).integrity !== 'ok'
  )
    throw new MemberWorkSyncSafetyJsonReadError('unavailable');
}

/** The existing replica mutex owns this entire capture, mutation and publication sequence. */
export async function captureMemberWorkSyncReplicaPublication(
  teamName: string,
  replica: InternalStorageJsonReplica<MemberWorkSyncStoreSnapshot>,
  gateway: MemberWorkSyncStorageGateway,
  allowBoundDirtyPrimaryRecovery = false
) {
  const binding = await replica.readBoundPublication(teamName);
  const identity = binding ? { teamName, incarnation: binding.incarnation } : undefined;
  const primaryIncarnation = await gateway.readPrimaryIncarnation(teamName);
  if (primaryIncarnation !== null && primaryIncarnation !== identity?.incarnation)
    throw new MemberWorkSyncSafetyJsonReadError('unavailable');
  if (identity && binding) {
    if (binding.state === 'clean')
      validateMemberWorkSyncAuthoritySnapshot(identity, binding.snapshot);
    else if (!allowBoundDirtyPrimaryRecovery)
      throw new MemberWorkSyncSafetyJsonReadError('unavailable');
    const records = await gateway.listTeamSnapshot(teamName);
    validateMemberWorkSyncPrimaryRecords(identity, records);
    if (binding.state === 'dirty') {
      const canonical = recordsToSnapshot(teamName, records);
      validateMemberWorkSyncAuthoritySnapshot(identity, canonical);
      await assertMemberWorkSyncDirtyPrimaryOwnership(
        identity,
        canonical,
        primaryIncarnation,
        gateway
      );
    }
  }
  const assertNoUnboundImport = async () => {
    if (await replica.readUnboundImport(teamName))
      throw new MemberWorkSyncSafetyJsonReadError('unavailable');
  };
  return {
    binding,
    identity,
    primaryIncarnation,
    validateImport(
      snapshot: MemberWorkSyncStoreSnapshot,
      records: MemberWorkSyncTeamSnapshotRecords
    ) {
      if (!identity) return;
      validateMemberWorkSyncAuthoritySnapshot(identity, snapshot);
      validateMemberWorkSyncPrimaryRecords(identity, records);
    },
    async markDirty(): Promise<void> {
      await assertNoUnboundImport();
      await replica.markDirty(teamName, identity?.incarnation);
    },
    async writeClean(): Promise<void> {
      await assertNoUnboundImport();
      if ((await gateway.readPrimaryIncarnation(teamName)) !== (identity?.incarnation ?? null))
        throw new MemberWorkSyncSafetyJsonReadError('unavailable');
      const records = await gateway.listTeamSnapshot(teamName);
      if (identity) validateMemberWorkSyncPrimaryRecords(identity, records);
      const snapshot = recordsToSnapshot(teamName, records);
      if (identity) validateMemberWorkSyncAuthoritySnapshot(identity, snapshot);
      await replica.writeClean(teamName, snapshot, identity?.incarnation);
    },
  };
}
