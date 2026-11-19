import { and, desc, eq, inArray } from 'drizzle-orm';

import { isSameMemberWorkSyncTeam } from '../../../contracts/memberWorkSyncTeamIdentity';

import { memberWorkSyncMetricEvents, memberWorkSyncStatus } from './internalStorageSchema';

import type {
  MemberWorkSyncMetricEventRecord,
  MemberWorkSyncStatusCompareAndWriteInput,
  MemberWorkSyncStatusCompareAndWriteResult,
  MemberWorkSyncStatusDeleteTarget,
  MemberWorkSyncStatusRecord,
} from '../../../contracts/internalStorageContracts';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

function statusFields(record: MemberWorkSyncStatusRecord) {
  return {
    memberName: record.memberName,
    state: record.state,
    evaluatedAt: record.evaluatedAt,
    providerId: record.providerId,
    statusJson: record.statusJson,
  };
}

function appendMetrics(
  orm: BetterSQLite3Database,
  teamName: string,
  events: MemberWorkSyncMetricEventRecord[]
): void {
  for (const event of events) {
    orm
      .insert(memberWorkSyncMetricEvents)
      .values(event)
      .onConflictDoUpdate({
        target: [memberWorkSyncMetricEvents.teamName, memberWorkSyncMetricEvents.id],
        set: {
          memberKey: event.memberKey,
          memberName: event.memberName,
          kind: event.kind,
          recordedAt: event.recordedAt,
          eventJson: event.eventJson,
        },
      })
      .run();
  }
  // Preserve the existing JSON-compatible 200-event retention and bounded deletes.
  const survivors = orm
    .select({ id: memberWorkSyncMetricEvents.id })
    .from(memberWorkSyncMetricEvents)
    .where(eq(memberWorkSyncMetricEvents.teamName, teamName))
    .orderBy(desc(memberWorkSyncMetricEvents.recordedAt), desc(memberWorkSyncMetricEvents.id))
    .limit(200)
    .all();
  const keep = new Set(survivors.map((row) => row.id));
  const all = orm
    .select({ id: memberWorkSyncMetricEvents.id })
    .from(memberWorkSyncMetricEvents)
    .where(eq(memberWorkSyncMetricEvents.teamName, teamName))
    .all();
  const doomed = all.map((row) => row.id).filter((id) => !keep.has(id));
  for (let start = 0; start < doomed.length; start += 200) {
    orm
      .delete(memberWorkSyncMetricEvents)
      .where(
        and(
          eq(memberWorkSyncMetricEvents.teamName, teamName),
          inArray(memberWorkSyncMetricEvents.id, doomed.slice(start, start + 200))
        )
      )
      .run();
  }
}

/**
 * Exact-key-and-payload guarded deletion. All matches must succeed in one
 * transaction; a concurrent replacement or an unrelated team cannot be removed.
 */
export function deleteMemberWorkSyncStatusesMatching(
  orm: BetterSQLite3Database,
  teamName: string,
  targets: MemberWorkSyncStatusDeleteTarget[]
): number {
  if (!Array.isArray(targets) || targets.length === 0) {
    throw new Error('Invalid member-work-sync status deletion target set');
  }
  const keys = new Set<string>();
  for (const target of targets) {
    if (
      !target ||
      !isSameMemberWorkSyncTeam(target.teamName, teamName) ||
      typeof target.memberKey !== 'string' ||
      !target.memberKey ||
      typeof target.statusJson !== 'string' ||
      !target.statusJson
    ) {
      throw new Error('Invalid member-work-sync status deletion target');
    }
    const key = JSON.stringify([target.teamName, target.memberKey]);
    if (keys.has(key)) throw new Error('Duplicate member-work-sync status deletion target');
    keys.add(key);
  }
  return orm.transaction(() => {
    for (const target of targets) {
      const deleted = orm
        .delete(memberWorkSyncStatus)
        .where(
          and(
            eq(memberWorkSyncStatus.teamName, target.teamName),
            eq(memberWorkSyncStatus.memberKey, target.memberKey),
            eq(memberWorkSyncStatus.statusJson, target.statusJson)
          )
        )
        .run().changes;
      if (deleted !== 1) throw new Error('Stale member-work-sync status changed before deletion');
    }
    return targets.length;
  });
}

/** Kept only for existing writers during migration; normal writers will move to CAS. */
export function writeMemberWorkSyncStatus(
  orm: BetterSQLite3Database,
  record: MemberWorkSyncStatusRecord,
  events: MemberWorkSyncMetricEventRecord[]
): void {
  orm.transaction(() => {
    orm
      .insert(memberWorkSyncStatus)
      .values(record)
      .onConflictDoUpdate({
        target: [memberWorkSyncStatus.teamName, memberWorkSyncStatus.memberKey],
        set: statusFields(record),
      })
      .run();
    appendMetrics(orm, record.teamName, events);
  });
}

/** The comparison, write and accepted metrics share the same database transaction. */
export function compareAndWriteMemberWorkSyncStatus(
  orm: BetterSQLite3Database,
  input: MemberWorkSyncStatusCompareAndWriteInput
): MemberWorkSyncStatusCompareAndWriteResult {
  const { record, events, expectedStatusJson } = input;
  return orm.transaction((): MemberWorkSyncStatusCompareAndWriteResult => {
    const key = and(
      eq(memberWorkSyncStatus.teamName, record.teamName),
      eq(memberWorkSyncStatus.memberKey, record.memberKey)
    );
    const changed =
      expectedStatusJson === null
        ? orm
            .insert(memberWorkSyncStatus)
            .values(record)
            .onConflictDoNothing({
              target: [memberWorkSyncStatus.teamName, memberWorkSyncStatus.memberKey],
            })
            .run().changes
        : orm
            .update(memberWorkSyncStatus)
            .set(statusFields(record))
            .where(and(key, eq(memberWorkSyncStatus.statusJson, expectedStatusJson)))
            .run().changes;
    if (!changed) {
      return {
        committed: false,
        current: orm.select().from(memberWorkSyncStatus).where(key).all()[0] ?? null,
      };
    }
    appendMetrics(orm, record.teamName, events);
    return { committed: true, record };
  });
}
