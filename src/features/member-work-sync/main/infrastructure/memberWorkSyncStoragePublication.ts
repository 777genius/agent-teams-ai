import {
  assertMemberWorkSyncDirtyContinuity,
  validateMemberWorkSyncAuthoritySnapshot,
  validateMemberWorkSyncPrimaryRecords,
} from './memberWorkSyncAuthorityPreparation';
import { mergeDomainSnapshots } from './memberWorkSyncDomainSnapshotMerge';
import { MemberWorkSyncSafetyJsonReadError } from './memberWorkSyncSafetyJson';
import { mergeMemberWorkSyncSnapshots } from './memberWorkSyncSnapshotMerge';
import {
  areSnapshotRecordSetsEquivalent,
  recordsToSnapshot,
  snapshotToRecords,
} from './memberWorkSyncSqliteMappers';

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

/** Read-only authority plan, after all contributing source snapshots and ownership are validated. */
export async function prepareMemberWorkSyncAuthorityPrimary(input: {
  identity: { teamName: string; incarnation: string };
  canonical: MemberWorkSyncStoreSnapshot;
  candidate: MemberWorkSyncStoreSnapshot | null;
  history: MemberWorkSyncStoreSnapshot;
  primary: MemberWorkSyncTeamSnapshotRecords;
  owner: string | null;
  gateway: MemberWorkSyncStorageGateway;
  replica: InternalStorageJsonReplica<MemberWorkSyncStoreSnapshot>;
  dirty: boolean;
  recovered: boolean;
}): Promise<MemberWorkSyncTeamSnapshotRecords> {
  const { identity, canonical, candidate, primary, owner, gateway, replica } = input;
  const { teamName, incarnation } = identity;
  if (input.dirty) {
    if (input.recovered) throw new MemberWorkSyncSafetyJsonReadError('unavailable');
    await assertMemberWorkSyncDirtyPrimaryOwnership(identity, canonical, owner, gateway);
    const bare =
      !candidate && owner === incarnation ? await replica.readBoundPublication(teamName) : null;
    const ownedBare = bare?.state === 'dirty' && bare.incarnation === incarnation;
    if (
      !ownedBare &&
      (canonical.statuses.length ||
        !candidate ||
        !areSnapshotRecordSetsEquivalent(snapshotToRecords(teamName, candidate), primary))
    )
      assertMemberWorkSyncDirtyContinuity(identity, canonical, candidate);
  }
  const merged = mergeDomainSnapshots(mergeDomainSnapshots(canonical, candidate), input.history);
  const expected = mergeMemberWorkSyncSnapshots(
    teamName,
    primary,
    snapshotToRecords(teamName, merged)
  );
  validateMemberWorkSyncPrimaryRecords(identity, expected);
  validateMemberWorkSyncAuthoritySnapshot(identity, recordsToSnapshot(teamName, expected));
  return expected;
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
    markDirty: () => replica.markDirty(teamName, identity?.incarnation),
    async writeClean(): Promise<void> {
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
