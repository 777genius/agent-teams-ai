import { MemberWorkSyncRecoveryCommands } from '@features/member-work-sync/core/application';
import { describe, expect, it } from 'vitest';

import type { MemberWorkSyncStatus } from '@features/member-work-sync/contracts';
import type {
  MemberWorkSyncRuntimeTicketAdmissionPort,
  MemberWorkSyncUseCaseDeps,
} from '@features/member-work-sync/core/application';

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
  syncControl: NonNullable<MemberWorkSyncRuntimeTicketAdmissionPort['syncControl']>
) {
  const stored = new Map<string, MemberWorkSyncStatus>([['team-a:bob', status()]]);
  const deps: MemberWorkSyncUseCaseDeps = {
    clock: { now: () => new Date('2026-05-06T00:06:00.000Z') },
    hash: { sha256Hex: (value) => `hash-${value.length}` },
    agendaSource: {
      loadAgenda: async () => {
        throw new Error('not used');
      },
    },
    statusStore: {
      read: async (request) => stored.get(`${request.teamName}:${request.memberName}`) ?? null,
      write: async (next) => {
        stored.set(`${next.teamName}:${next.memberName}`, next);
      },
      readTeamMetrics: async () => {
        throw new Error('not used');
      },
    },
    runtimeTicketAdmission: {
      admit: async () => ({ admitted: false, code: 'not_early' }),
      cancel: async () => undefined,
      syncControl,
    },
  };
  return { commands: new MemberWorkSyncRecoveryCommands(deps), stored };
}

describe('recovery Stop runtime admission', () => {
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
