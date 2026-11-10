import { withFileLock } from '@main/services/team/fileLock';
import { atomicWriteAsync } from '@main/utils/atomicWrite';

import { mergeDomainSnapshots } from './memberWorkSyncDomainSnapshotMerge';
import {
  compareAndWriteMemberWorkSyncJsonStatus,
  readMemberWorkSyncJsonStatus,
} from './memberWorkSyncJsonStatusPersistence';
import { MemberWorkSyncSafetyJsonReadError } from './memberWorkSyncSafetyJson';
import { normalizeMemberKey } from './memberWorkSyncStoreIdentity';

import type { MemberWorkSyncStatus } from '../../contracts';
import type { MemberWorkSyncStoreSnapshot } from './JsonMemberWorkSyncStore';
import type { MemberWorkSyncStorePaths } from './MemberWorkSyncStorePaths';

/** Caller holds the existing team queue; never calls a public queued store method. */
export async function restoreMemberWorkSyncJsonStatuses(
  paths: MemberWorkSyncStorePaths,
  teamName: string,
  snapshot: MemberWorkSyncStoreSnapshot
): Promise<void> {
  const teamKey = teamName.trim().toLowerCase();
  const validateOwner = (status: MemberWorkSyncStatus, memberName: string): void => {
    if (
      !normalizeMemberKey(memberName) ||
      status.teamName?.trim().toLowerCase() !== teamKey ||
      normalizeMemberKey(status.memberName) !== normalizeMemberKey(memberName) ||
      status.agenda?.teamName?.trim().toLowerCase() !== teamKey ||
      normalizeMemberKey(status.agenda?.memberName) !== normalizeMemberKey(memberName) ||
      (status.report &&
        (status.report.teamName?.trim().toLowerCase() !== teamKey ||
          normalizeMemberKey(status.report.memberName) !== normalizeMemberKey(memberName))) ||
      (status.lastAcceptedReport &&
        (status.lastAcceptedReport.teamName?.trim().toLowerCase() !== teamKey ||
          normalizeMemberKey(status.lastAcceptedReport.memberName) !==
            normalizeMemberKey(memberName)))
    ) {
      throw new MemberWorkSyncSafetyJsonReadError('corrupt');
    }
  };
  const empty = { reportIntents: [], outboxItems: [], metricEvents: [], filesToArchive: [] };
  await withFileLock(
    paths.getMetricsIndexPath(teamName),
    async () => {
      const restored: MemberWorkSyncStatus[] = [];
      for (const incoming of snapshot.statuses) {
        validateOwner(incoming, incoming.memberName);
        await paths.ensureMemberWorkSyncDir(teamName, incoming.memberName);
        const path = paths.getMemberStatusPath(teamName, incoming.memberName);
        const current = await readMemberWorkSyncJsonStatus(path);
        if (current.state !== 'present' && current.state !== 'absent')
          throw new MemberWorkSyncSafetyJsonReadError(current.state);
        const previous =
          current.state === 'present' ? (current.payload as unknown as MemberWorkSyncStatus) : null;
        if (previous) validateOwner(previous, incoming.memberName);
        const winner = mergeDomainSnapshots(
          { ...empty, statuses: previous ? [previous] : [] },
          { ...empty, statuses: [incoming] }
        ).statuses[0];
        const result = await compareAndWriteMemberWorkSyncJsonStatus({
          path,
          expectedRaw: current.raw,
          mutationId: 'status-import',
          nextStatus: winner,
          project: async () => undefined,
        });
        // A failed/unknown import is preparation failure, never permission to issue the target CAS.
        // Retry performs the same strict publication without incrementing its domain revision.
        if (result.committed !== true) throw new MemberWorkSyncSafetyJsonReadError('unavailable');
        const verified = await readMemberWorkSyncJsonStatus(path);
        if (verified.state !== 'present' || verified.raw !== result.raw)
          throw new MemberWorkSyncSafetyJsonReadError('unavailable');
        restored.push(winner);
      }
      const members = Object.fromEntries(
        restored.map((status) => [
          paths.getMemberKey(status.memberName),
          {
            memberName: status.memberName,
            state: status.state,
            agendaFingerprint: status.agenda.fingerprint,
            actionableCount: status.agenda.items.length,
            evaluatedAt: status.evaluatedAt,
            ...(status.providerId ? { providerId: status.providerId } : {}),
          },
        ])
      );
      // Recovery must retain every merged identity for authoritative read-back.
      // The next normal status append applies the usual 200-event retention.
      const recentEvents = [...snapshot.metricEvents].sort(
        (a, b) => a.recordedAt.localeCompare(b.recordedAt) || a.id.localeCompare(b.id)
      );
      await atomicWriteAsync(
        paths.getMetricsIndexPath(teamName),
        `${JSON.stringify({ schemaVersion: 2, members, recentEvents }, null, 2)}\n`,
        { durability: 'strict', syncDirectory: true }
      );
    },
    { preventLiveOwnerTakeover: true }
  );
}
