import { QuiescingMemberWorkSyncAuditJournal } from '@features/member-work-sync/main/infrastructure/QuiescingMemberWorkSyncAuditJournal';
import { describe, expect, it, vi } from 'vitest';

import type {
  MemberWorkSyncAuditEvent,
  MemberWorkSyncAuditJournalPort,
} from '@features/member-work-sync/core/application';

function deferred(): {
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: Error) => void;
} {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function event(teamName: string, source: string): MemberWorkSyncAuditEvent {
  return {
    timestamp: '2026-07-22T00:00:00.000Z',
    teamName,
    memberName: 'member-a',
    event: 'reconcile_started',
    source,
  };
}

describe('QuiescingMemberWorkSyncAuditJournal', () => {
  it('synchronously fences new appends and waits only for admitted appends of that team', async () => {
    const teamAAppend = deferred();
    const teamBAppend = deferred();
    const delegate: MemberWorkSyncAuditJournalPort = {
      append: vi.fn((entry) => {
        if (entry.source === 'team-a-admitted') {
          return teamAAppend.promise;
        }
        if (entry.source === 'team-b-admitted') {
          return teamBAppend.promise;
        }
        return Promise.resolve();
      }),
    };
    const journal = new QuiescingMemberWorkSyncAuditJournal(delegate);

    const admittedA = journal.append(event('team-a', 'team-a-admitted'));
    const admittedB = journal.append(event('team-b', 'team-b-admitted'));
    journal.beginTeamQuiesce('team-a');

    await expect(journal.append(event('team-a', 'team-a-fenced'))).resolves.toBeUndefined();
    expect(delegate.append).toHaveBeenCalledTimes(2);

    let teamAIdle = false;
    const idle = journal.awaitTeamIdle('team-a').then(() => {
      teamAIdle = true;
    });
    await Promise.resolve();
    expect(teamAIdle).toBe(false);

    teamBAppend.resolve();
    await admittedB;
    expect(teamAIdle).toBe(false);

    teamAAppend.resolve();
    await Promise.all([admittedA, idle]);
    expect(teamAIdle).toBe(true);

    journal.resumeTeam('team-a');
    await expect(journal.append(event('team-a', 'team-a-resumed'))).resolves.toBeUndefined();
    expect(delegate.append).toHaveBeenCalledTimes(3);
  });

  it('waits for every admitted append even when one rejects while settling', async () => {
    const first = deferred();
    const second = deferred();
    const delegate: MemberWorkSyncAuditJournalPort = {
      append: vi
        .fn<MemberWorkSyncAuditJournalPort['append']>()
        .mockReturnValueOnce(first.promise)
        .mockReturnValueOnce(second.promise),
    };
    const journal = new QuiescingMemberWorkSyncAuditJournal(delegate);

    const firstAppend = journal.append(event('team-a', 'first'));
    const secondAppend = journal.append(event('team-a', 'second'));
    journal.beginTeamQuiesce('team-a');

    let idleSettled = false;
    const idle = journal.awaitTeamIdle('team-a').then(() => {
      idleSettled = true;
    });

    first.resolve();
    await firstAppend;
    expect(idleSettled).toBe(false);

    const failure = new Error('append failed');
    second.reject(failure);
    await expect(secondAppend).rejects.toBe(failure);
    await expect(idle).resolves.toBeUndefined();
  });

  it('includes appends admitted while an unfenced idle wait is already in progress', async () => {
    const first = deferred();
    const second = deferred();
    const delegate: MemberWorkSyncAuditJournalPort = {
      append: vi
        .fn<MemberWorkSyncAuditJournalPort['append']>()
        .mockReturnValueOnce(first.promise)
        .mockReturnValueOnce(second.promise),
    };
    const journal = new QuiescingMemberWorkSyncAuditJournal(delegate);

    const firstAppend = journal.append(event('team-a', 'first'));
    let idleSettled = false;
    const idle = journal.awaitTeamIdle('team-a').then(() => {
      idleSettled = true;
    });
    const secondAppend = journal.append(event('team-a', 'second'));

    first.resolve();
    await firstAppend;
    expect(idleSettled).toBe(false);

    second.resolve();
    await Promise.all([secondAppend, idle]);
    expect(idleSettled).toBe(true);
  });
});
