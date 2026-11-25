import { InternalStorageOperationInterruptedError } from '@features/internal-storage/main';

import { MemberWorkSyncSafetyJsonReadError } from './memberWorkSyncSafetyJson';
import {
  areSnapshotRecordSetsEquivalent,
  memberWorkSyncRecordSetDigest,
  recordsToSnapshot,
  snapshotToRecords,
} from './memberWorkSyncSqliteMappers';

import type { MemberWorkSyncStoreSnapshot } from './JsonMemberWorkSyncStore';
import type { captureMemberWorkSyncReplicaPublication } from './memberWorkSyncStoragePublication';
import type { SqliteMemberWorkSyncStore } from './SqliteMemberWorkSyncStore';
import type {
  InternalStorageJsonReplica,
  MemberWorkSyncStorageGateway,
} from '@features/internal-storage/main';

/** Runs inside the existing admitted, normalized team replica mutex. */
export async function prepareMemberWorkSyncColdPrimary(input: {
  teamName: string;
  gateway: MemberWorkSyncStorageGateway;
  replica: InternalStorageJsonReplica<MemberWorkSyncStoreSnapshot>;
  sqlite: SqliteMemberWorkSyncStore;
  publication: Awaited<ReturnType<typeof captureMemberWorkSyncReplicaPublication>>;
  allowDirtyRecovery: boolean;
}): Promise<void> {
  const { teamName, gateway, replica, sqlite, publication } = input;
  const incarnation = publication.identity?.incarnation;
  const pending = await replica.readUnboundImport(teamName);
  if (
    pending &&
    (incarnation !== undefined ||
      !input.allowDirtyRecovery ||
      memberWorkSyncRecordSetDigest(snapshotToRecords(teamName, pending.snapshot)) !==
        pending.expectedDigest)
  )
    throw new MemberWorkSyncSafetyJsonReadError('unavailable');
  const source = pending?.snapshot ?? (await replica.readForPrimary(teamName, input.allowDirtyRecovery));
  const plan = await sqlite.prepareCanonicalImport(teamName, source, incarnation);
  const expected = recordsToSnapshot(teamName, plan.records);
  publication.validateImport(expected, plan.records);
  if (pending) {
    const observed = memberWorkSyncRecordSetDigest(plan.canonicalRecords);
    if (
      (await gateway.ping()).integrity !== 'ok' ||
      (await gateway.readPrimaryIncarnation(teamName)) !== null ||
      (observed !== pending.preimageDigest && observed !== pending.expectedDigest)
    )
      throw new MemberWorkSyncSafetyJsonReadError('unavailable');
  }
  // A prior bound CLEAN publication, or the established nonempty all-status
  // incarnation proof, can migrate pre-v8 state. Bare dirty empty state cannot.
  const importRequired =
    !areSnapshotRecordSetsEquivalent(plan.canonicalRecords, plan.records) ||
    (incarnation !== undefined && publication.primaryIncarnation === null);

  // Retain all validated incoming rows across the import crash window. A dirty
  // candidate is evidence for authority preparation, never permission to replay a claim.
  const candidate = incarnation !== undefined && importRequired ? expected : undefined;
  const unboundImport =
    incarnation === undefined && importRequired
      ? {
          preimageDigest: memberWorkSyncRecordSetDigest(plan.canonicalRecords),
          expectedDigest: memberWorkSyncRecordSetDigest(plan.records),
          snapshot: expected,
        }
      : pending;
  if (
    unboundImport &&
    memberWorkSyncRecordSetDigest(snapshotToRecords(teamName, unboundImport.snapshot)) !==
      unboundImport.expectedDigest
  )
    throw new MemberWorkSyncSafetyJsonReadError('unavailable');
  if (candidate) await replica.markDirtyWithRecoveryCandidate(teamName, incarnation!, candidate);
  else if (unboundImport) {
    if (importRequired) await replica.markDirtyWithUnboundImport(teamName, unboundImport, pending);
  } else await publication.markDirty();
  try {
    if (importRequired)
      await gateway.importTeam(teamName, plan.records, incarnation ? { incarnation } : undefined);
    // Prime the very importer used by ready(), even when no row replacement was necessary.
    await sqlite.prepareCanonicalStatus(teamName, incarnation, {
      records: plan.records,
      filesToArchive: plan.filesToArchive,
      imported: importRequired,
    });
    // Once import is verified, a failed public action must leave the ordinary
    // recoverable fence. Failure of this transition is still an import failure.
    if (candidate) await publication.markDirty();
    else if (unboundImport) await replica.completeUnboundImport(teamName, unboundImport);
  } catch (error) {
    if (unboundImport) {
      // Retain the intent until a new cold reader proves either exact physical outcome.
      if (error instanceof InternalStorageOperationInterruptedError) {
        try {
          await error.settled;
        } catch {
          /* Preserve the original failure and durable intent. */
        }
      }
      throw error;
    }
    try {
      // RPC rejection does not prove the physical writer stopped. Readback must
      // observe the settled worker and the actual replacement database integrity.
      if (error instanceof InternalStorageOperationInterruptedError) await error.settled;
      if ((await gateway.ping()).integrity !== 'ok') throw error;
      if (incarnation && candidate) {
        const current = await replica.readForAuthorityPreparation(teamName, incarnation);
        if (current.state === 'dirty' && current.candidate)
          publication.validateImport(current.candidate, plan.records);
        if (
          current.state !== 'dirty' ||
          !current.candidate ||
          !areSnapshotRecordSetsEquivalent(
            snapshotToRecords(teamName, current.candidate),
            snapshotToRecords(teamName, candidate)
          )
        )
          throw error;
      } else {
        const current = await replica.readBoundPublication(teamName);
        if (
          incarnation ? current?.state !== 'dirty' || current.incarnation !== incarnation : current
        )
          throw error;
      }
      const owner = await gateway.readPrimaryIncarnation(teamName);
      const actual = await gateway.listTeamSnapshot(teamName);
      if (
        owner === (incarnation ?? null) &&
        areSnapshotRecordSetsEquivalent(actual, plan.records)
      ) {
        await publication.writeClean();
      } else if (
        source &&
        owner === publication.primaryIncarnation &&
        areSnapshotRecordSetsEquivalent(actual, plan.canonicalRecords)
      ) {
        // An uncommitted import must retain replica-only rows, not publish just the old primary.
        await replica.writeClean(teamName, source, incarnation);
      }
    } catch {
      /* No complete settled proof: retain the dirty evidence and original failure. */
    }
    throw error;
  }
}
