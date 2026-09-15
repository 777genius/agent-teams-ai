import { createMemberWorkSyncRuntimeTicketAdmissionRouter } from '@features/member-work-sync/main/composition/createMemberWorkSyncRuntimeTicketAdmissionRouter';
import { encodeTeamMemberStorageKey } from '@main/services/team/TeamMemberStoragePaths';
import { mkdir, mkdtemp, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it } from 'vitest';

import type { MemberWorkSyncRuntimeTicketAdmissionPort } from '@features/member-work-sync/core/application';

describe('createMemberWorkSyncRuntimeTicketAdmissionRouter', () => {
  it('returns native stale without asking OpenCode to confirm', async () => {
    const root = await mkdtemp(join(tmpdir(), 'work-sync-router-'));
    const memberRoot = join(
      root,
      'team-a',
      'members',
      encodeTeamMemberStorageKey('bob'),
      '.member-work-sync',
      'runtime-admission'
    );
    await mkdir(memberRoot, { recursive: true });
    await writeFile(
      join(memberRoot, 'snapshot.json'),
      `${JSON.stringify({
        runtimeInstanceId: 'runtime-1',
        status: 'idle',
        continuation: null,
      })}\n`
    );
    let opencodeConfirm = 0;
    const opencodeAdmission: MemberWorkSyncRuntimeTicketAdmissionPort = {
      admit: async () => ({ admitted: false, code: 'not_early' }),
      cancel: async () => undefined,
      confirmReserved: async () => {
        opencodeConfirm += 1;
        return { ok: true };
      },
    };
    const router = createMemberWorkSyncRuntimeTicketAdmissionRouter({
      teamsBasePath: root,
      opencodeAdmission,
    });
    await expect(
      router.confirmReserved?.({
        teamName: 'team-a',
        teamIncarnation: 'inc-1',
        memberName: 'bob',
        runtimeInstanceId: 'runtime-1',
        expectedGeneration: 1,
        ticketId: 'ticket-1',
        intentId: 'intent-c1',
        controlRevision: 1,
        admissionPayloadHash: 'hash-a',
      })
    ).resolves.toEqual({ ok: false, code: 'stale' });
    expect(opencodeConfirm).toBe(0);
  });
});
