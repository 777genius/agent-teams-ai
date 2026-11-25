import { eq } from 'drizzle-orm';

import {
  normalizeMemberWorkSyncSnapshotTeamIdentity,
  normalizeMemberWorkSyncTeamKey,
} from '../../../contracts/memberWorkSyncTeamIdentity';

import {
  memberWorkSyncMetricEvents,
  memberWorkSyncOutbox,
  memberWorkSyncPrimaryIncarnations,
  memberWorkSyncReportIntents,
  memberWorkSyncStatus,
} from './internalStorageSchema';
import { readMemberWorkSyncTeamSnapshot } from './memberWorkSyncSnapshotWorkerOps';

import type {
  MemberWorkSyncPrimaryImport,
  MemberWorkSyncTeamSnapshotRecords,
} from '../../../contracts/internalStorageContracts';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

const INSERT_CHUNK_SIZE = 200;

// Load-bearing guard, not just batching: drizzle's .values([]) throws, and an
// empty set is a legitimate state (fresh team import). Iterating chunks means
// zero .values() calls for empty input — do not inline bulk inserts without it.
function chunked<T>(values: T[]): T[][] {
  const chunks: T[][] = [];
  for (let start = 0; start < values.length; start += INSERT_CHUNK_SIZE) {
    chunks.push(values.slice(start, start + INSERT_CHUNK_SIZE));
  }
  return chunks;
}

export function readMemberWorkSyncPrimaryIncarnation(
  orm: BetterSQLite3Database,
  teamName: string
): string | null {
  return (
    orm
      .select()
      .from(memberWorkSyncPrimaryIncarnations)
      .where(
        eq(memberWorkSyncPrimaryIncarnations.teamKey, normalizeMemberWorkSyncTeamKey(teamName))
      )
      .get()?.incarnation ?? null
  );
}

/** Same-database ownership and all team rows change atomically, including empty imports. */
export function importMemberWorkSyncTeam(
  orm: BetterSQLite3Database,
  teamName: string,
  snapshot: MemberWorkSyncTeamSnapshotRecords,
  binding?: MemberWorkSyncPrimaryImport
): void {
  const teamKey = normalizeMemberWorkSyncTeamKey(teamName);
  if (
    !teamKey ||
    (binding?.resetPrimaryIncarnation === true && binding.incarnation !== undefined) ||
    (binding &&
      binding.resetPrimaryIncarnation !== true &&
      (typeof binding.incarnation !== 'string' ||
        !binding.incarnation.trim() ||
        binding.incarnation.trim() !== binding.incarnation))
  )
    throw new Error('Invalid member-work-sync primary incarnation');
  const normalizedSnapshot = normalizeMemberWorkSyncSnapshotTeamIdentity(teamName, snapshot);
  orm.transaction(() => {
    const owner = readMemberWorkSyncPrimaryIncarnation(orm, teamName);
    if (binding?.resetPrimaryIncarnation === true) {
      orm
        .delete(memberWorkSyncPrimaryIncarnations)
        .where(eq(memberWorkSyncPrimaryIncarnations.teamKey, teamKey))
        .run();
    } else {
      if (owner !== null && owner !== binding?.incarnation)
        throw new Error('member-work-sync primary incarnation mismatch');
      if (binding?.incarnation !== undefined) {
        orm
          .insert(memberWorkSyncPrimaryIncarnations)
          .values({ teamKey, incarnation: binding.incarnation })
          .onConflictDoNothing()
          .run();
      }
    }
    const aliases = new Set<string>([teamName]);
    const current = readMemberWorkSyncTeamSnapshot(orm, teamName);
    for (const record of [
      ...current.statuses,
      ...current.reportIntents,
      ...current.outboxItems,
      ...current.metricEvents,
    ]) {
      aliases.add(record.teamName);
    }
    for (const alias of aliases) {
      orm.delete(memberWorkSyncStatus).where(eq(memberWorkSyncStatus.teamName, alias)).run();
      orm
        .delete(memberWorkSyncReportIntents)
        .where(eq(memberWorkSyncReportIntents.teamName, alias))
        .run();
      orm.delete(memberWorkSyncOutbox).where(eq(memberWorkSyncOutbox.teamName, alias)).run();
      orm
        .delete(memberWorkSyncMetricEvents)
        .where(eq(memberWorkSyncMetricEvents.teamName, alias))
        .run();
    }
    for (const rows of chunked(normalizedSnapshot.statuses)) {
      orm.insert(memberWorkSyncStatus).values(rows).run();
    }
    for (const rows of chunked(normalizedSnapshot.reportIntents)) {
      orm.insert(memberWorkSyncReportIntents).values(rows).run();
    }
    for (const rows of chunked(normalizedSnapshot.outboxItems)) {
      orm.insert(memberWorkSyncOutbox).values(rows).run();
    }
    for (const rows of chunked(normalizedSnapshot.metricEvents)) {
      orm.insert(memberWorkSyncMetricEvents).values(rows).run();
    }
  });
}
