import { inArray } from 'drizzle-orm';

import { isSameMemberWorkSyncTeam } from '../../../contracts/memberWorkSyncTeamIdentity';

import {
  memberWorkSyncMetricEvents,
  memberWorkSyncOutbox,
  memberWorkSyncReportIntents,
  memberWorkSyncStatus,
} from './internalStorageSchema';

import type { MemberWorkSyncTeamSnapshotRecords } from '../../../contracts/internalStorageContracts';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

function readRowsForTeam<T>(
  teamName: string,
  listNames: () => { teamName: string }[],
  readMatching: (aliases: string[]) => T[]
): T[] {
  // Legacy rows may differ in case or whitespace, including Unicode. Resolve
  // only distinct indexed names in JS; never materialize other teams' payloads.
  const aliases = listNames()
    .filter((row) => isSameMemberWorkSyncTeam(row.teamName, teamName))
    .map((row) => row.teamName);
  return aliases.length > 0 ? readMatching(aliases) : [];
}

/** Read only the requested team's rows, including legacy case/whitespace aliases. */
export function readMemberWorkSyncTeamSnapshot(
  orm: BetterSQLite3Database,
  teamName: string
): MemberWorkSyncTeamSnapshotRecords {
  return {
    statuses: readRowsForTeam(
      teamName,
      () =>
        orm
          .selectDistinct({ teamName: memberWorkSyncStatus.teamName })
          .from(memberWorkSyncStatus)
          .all(),
      (aliases) =>
        orm
          .select()
          .from(memberWorkSyncStatus)
          .where(inArray(memberWorkSyncStatus.teamName, aliases))
          .all()
    ).sort((left, right) => left.memberKey.localeCompare(right.memberKey)),
    reportIntents: readRowsForTeam(
      teamName,
      () =>
        orm
          .selectDistinct({ teamName: memberWorkSyncReportIntents.teamName })
          .from(memberWorkSyncReportIntents)
          .all(),
      (aliases) =>
        orm
          .select()
          .from(memberWorkSyncReportIntents)
          .where(inArray(memberWorkSyncReportIntents.teamName, aliases))
          .all()
    ).sort((left, right) => left.id.localeCompare(right.id)),
    outboxItems: readRowsForTeam(
      teamName,
      () =>
        orm
          .selectDistinct({ teamName: memberWorkSyncOutbox.teamName })
          .from(memberWorkSyncOutbox)
          .all(),
      (aliases) =>
        orm
          .select()
          .from(memberWorkSyncOutbox)
          .where(inArray(memberWorkSyncOutbox.teamName, aliases))
          .all()
    ).sort((left, right) => left.id.localeCompare(right.id)),
    metricEvents: readRowsForTeam(
      teamName,
      () =>
        orm
          .selectDistinct({ teamName: memberWorkSyncMetricEvents.teamName })
          .from(memberWorkSyncMetricEvents)
          .all(),
      (aliases) =>
        orm
          .select()
          .from(memberWorkSyncMetricEvents)
          .where(inArray(memberWorkSyncMetricEvents.teamName, aliases))
          .all()
    ).sort((left, right) => {
      const byTime = left.recordedAt.localeCompare(right.recordedAt);
      return byTime === 0 ? left.id.localeCompare(right.id) : byTime;
    }),
  };
}
