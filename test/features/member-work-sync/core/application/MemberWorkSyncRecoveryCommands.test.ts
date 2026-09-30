import {
  MemberWorkSyncRecoveryCommands,
  MemberWorkSyncStaleIncarnationError,
} from '@features/member-work-sync/core/application';
import { describe, expect, it, vi } from 'vitest';

import type { MemberWorkSyncStatus } from '@features/member-work-sync/contracts';
import type { MemberWorkSyncUseCaseDeps } from '@features/member-work-sync/core/application';

const status = (incarnation: string): MemberWorkSyncStatus =>
  ({
    teamName: 'team-a',
    memberName: 'bob',
    state: 'needs_sync',
    evaluatedAt: '2026-09-15T00:00:00.000Z',
    diagnostics: [],
    agenda: {
      teamName: 'team-a',
      memberName: 'bob',
      generatedAt: '2026-09-15T00:00:00.000Z',
      fingerprint: 'agenda:v1:incarnation-fence',
      items: [],
      diagnostics: [],
    },
    statusRevision: { incarnation, lineageId: 'lineage', sequence: 1, nonce: 'nonce' },
    recoveryHealth: { schemaVersion: 1, episodes: [] },
  }) satisfies MemberWorkSyncStatus;

describe('MemberWorkSyncRecoveryCommands stop incarnation fence', () => {
  it.each([
    {
      name: 'status incarnation changed',
      statusIncarnation: 'incarnation-b',
      snapshotIncarnation: 'incarnation-a',
    },
    {
      name: 'authority snapshot incarnation changed',
      statusIncarnation: 'incarnation-a',
      snapshotIncarnation: 'incarnation-b',
    },
  ])('refuses the mutation when the $name', async ({ statusIncarnation, snapshotIncarnation }) => {
    const compareAndWrite = vi.fn();
    const deps = {
      clock: { now: () => new Date('2026-09-15T00:00:00.000Z') },
      statusStore: { read: vi.fn(), write: vi.fn() },
      statusMutations: {
        createMutationId: () => 'mutation-1',
        readSnapshot: async () => ({
          ok: true as const,
          snapshot: {
            status: status(statusIncarnation),
            token: 'token-1',
            incarnation: snapshotIncarnation,
          },
        }),
        compareAndWrite,
      },
    } as unknown as MemberWorkSyncUseCaseDeps;

    await expect(
      new MemberWorkSyncRecoveryCommands(deps).stop({
        teamName: 'team-a',
        memberName: 'bob',
        expectedIncarnation: 'incarnation-a',
      })
    ).rejects.toBeInstanceOf(MemberWorkSyncStaleIncarnationError);
    expect(compareAndWrite).not.toHaveBeenCalled();
    expect(deps.statusStore.write).not.toHaveBeenCalled();
  });
});
