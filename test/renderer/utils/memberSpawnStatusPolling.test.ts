import { describe, expect, it } from 'vitest';

import { hasUnresolvedMemberSpawnStatus } from '@renderer/utils/memberSpawnStatusPolling';

describe('hasUnresolvedMemberSpawnStatus', () => {
  it('continues polling while any launch member is still starting', () => {
    expect(
      hasUnresolvedMemberSpawnStatus(
        {
          bob: {
            status: 'spawning',
            launchState: 'starting',
            updatedAt: '2026-04-23T10:00:00.000Z',
          },
        },
        undefined
      )
    ).toBe(true);
  });

  it('continues polling after ready while snapshot summary still has pending members', () => {
    expect(
      hasUnresolvedMemberSpawnStatus(
        {
          alice: {
            status: 'online',
            launchState: 'confirmed_alive',
            updatedAt: '2026-04-23T10:00:00.000Z',
          },
        },
        {
          summary: {
            pendingCount: 1,
          },
        }
      )
    ).toBe(true);
  });

  it('stops polling when every member is terminal confirmed or failed', () => {
    expect(
      hasUnresolvedMemberSpawnStatus(
        {
          alice: {
            status: 'online',
            launchState: 'confirmed_alive',
            updatedAt: '2026-04-23T10:00:00.000Z',
          },
          bob: {
            status: 'error',
            launchState: 'failed_to_start',
            updatedAt: '2026-04-23T10:00:00.000Z',
          },
        },
        {
          summary: {
            pendingCount: 0,
          },
        }
      )
    ).toBe(false);
  });
});
