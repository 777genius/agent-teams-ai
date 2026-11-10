import { mergeDomainSnapshots } from '@features/member-work-sync/main/infrastructure/memberWorkSyncDomainSnapshotMerge';
import { reportIntentToRecord, recordToReportIntent, recordsToSnapshot, snapshotToRecords } from '@features/member-work-sync/main/infrastructure/memberWorkSyncSqliteMappers';
import { validateMemberWorkSyncAuthoritySnapshot, validateMemberWorkSyncPrimaryRecords } from '@features/member-work-sync/main/infrastructure/memberWorkSyncAuthorityPreparation';
import { pickDomainReportIntent } from '@features/member-work-sync/main/infrastructure/memberWorkSyncDomainSnapshotMerge';
import { mergeMemberWorkSyncSnapshots } from '@features/member-work-sync/main/infrastructure/memberWorkSyncSnapshotMerge';
import { JsonMemberWorkSyncStore } from '@features/member-work-sync/main/infrastructure/JsonMemberWorkSyncStore';
import { MemberWorkSyncStorePaths } from '@features/member-work-sync/main/infrastructure/MemberWorkSyncStorePaths';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import type { MemberWorkSyncReportIntent } from '@features/member-work-sync/contracts';
import type { MemberWorkSyncReportIntentRecord } from '@features/internal-storage/contracts/internalStorageContracts';

const time = '2026-09-10T10:00:00.000Z';
function pending(): MemberWorkSyncReportIntent {
  return {
    id: 'intent-1',
    teamName: 'sandbox-journal-merge',
    memberName: 'tester',
    request: {
      teamName: 'sandbox-journal-merge',
      memberName: 'tester',
      state: 'still_working',
      agendaFingerprint: 'agenda-1',
    },
    status: 'pending',
    reason: 'online',
    recordedAt: time,
    journal: {
      incarnation: 'inc-1',
      requestDigest: 'digest-1',
      firstRecordedAt: time,
      origin: 'online',
    },
  };
}
function accepted(): MemberWorkSyncReportIntent {
  const row = pending();
  return {
    ...row,
    status: 'accepted',
    resultCode: 'accepted',
    processedAt: time,
    journal: {
      ...row.journal!,
      receipt: {
        intentId: row.id,
        incarnation: 'inc-1',
        requestDigest: 'digest-1',
        acceptedAt: time,
        appliedStatusRevision: {
          incarnation: 'inc-1',
          lineageId: 'lineage-1',
          sequence: 1,
          nonce: 'nonce-1',
        },
      },
    },
  };
}
function toRecord(row: MemberWorkSyncReportIntent): MemberWorkSyncReportIntentRecord {
  return {
    id: row.id,
    teamName: row.teamName,
    memberName: row.memberName,
    memberKey: row.memberName.trim().toLowerCase(),
    status: row.status,
    reason: row.reason,
    recordedAt: row.recordedAt,
    processedAt: row.processedAt ?? null,
    resultCode: row.resultCode ?? null,
    requestJson: JSON.stringify(row.request),
    journalJson: row.journal ? JSON.stringify(row.journal) : null,
  };
}
function merge(mode: string, left: MemberWorkSyncReportIntent, right: MemberWorkSyncReportIntent) {
  if (mode === 'domain') return pickDomainReportIntent(left, right);
  return mergeMemberWorkSyncSnapshots(
    left.teamName,
    { statuses: [], reportIntents: [toRecord(left)], outboxItems: [], metricEvents: [] },
    { statuses: [], reportIntents: [toRecord(right)], outboxItems: [], metricEvents: [] }
  ).reportIntents[0];
}

describe.each(['domain', 'records'])('report journal merge %s', (mode) => {
  it('rejects conflicting immutable digests', () => {
    const right = pending();
    right.journal!.requestDigest = 'different';
    expect(() => merge(mode, pending(), right)).toThrow();
  });
  it('rejects bound/unbound collision in both directions', () => {
    const legacy = pending();
    delete legacy.journal;
    expect(() => merge(mode, pending(), legacy)).toThrow();
    expect(() => merge(mode, legacy, pending())).toThrow();
  });
  it('keeps receipt despite later pending timestamps in both directions', () => {
    const later = { ...pending(), recordedAt: '2026-09-11T10:00:00.000Z' };
    expect(merge(mode, accepted(), later)).toMatchObject({
      status: 'accepted',
      resultCode: 'accepted',
      processedAt: time,
    });
    expect(merge(mode, later, accepted())).toMatchObject({
      status: 'accepted',
      resultCode: 'accepted',
      processedAt: time,
    });
  });
  it('rejects conflicting receipts and inconsistent accepted outcomes', () => {
    const changed = accepted();
    changed.journal!.receipt!.appliedStatusRevision.nonce = 'different';
    expect(() => merge(mode, accepted(), changed)).toThrow();
    expect(() => merge(mode, pending(), { ...accepted(), status: 'pending' })).toThrow();
  });
  it('normalizes equivalent identity spelling and rejects other member identities', () => {
    const right = accepted();
    right.memberName = ' Tester ';
    right.request.memberName = 'TESTER';
    right.teamName = ' Sandbox-Journal-Merge ';
    right.request.teamName = 'SANDBOX-JOURNAL-MERGE';
    expect(merge(mode, pending(), right)).toMatchObject({ status: 'accepted' });
    right.memberName = 'other';
    right.request.memberName = 'other';
    expect(() => merge(mode, pending(), right)).toThrow();
  });
  it('rejects altered immutable request and origin', () => {
    const changed = pending();
    changed.request.note = 'different';
    expect(() => merge(mode, pending(), changed)).toThrow();
    const fallback = pending();
    fallback.journal!.origin = 'fallback';
    expect(() => merge(mode, pending(), fallback)).toThrow();
  });
});

it('rejects a second public ensure of the same intent ID for another member', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sandbox-journal-merge-'));
  try {
    const paths = new MemberWorkSyncStorePaths(root);
    const store = new JsonMemberWorkSyncStore(paths);
    const journal = store.createReportJournal();
    const row = pending();
    expect(
      (
        await journal.ensure({
          teamName: row.teamName,
          memberName: row.memberName,
          incarnation: 'inc-1',
          intentId: row.id,
          requestDigest: 'digest-1',
          request: row.request,
          receivedAt: time,
          origin: 'online',
        })
      ).state
    ).toBe('present');
    const ownerBytes = await readFile(
      paths.getMemberReportsPath(row.teamName, row.memberName),
      'utf8'
    );
    expect(
      (
        await journal.ensure({
          teamName: row.teamName,
          memberName: 'other',
          incarnation: 'inc-1',
          intentId: row.id,
          requestDigest: 'digest-1',
          request: { ...row.request, memberName: 'other' },
          receivedAt: time,
          origin: 'online',
        })
      ).state
    ).toBe('conflict');
    expect(await readFile(paths.getMemberReportsPath(row.teamName, row.memberName), 'utf8')).toBe(
      ownerBytes
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('import of colliding member files fails from fixtures, not from a second ensure', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sandbox-journal-merge-'));
  try {
    const paths = new MemberWorkSyncStorePaths(root);
    const store = new JsonMemberWorkSyncStore(paths);
    const row = pending();
    for (const memberName of ['tester', 'other']) {
      await paths.ensureMemberWorkSyncDir(row.teamName, memberName);
      const intent = {
        ...row,
        memberName,
        request: { ...row.request, memberName },
      };
      const reportsPath = paths.getMemberReportsPath(row.teamName, memberName);
      await mkdir(join(reportsPath, '..'), { recursive: true });
      await writeFile(
        reportsPath,
        `${JSON.stringify({ schemaVersion: 2, intents: { [row.id]: intent } }, null, 2)}\n`
      );
    }
    await expect(store.readSnapshotForImport(row.teamName)).rejects.toThrow();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

const malformedRows = [
  { name: 'pending with receipt', make: () => ({ ...accepted(), status: 'pending' as const }) },
  { name: 'accepted without receipt', make: () => ({ ...pending(), status: 'accepted' as const }) },
  { name: 'wrong processed time', make: () => ({ ...accepted(), processedAt: '2026-09-11T10:00:00.000Z' }) },
  { name: 'foreign request team', make: () => ({ ...pending(), request: { ...pending().request, teamName: 'foreign' } }) },
  { name: 'foreign request member', make: () => ({ ...pending(), request: { ...pending().request, memberName: 'foreign' } }) },
];
describe.each(malformedRows)('single malformed journal row: $name', ({ make }) => {
  it('rejects before domain/SQL mapping, preflight or merge can normalize it', () => {
    const row = make();
    const domain = { statuses: [], reportIntents: [row], outboxItems: [], metricEvents: [], filesToArchive: [] };
    const records = { statuses: [], reportIntents: [toRecord(row)], outboxItems: [], metricEvents: [] };
    const empty = { statuses: [], reportIntents: [], outboxItems: [], metricEvents: [] };
    const before = JSON.stringify({ domain, records });
    const identity = { teamName: row.teamName, incarnation: 'inc-1' };
    expect(() => validateMemberWorkSyncAuthoritySnapshot(identity, domain)).toThrow();
    expect(() => validateMemberWorkSyncPrimaryRecords(identity, records)).toThrow();
    expect(() => reportIntentToRecord(row)).toThrow();
    expect(() => recordToReportIntent(records.reportIntents[0])).toThrow();
    expect(() => recordsToSnapshot(row.teamName, records)).toThrow();
    expect(() => mergeDomainSnapshots(domain, null)).toThrow();
    expect(() => mergeMemberWorkSyncSnapshots(row.teamName, records, empty)).toThrow();
    expect(JSON.stringify({ domain, records })).toBe(before);
  });
});

it('rejects a foreign self-consistent journal before snapshot routing normalization', () => {
  const row = pending();
  row.teamName = 'foreign';
  row.request.teamName = 'foreign';
  const snapshot = { statuses: [], reportIntents: [row], outboxItems: [], metricEvents: [], filesToArchive: [] };
  const before = JSON.stringify(snapshot);
  expect(() => snapshotToRecords('sandbox-journal-merge', snapshot)).toThrow();
  expect(JSON.stringify(snapshot)).toBe(before);
});
