import { BackendSelectingMemberWorkSyncReportJournal } from '@features/member-work-sync/main/infrastructure/BackendSelectingMemberWorkSyncReportJournal';
import { describe, expect, it } from 'vitest';

import type { InternalStorageBackendSelector } from '@features/internal-storage/main';
import type { MemberWorkSyncReportReceipt } from '@features/member-work-sync/contracts';
import type {
  MemberWorkSyncReportJournalInput,
  MemberWorkSyncReportJournalPort,
  MemberWorkSyncReportJournalResult,
} from '@features/member-work-sync/core/application/MemberWorkSyncReportJournalPort';

const input: MemberWorkSyncReportJournalInput = {
  teamName: 'team-a',
  memberName: 'bob',
  incarnation: 'inc-1',
  intentId: 'intent-1',
  requestDigest: 'digest-1',
  receivedAt: '2026-09-12T00:00:00.000Z',
  origin: 'online',
  request: {
    teamName: 'team-a',
    memberName: 'bob',
    state: 'still_working',
    agendaFingerprint: 'agenda-1',
  },
};

const receipt: MemberWorkSyncReportReceipt = {
  intentId: input.intentId,
  incarnation: input.incarnation,
  requestDigest: input.requestDigest,
  acceptedAt: input.receivedAt,
  appliedStatusRevision: {
    incarnation: input.incarnation,
    lineageId: 'lineage-1',
    sequence: 1,
    nonce: 'nonce-1',
  },
};

function journal(label: string, calls: string[]): MemberWorkSyncReportJournalPort {
  return {
    read: async () => {
      calls.push(`${label}:read`);
      return { state: 'absent' };
    },
    ensure: async () => {
      calls.push(`${label}:ensure`);
      return { state: 'present', intent: { id: input.intentId } } as MemberWorkSyncReportJournalResult;
    },
    transfer: async () => {
      calls.push(`${label}:transfer`);
      return { state: 'present', intent: { id: input.intentId } } as MemberWorkSyncReportJournalResult;
    },
  };
}

describe('BackendSelectingMemberWorkSyncReportJournal', () => {
  it('routes ensure and transfer through the replica fence', async () => {
    const calls: string[] = [];
    const sqlite = journal('sqlite', calls);
    const json = journal('json', calls);
    const wrapped = new BackendSelectingMemberWorkSyncReportJournal(
      {
        select: async (left) => {
          calls.push('select');
          return left;
        },
      } as Pick<InternalStorageBackendSelector, 'select'> as InternalStorageBackendSelector,
      sqlite,
      json,
      {
        runReplicaFenced: async (teamName, mutation, sqliteAction) => {
          calls.push(`fence:${teamName}:${mutation}`);
          return sqliteAction();
        },
      }
    );
    await wrapped.ensure(input);
    await wrapped.transfer({ ...input, receipt });
    expect(calls).toEqual([
      'fence:team-a:true',
      'sqlite:ensure',
      'fence:team-a:true',
      'sqlite:transfer',
    ]);
  });
});
