import { isDeepStrictEqual } from 'node:util';

import { and, eq } from 'drizzle-orm';

import { memberWorkSyncReportIntents } from './internalStorageSchema';

import type {
  MemberWorkSyncReportIntentRecord,
  MemberWorkSyncReportJournalOpResult,
} from '../../../contracts/internalStorageContracts';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

export type { MemberWorkSyncReportJournalOpResult };

export interface MemberWorkSyncReportJournalMutation {
  teamName: string;
  memberKey: string;
  memberName: string;
  id: string;
  requestJson: string;
  journalJson: string;
  receiptJson?: string;
}

interface JournalBinding {
  incarnation: string;
  requestDigest: string;
  firstRecordedAt: string;
  origin: string;
  receipt?: { acceptedAt: string; intentId: string };
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function inspect(row: MemberWorkSyncReportIntentRecord): 'ok' | 'corrupt' {
  if (parseJson(row.requestJson) === undefined) return 'corrupt';
  if (row.journalJson == null) return 'ok';
  const journal = parseJson(row.journalJson) as JournalBinding | undefined;
  if (
    !journal ||
    typeof journal.incarnation !== 'string' ||
    typeof journal.requestDigest !== 'string'
  )
    return 'corrupt';
  if (journal.receipt) {
    if (
      row.status !== 'accepted' ||
      row.resultCode !== 'accepted' ||
      row.processedAt !== journal.receipt.acceptedAt
    )
      return 'corrupt';
  } else if (row.status !== 'pending' || row.resultCode != null || row.processedAt != null) {
    return 'corrupt';
  }
  return 'ok';
}

function readRow(
  orm: BetterSQLite3Database,
  teamName: string,
  id: string
): MemberWorkSyncReportIntentRecord | null {
  return (
    orm
      .select()
      .from(memberWorkSyncReportIntents)
      .where(
        and(
          eq(memberWorkSyncReportIntents.teamName, teamName),
          eq(memberWorkSyncReportIntents.id, id)
        )
      )
      .all()[0] ?? null
  );
}

function writeRow(orm: BetterSQLite3Database, row: MemberWorkSyncReportIntentRecord): void {
  orm
    .insert(memberWorkSyncReportIntents)
    .values(row)
    .onConflictDoUpdate({
      target: [memberWorkSyncReportIntents.teamName, memberWorkSyncReportIntents.id],
      set: {
        memberKey: row.memberKey,
        memberName: row.memberName,
        status: row.status,
        reason: row.reason,
        recordedAt: row.recordedAt,
        processedAt: row.processedAt,
        resultCode: row.resultCode,
        requestJson: row.requestJson,
        journalJson: row.journalJson,
      },
    })
    .run();
}

function present(record: MemberWorkSyncReportIntentRecord): MemberWorkSyncReportJournalOpResult {
  return { state: 'present', record, projectionDegraded: false };
}

/** Strict team-scoped ID ownership. SQLite PK is (team, id); another member is conflict. */
export function mutateMemberWorkSyncReportJournal(
  orm: BetterSQLite3Database,
  input: MemberWorkSyncReportJournalMutation
): MemberWorkSyncReportJournalOpResult {
  const journal = parseJson(input.journalJson) as JournalBinding | undefined;
  const request = parseJson(input.requestJson);
  const receipt = input.receiptJson
    ? (parseJson(input.receiptJson) as JournalBinding['receipt'])
    : undefined;
  if (!journal || request === undefined || (input.receiptJson && !receipt))
    return { state: 'conflict' };
  try {
    return orm.transaction(() => {
      const current = readRow(orm, input.teamName, input.id);
      if (current && inspect(current) === 'corrupt') return { state: 'corrupt' as const };
      if (receipt && !current) return { state: 'absent' as const };
      if (!current) {
        const record: MemberWorkSyncReportIntentRecord = {
          teamName: input.teamName,
          id: input.id,
          memberKey: input.memberKey,
          memberName: input.memberName,
          status: 'pending',
          reason: journal.origin,
          recordedAt: journal.firstRecordedAt,
          processedAt: null,
          resultCode: null,
          requestJson: input.requestJson,
          journalJson: input.journalJson,
        };
        writeRow(orm, record);
        return present(record);
      }
      if (current.journalJson == null || current.memberKey !== input.memberKey)
        return { state: 'conflict' as const };
      const stored = parseJson(current.journalJson) as JournalBinding | undefined;
      if (!stored) return { state: 'corrupt' as const };
      if (
        stored.incarnation !== journal.incarnation ||
        stored.requestDigest !== journal.requestDigest ||
        !isDeepStrictEqual(parseJson(current.requestJson), request)
      ) {
        return { state: 'conflict' as const };
      }
      if (receipt) {
        if (stored.receipt && !isDeepStrictEqual(stored.receipt, receipt))
          return { state: 'conflict' as const };
        const nextJournal = { ...stored, receipt };
        const record: MemberWorkSyncReportIntentRecord = {
          ...current,
          status: 'accepted',
          resultCode: 'accepted',
          processedAt: receipt.acceptedAt,
          journalJson: JSON.stringify(nextJournal),
        };
        if (stored.receipt) return present(current);
        writeRow(orm, record);
        return present(record);
      }
      return present(current);
    });
  } catch {
    return { state: 'write_failed' };
  }
}

export function readMemberWorkSyncReportJournal(
  orm: BetterSQLite3Database,
  input: {
    teamName: string;
    memberKey: string;
    id: string;
    journalJson: string;
    requestJson: string;
  }
): MemberWorkSyncReportJournalOpResult {
  const current = readRow(orm, input.teamName, input.id);
  if (!current) return { state: 'absent' };
  if (inspect(current) === 'corrupt') return { state: 'corrupt' };
  if (current.journalJson == null || current.memberKey !== input.memberKey)
    return { state: 'conflict' };
  const stored = parseJson(current.journalJson) as JournalBinding | undefined;
  const expected = parseJson(input.journalJson) as JournalBinding | undefined;
  if (!stored || !expected) return { state: 'corrupt' };
  if (
    stored.incarnation !== expected.incarnation ||
    stored.requestDigest !== expected.requestDigest
  ) {
    return { state: 'conflict' };
  }
  return present(current);
}
