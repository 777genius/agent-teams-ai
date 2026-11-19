import { describe, expect, it } from 'vitest';

import { readMemberWorkSyncStatus } from '@features/member-work-sync/core/application/MemberWorkSyncStatusMutation';

import type { MemberWorkSyncUseCaseDeps } from '@features/member-work-sync/core/application/ports';

describe('member work sync status mutation failure detail', () => {
  it('keeps the coarse reason and names the real cause in the error', async () => {
    const deps = {
      statusMutations: {
        readSnapshot: () =>
          Promise.resolve({ ok: false, reason: 'corrupt', detail: 'incarnation_mismatch' }),
      },
    } as unknown as MemberWorkSyncUseCaseDeps;
    await expect(
      readMemberWorkSyncStatus(deps, { teamName: 't', memberName: 'm' })
    ).rejects.toMatchObject({
      name: 'MemberWorkSyncStatusMutationError',
      reason: 'corrupt',
      detail: 'incarnation_mismatch',
      message: 'member work sync status mutation corrupt (incarnation_mismatch)',
    });
  });

  it('leaves the message unchanged when there is no detail', async () => {
    const deps = {
      statusMutations: { readSnapshot: () => Promise.resolve({ ok: false, reason: 'corrupt' }) },
    } as unknown as MemberWorkSyncUseCaseDeps;
    await expect(
      readMemberWorkSyncStatus(deps, { teamName: 't', memberName: 'm' })
    ).rejects.toMatchObject({
      message: 'member work sync status mutation corrupt',
    });
  });
});
