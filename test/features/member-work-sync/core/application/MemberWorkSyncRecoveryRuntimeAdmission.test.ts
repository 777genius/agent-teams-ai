import {
  MemberWorkSyncRecoveryCommands,
  type MemberWorkSyncRuntimeTicketAdmissionPort,
  MemberWorkSyncTeamOperationGate,
  type MemberWorkSyncUseCaseDeps,
} from '@features/member-work-sync/core/application';
import { MemberWorkSyncRecoveryHealthError } from '@features/member-work-sync/core/domain';
import { createAdmittedMemberWorkSyncStatusPort } from '@features/member-work-sync/main/composition/createAdmittedMemberWorkSyncStatusPort';
import { describe, expect, it, vi } from 'vitest';

import type { MemberWorkSyncStatus } from '@features/member-work-sync/contracts';
import type {
  MemberWorkSyncAuthorityCommitResult,
  MemberWorkSyncAuthorityReadResult,
} from '@features/member-work-sync/core/application/MemberWorkSyncConditionalStatusPort';

function status(): MemberWorkSyncStatus {
  return {
    teamName: 'team-a',
    memberName: 'bob',
    state: 'needs_sync',
    evaluatedAt: '2026-05-06T00:05:00.000Z',
    diagnostics: ['no_current_report'],
    providerId: 'codex',
    statusRevision: {
      incarnation: 'inc-live',
      lineageId: 'lineage-1',
      sequence: 1,
      nonce: 'nonce-1',
    },
    agenda: {
      teamName: 'team-a',
      memberName: 'bob',
      generatedAt: '2026-05-06T00:00:00.000Z',
      fingerprint: 'agenda:v1:test',
      items: [
        {
          taskId: 'task-1',
          displayId: '11111111',
          subject: 'Do work',
          kind: 'work',
          assignee: 'bob',
          priority: 'normal',
          reason: 'owned_pending_task',
          evidence: { status: 'pending', owner: 'bob' },
        },
      ],
      diagnostics: [],
    },
    recoveryHealth: {
      schemaVersion: 1,
      episodes: [],
      controlRevision: 3,
    },
  };
}

function createCommands(
  syncControl: NonNullable<MemberWorkSyncRuntimeTicketAdmissionPort['syncControl']>,
  readLiveControl?: NonNullable<MemberWorkSyncRuntimeTicketAdmissionPort['readLiveControl']>
) {
  const stored = new Map<string, MemberWorkSyncStatus>([['team-a:bob', status()]]);
  const readStatus = vi.fn(
    async (request: { teamName: string; memberName: string }) =>
      stored.get(`${request.teamName}:${request.memberName}`) ?? null
  );
  const writeStatus = vi.fn(async (next: MemberWorkSyncStatus) => {
    stored.set(`${next.teamName}:${next.memberName}`, next);
  });
  const deps: MemberWorkSyncUseCaseDeps = {
    clock: { now: () => new Date('2026-05-06T00:06:00.000Z') },
    hash: { sha256Hex: (value) => `hash-${value.length}` },
    agendaSource: {
      loadAgenda: async () => {
        throw new Error('not used');
      },
    },
    statusStore: {
      read: readStatus,
      write: writeStatus,
      readTeamMetrics: async () => {
        throw new Error('not used');
      },
    },
    runtimeTicketAdmission: {
      admit: async () => ({ admitted: false, code: 'not_early' }),
      cancel: async () => undefined,
      syncControl,
      ...(readLiveControl ? { readLiveControl } : {}),
    },
  };
  return {
    commands: new MemberWorkSyncRecoveryCommands(deps),
    stored,
    readStatus,
    writeStatus,
  };
}

describe('recovery Stop runtime admission', () => {
  it.each([
    { length: 256, accepted: true },
    { length: 257, accepted: false },
  ])(
    'enforces the $length-character ordinary Stop reason boundary before state or runtime access',
    async ({ length, accepted }) => {
      const syncControl = vi.fn(async (input) => ({
        ok: true as const,
        code: 'closed' as const,
        controlRevision: input.controlRevision,
      }));
      const { commands, stored, readStatus, writeStatus } = createCommands(syncControl);
      const stopping = commands.stop({
        teamName: 'team-a',
        memberName: 'bob',
        reason: 'r'.repeat(length),
      });

      if (accepted) {
        await expect(stopping).resolves.toMatchObject({ code: 'stopped' });
        expect(stored.get('team-a:bob')?.recoveryHealth?.autoResumeStopLatch?.reason).toHaveLength(
          256
        );
        expect(syncControl).toHaveBeenCalledTimes(1);
      } else {
        await expect(stopping).rejects.toBeInstanceOf(MemberWorkSyncRecoveryHealthError);
        expect(readStatus).not.toHaveBeenCalled();
        expect(writeStatus).not.toHaveBeenCalled();
        expect(syncControl).not.toHaveBeenCalled();
        expect(stored.get('team-a:bob')).toEqual(status());
      }
    }
  );

  it.each([
    ['a trailing character beyond the boundary', `${'r'.repeat(256)} `],
    ['an oversized whitespace-only value', ' '.repeat(257)],
  ])('rejects %s before ordinary Stop state or runtime access', async (_label, reason) => {
    const syncControl = vi.fn(async (input) => ({
      ok: true as const,
      code: 'closed' as const,
      controlRevision: input.controlRevision,
    }));
    const { commands, stored, readStatus, writeStatus } = createCommands(syncControl);

    await expect(
      commands.stop({ teamName: 'team-a', memberName: 'bob', reason })
    ).rejects.toBeInstanceOf(MemberWorkSyncRecoveryHealthError);
    expect(readStatus).not.toHaveBeenCalled();
    expect(writeStatus).not.toHaveBeenCalled();
    expect(syncControl).not.toHaveBeenCalled();
    expect(stored.get('team-a:bob')).toEqual(status());
  });

  it.each([undefined, '', '   '])(
    'keeps the ordinary Stop default for absent or empty reason %#',
    async (reason) => {
      const syncControl = vi.fn(async (input) => ({
        ok: true as const,
        code: 'closed' as const,
        controlRevision: input.controlRevision,
      }));
      const { commands, stored } = createCommands(syncControl);

      await commands.stop({ teamName: 'team-a', memberName: 'bob', reason });

      expect(stored.get('team-a:bob')?.recoveryHealth?.autoResumeStopLatch?.reason).toBe(
        'user_stop'
      );
    }
  );

  it('does not persist a latch when the expected runtime was replaced', async () => {
    const { commands, stored } = createCommands(
      async () => {
        throw new Error('sync must not run for a known replacement');
      },
      async () => ({
        runtimeInstanceId: 'runtime-b',
        controlRevision: 1,
        stopped: false,
        handshakeCompleted: true,
      })
    );
    await expect(
      commands.stop({
        teamName: 'team-a',
        memberName: 'bob',
        expectedIncarnation: 'inc-live',
        expectedRuntimeInstanceId: 'runtime-a',
        localStopId: 'local-stop-1',
      })
    ).rejects.toMatchObject({ name: 'MemberWorkSyncStaleRuntimeInstanceError' });
    expect(stored.get('team-a:bob')?.recoveryHealth?.autoResumeStopLatch).toBeUndefined();
    expect(stored.get('team-a:bob')?.recoveryHealth?.durableStopReceipts).toBeUndefined();
  });

  it('leaves no persisted latch when replacement wins at syncControl', async () => {
    const { commands, stored } = createCommands(
      async () => ({ ok: false, code: 'instance_mismatch' }),
      async () => ({
        runtimeInstanceId: 'runtime-a',
        controlRevision: 3,
        stopped: false,
        handshakeCompleted: true,
      })
    );
    await expect(
      commands.stop({
        teamName: 'team-a',
        memberName: 'bob',
        expectedIncarnation: 'inc-live',
        expectedRuntimeInstanceId: 'runtime-a',
        localStopId: 'local-stop-1',
      })
    ).rejects.toMatchObject({ name: 'MemberWorkSyncStaleRuntimeInstanceError' });
    expect(stored.get('team-a:bob')?.recoveryHealth?.autoResumeStopLatch).toBeUndefined();
    expect(stored.get('team-a:bob')?.recoveryHealth?.durableStopReceipts).toBeUndefined();
  });

  it('keeps localStopId durable across Resume and does not stop recovery twice', async () => {
    let live = {
      runtimeInstanceId: 'runtime-a',
      controlRevision: 3,
      stopped: false,
      handshakeCompleted: true,
    };
    const syncControl = vi.fn(async (input) => {
      live = {
        runtimeInstanceId: input.runtimeInstanceId,
        controlRevision: input.controlRevision,
        stopped: input.stopped,
        handshakeCompleted: true,
        ...(input.requestId ? { requestId: input.requestId } : {}),
      };
      return {
        ok: true as const,
        code: input.stopped ? ('closed' as const) : ('open' as const),
        controlRevision: input.controlRevision,
        ...(input.requestId ? { requestId: input.requestId } : {}),
      };
    });
    const { commands, stored } = createCommands(syncControl, async () => live);
    const stop = {
      teamName: 'team-a',
      memberName: 'bob',
      expectedIncarnation: 'inc-live',
      expectedRuntimeInstanceId: 'runtime-a',
      localStopId: 'local-stop-1',
    };
    await commands.stop(stop);
    await commands.resume({ teamName: 'team-a', memberName: 'bob' });
    const replayed = await commands.stop(stop);
    expect(replayed.ok).toBe(true);
    expect(syncControl).toHaveBeenCalledTimes(2);
    expect(stored.get('team-a:bob')?.recoveryHealth?.autoResumeStopLatch).toBeUndefined();
    expect(stored.get('team-a:bob')?.recoveryHealth?.durableStopReceipts).toHaveLength(1);
  });

  it('keeps the durable latch when runtime ACK is applied', async () => {
    const { commands, stored } = createCommands(async (input) => {
      expect(input).toMatchObject({
        teamName: 'team-a',
        memberName: 'bob',
        teamIncarnation: 'inc-live',
        stopped: true,
        controlRevision: 4,
      });
      return { ok: true, code: 'closed', controlRevision: 4 };
    });
    const stopped = await commands.stop({
      teamName: 'team-a',
      memberName: 'bob',
      reason: 'user_stop',
    });
    expect(stopped).toMatchObject({
      ok: true,
      code: 'stopped',
      runtimeAdmission: { state: 'applied', controlRevision: 4 },
    });
    expect(stored.get('team-a:bob')?.recoveryHealth?.autoResumeStopLatch?.controlRevision).toBe(4);
  });

  it('reports pending when the runtime ACK is delayed', async () => {
    const { commands, stored } = createCommands(async () => ({ ok: false, code: 'unknown' }));
    const stopped = await commands.stop({
      teamName: 'team-a',
      memberName: 'bob',
      reason: 'user_stop',
    });
    expect(stopped.ok).toBe(true);
    if (!stopped.ok) {
      return;
    }
    expect(stopped.status.recoveryHealth?.autoResumeStopLatch).toBeDefined();
    expect(stopped.runtimeAdmission).toEqual({ state: 'pending' });
    expect(stopped.status.runtimeAdmission).toEqual({ state: 'pending' });
    expect(stored.get('team-a:bob')?.runtimeAdmission).toEqual({ state: 'pending' });
  });

  it('reports unknown when runtime control CAS conflicts', async () => {
    const { commands } = createCommands(async () => ({ ok: false, code: 'conflict' }));
    const stopped = await commands.stop({
      teamName: 'team-a',
      memberName: 'bob',
      reason: 'user_stop',
    });
    expect(stopped).toMatchObject({
      ok: true,
      runtimeAdmission: { state: 'unknown' },
    });
  });

  it('does not apply a superseded resume after a newer stop latch', async () => {
    const { commands } = createCommands(async (input) => {
      if (input.stopped) {
        return { ok: true, code: 'closed', controlRevision: input.controlRevision };
      }
      return { ok: false, code: 'superseded' };
    });
    const stopped = await commands.stop({
      teamName: 'team-a',
      memberName: 'bob',
      reason: 'user_stop',
    });
    expect(stopped).toMatchObject({
      ok: true,
      runtimeAdmission: { state: 'applied' },
    });
    const resumed = await commands.resume({ teamName: 'team-a', memberName: 'bob' });
    expect(resumed).toMatchObject({
      ok: true,
      code: 'resumed',
      runtimeAdmission: { state: 'superseded', controlRevision: 5 },
    });
  });
});

describe('recovery Stop runtime admission with production CAS binding', () => {
  function createCasCommands(
    syncControl: NonNullable<MemberWorkSyncRuntimeTicketAdmissionPort['syncControl']>
  ) {
    const stored = new Map<string, MemberWorkSyncStatus>([['team-a:bob', status()]]);
    let token = 'tok-1';
    const usedMutationIds = new Set<string>();
    const authority = {
      startRead: (request: { teamName: string; memberName: string }) => ({
        result: Promise.resolve<MemberWorkSyncAuthorityReadResult>({
          ok: true,
          snapshot: {
            status: stored.get(`${request.teamName}:${request.memberName}`) ?? null,
            token,
            incarnation: 'inc-live',
          },
        }),
        settled: Promise.resolve(),
      }),
      startCompareAndWrite: (request: {
        teamName: string;
        memberName: string;
        expectedToken: string;
        mutationId: string;
        nextStatus: MemberWorkSyncStatus;
      }) => ({
        result: Promise.resolve().then((): MemberWorkSyncAuthorityCommitResult => {
          if (!request.mutationId.trim() || usedMutationIds.has(request.mutationId)) {
            return { committed: false, reason: 'invalid_token' };
          }
          usedMutationIds.add(request.mutationId);
          if (request.expectedToken !== token) {
            return {
              committed: false,
              reason: 'conflict',
              current: {
                status: stored.get(`${request.teamName}:${request.memberName}`) ?? null,
                token,
                incarnation: 'inc-live',
              },
            };
          }
          stored.set(`${request.teamName}:${request.memberName}`, request.nextStatus);
          token = `tok-${usedMutationIds.size + 1}`;
          return {
            committed: true,
            snapshot: {
              status: request.nextStatus,
              token,
              incarnation: 'inc-live',
            },
            projectionDegraded: [],
          };
        }),
        settled: Promise.resolve(),
      }),
    };
    const gate = new MemberWorkSyncTeamOperationGate();
    const run = <T>(
      operation: (commands: MemberWorkSyncRecoveryCommands) => Promise<T>
    ): Promise<T> =>
      gate.run('team-a', (admission) => {
        const deps: MemberWorkSyncUseCaseDeps = {
          clock: { now: () => new Date('2026-05-06T00:06:00.000Z') },
          hash: { sha256Hex: (value) => `hash-${value.length}` },
          agendaSource: {
            loadAgenda: async () => {
              throw new Error('not used');
            },
          },
          statusStore: {
            read: async () => {
              throw new Error('blind read forbidden');
            },
            write: async () => {
              throw new Error('blind write forbidden');
            },
            readTeamMetrics: async () => {
              throw new Error('not used');
            },
          },
          statusMutations: createAdmittedMemberWorkSyncStatusPort({
            teamName: 'team-a',
            admission,
            authority,
          }),
          runtimeTicketAdmission: {
            admit: async () => ({ admitted: false, code: 'not_early' }),
            cancel: async () => undefined,
            syncControl,
          },
        };
        return operation(new MemberWorkSyncRecoveryCommands(deps));
      });
    return { run, stored };
  }

  it('persists runtimeAdmission through a second mutation id on Stop and Resume', async () => {
    const { run, stored } = createCasCommands(async (input) => ({
      ok: true,
      code: input.stopped ? 'closed' : 'open',
      controlRevision: input.controlRevision,
    }));
    const stopped = await run((commands) =>
      commands.stop({ teamName: 'team-a', memberName: 'bob', reason: 'user_stop' })
    );
    expect(stopped).toMatchObject({
      ok: true,
      code: 'stopped',
      runtimeAdmission: { state: 'applied', controlRevision: 4 },
    });
    if (!stopped.ok) {
      return;
    }
    expect(stopped.status.runtimeAdmission).toEqual({ state: 'applied', controlRevision: 4 });
    expect(stored.get('team-a:bob')?.runtimeAdmission).toEqual({
      state: 'applied',
      controlRevision: 4,
    });
    const resumed = await run((commands) =>
      commands.resume({ teamName: 'team-a', memberName: 'bob' })
    );
    expect(resumed).toMatchObject({
      ok: true,
      code: 'resumed',
      runtimeAdmission: { state: 'applied', controlRevision: 5 },
    });
    if (!resumed.ok) {
      return;
    }
    expect(stored.get('team-a:bob')?.runtimeAdmission).toEqual({
      state: 'applied',
      controlRevision: 5,
    });
  });
});
