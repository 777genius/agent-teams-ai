import { MemberWorkSyncTeamOperationGate } from '@features/member-work-sync/core/application/MemberWorkSyncTeamOperationGate';
import { createAdmittedMemberWorkSyncStatusPort } from '@features/member-work-sync/main/composition/createAdmittedMemberWorkSyncStatusPort';
import { startScheduledDispatch } from '@features/member-work-sync/main/infrastructure/memberWorkSyncScheduledDispatchLifetime';
import { describe, expect, it, vi } from 'vitest';

import type {
  MemberWorkSyncAuthorityCommitResult,
  MemberWorkSyncAuthorityReadResult,
} from '@features/member-work-sync/core/application/MemberWorkSyncConditionalStatusPort';
import type { MemberWorkSyncStatusAuthority } from '@features/member-work-sync/main/infrastructure/MemberWorkSyncStatusAuthority';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('admitted status port binding', () => {
  it('registers the same early-unknown tail in deletion gate and attempt collector before effects', async () => {
    const release = deferred();
    const observed: Promise<unknown>[] = [];
    const gate = new MemberWorkSyncTeamOperationGate();
    let gateDrained = false;
    let attemptDrained = false;
    const authority: Pick<MemberWorkSyncStatusAuthority, 'startRead' | 'startCompareAndWrite'> = {
      startRead: vi.fn(),
      startCompareAndWrite: vi.fn(() => ({
        result: Promise.resolve().then((): MemberWorkSyncAuthorityCommitResult => {
          expect(observed).toEqual([release.promise, release.promise]);
          return { committed: 'unknown', reason: 'commit_unknown', mutationId: 'm1' };
        }),
        settled: release.promise,
      })),
    };
    const attempt = startScheduledDispatch((track) =>
      gate.run('sandbox', (admission) => {
        const port = createAdmittedMemberWorkSyncStatusPort({
          teamName: 'sandbox',
          authority,
          admission: {
            trackSettling: (work) => {
              observed.push(work);
              return admission.trackSettling(work);
            },
          },
          trackSettling: (work) => {
            observed.push(work);
            track(work);
          },
        });
        return port.compareAndWrite({
          teamName: ' SANDBOX ',
          memberName: 'alice',
          incarnation: 'inc',
          expectedToken: 'token',
          mutationId: 'm1',
          nextStatus: {} as never,
        });
      })
    );
    const retired = attempt.settled.then(() => {
      attemptDrained = true;
    });
    let drain: Promise<void> | undefined;
    try {
      await expect(attempt.result).resolves.toMatchObject({ committed: 'unknown' });
      gate.beginTeamQuiesce('sandbox');
      drain = gate.awaitTeamIdle('sandbox').then(() => {
        gateDrained = true;
      });
      await gate.run('other-sandbox', async () => undefined);
      expect(gateDrained).toBe(false);
      expect(attemptDrained).toBe(false);
      expect(authority.startCompareAndWrite).toHaveBeenCalledTimes(1);
    } finally {
      release.resolve();
      await retired;
      await drain;
    }
    expect(gateDrained).toBe(true);
    expect(attemptDrained).toBe(true);
  });

  it('rejects a different team before starting any authority work', async () => {
    const authority = { startRead: vi.fn(), startCompareAndWrite: vi.fn() };
    const port = createAdmittedMemberWorkSyncStatusPort({
      teamName: 'sandbox',
      authority,
      admission: { trackSettling: (work) => work },
    });
    await expect(port.readSnapshot({ teamName: 'other', memberName: 'alice' })).resolves.toEqual({
      ok: false,
      reason: 'invalid_token',
    });
    await expect(
      port.compareAndWrite({
        teamName: 'other',
        memberName: 'alice',
        incarnation: 'inc',
        expectedToken: 't',
        mutationId: 'm',
        nextStatus: {} as never,
      })
    ).resolves.toEqual({ committed: false, reason: 'invalid_token' });
    expect(authority.startRead).not.toHaveBeenCalled();
    expect(authority.startCompareAndWrite).not.toHaveBeenCalled();
  });

  it('tracks read preparation even when its logical result already returned unavailable', async () => {
    const release = deferred();
    const gate = new MemberWorkSyncTeamOperationGate();
    const authority: Pick<MemberWorkSyncStatusAuthority, 'startRead' | 'startCompareAndWrite'> = {
      startRead: () => ({
        result: Promise.resolve<MemberWorkSyncAuthorityReadResult>({
          ok: false,
          reason: 'unavailable',
        }),
        settled: release.promise,
      }),
      startCompareAndWrite: vi.fn(),
    };
    let drained = false;
    let drain: Promise<void> | undefined;
    try {
      await expect(
        gate.run('sandbox', (admission) =>
          createAdmittedMemberWorkSyncStatusPort({
            teamName: 'sandbox',
            authority,
            admission,
          }).readSnapshot({ teamName: 'sandbox', memberName: 'alice' })
        )
      ).resolves.toMatchObject({ ok: false });
      gate.beginTeamQuiesce('sandbox');
      drain = gate.awaitTeamIdle('sandbox').then(() => {
        drained = true;
      });
      await gate.run('other', async () => undefined);
      expect(drained).toBe(false);
    } finally {
      release.resolve();
      await drain;
    }
    expect(drained).toBe(true);
  });
});
