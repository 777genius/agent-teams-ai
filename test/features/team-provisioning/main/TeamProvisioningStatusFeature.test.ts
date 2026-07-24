import { createTeamProvisioningStatusFeature } from '@features/team-provisioning/main';
import { LegacyProvisioningStatusReaderAdapter } from '@features/team-provisioning/main/adapters/output/LegacyProvisioningStatusReaderAdapter';
import { describe, expect, it, vi } from 'vitest';

import type { TeamProvisioningProgress } from '@shared/types/team';

function progress(): TeamProvisioningProgress {
  return {
    runId: 'run-1',
    teamName: 'team-1',
    state: 'ready',
    message: 'Ready',
    startedAt: '2026-07-22T10:00:00.000Z',
    updatedAt: '2026-07-22T10:00:01.000Z',
  };
}

describe('Team Provisioning status feature', () => {
  it('adapts the legacy state owner through explicit narrow dependencies', async () => {
    const snapshot = progress();
    const runs = new Map([['run-1', { progress: snapshot }]]);
    const findProvisioningStatus = vi.fn(() => snapshot);
    const reader = new LegacyProvisioningStatusReaderAdapter({
      progressSource: { findProvisioningStatus },
      runs,
    });

    await expect(reader.findByRunId('run-1')).resolves.toBe(snapshot);
    expect(findProvisioningStatus).toHaveBeenCalledWith('run-1', runs);
  });

  it('composes the adapter and use case behind the stable status API', async () => {
    const snapshot = progress();
    const feature = createTeamProvisioningStatusFeature({
      progressSource: {
        findProvisioningStatus: (runId) => (runId === snapshot.runId ? snapshot : undefined),
      },
      runs: new Map(),
    });

    await expect(feature.getProvisioningStatus('run-1')).resolves.toBe(snapshot);
    await expect(feature.getProvisioningStatus('missing-run')).rejects.toThrow('Unknown runId');
  });
});
