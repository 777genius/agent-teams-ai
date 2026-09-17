import { describe, expect, it } from 'vitest';

import {
  isMemberSpawnStatusesSnapshotReadCurrent,
  shouldCacheMemberSpawnStatusesSnapshot,
} from '../TeamProvisioningMemberSpawnSnapshotCurrency';

function ports(trackedRunId: string | null, runId?: string) {
  return {
    getRun: (id: string) => (runId && id === runId ? { runId } : undefined),
    cache: {
      getCacheGeneration: () => 1,
      getTrackedRunId: () => trackedRunId,
    },
  };
}

describe('TeamProvisioningMemberSpawnSnapshotCurrency', () => {
  it('caches only an in-progress launch run', () => {
    expect(
      shouldCacheMemberSpawnStatusesSnapshot({ isLaunch: true, provisioningComplete: false })
    ).toBe(true);
    expect(
      shouldCacheMemberSpawnStatusesSnapshot({ isLaunch: true, provisioningComplete: true })
    ).toBe(false);
    expect(
      shouldCacheMemberSpawnStatusesSnapshot({ isLaunch: false, provisioningComplete: false })
    ).toBe(false);
  });

  it('treats a dangling tracked run id as no live run', () => {
    expect(
      isMemberSpawnStatusesSnapshotReadCurrent({
        teamName: 'demo',
        runIdAtStart: null,
        generationAtStart: 1,
        ports: ports('run-stale'),
      })
    ).toBe(true);
    expect(
      isMemberSpawnStatusesSnapshotReadCurrent({
        teamName: 'demo',
        runIdAtStart: 'run-stale',
        generationAtStart: 1,
        ports: ports('run-stale'),
      })
    ).toBe(false);
  });
});
