import { LegacyRuntimeSnapshotReaderAdapter } from '@features/team-provisioning/main/adapters/output/LegacyRuntimeSnapshotReaderAdapter';
import { createTeamProvisioningRuntimeSnapshotFeature } from '@features/team-provisioning/main/composition/createTeamProvisioningRuntimeSnapshotFeature';
import { describe, expect, it, vi } from 'vitest';

import type { TeamAgentRuntimeSnapshot } from '@shared/types/team';

function runtimeSnapshot(updatedAt = '2026-07-26T10:00:00.000Z'): TeamAgentRuntimeSnapshot {
  return {
    teamName: 'team-1',
    updatedAt,
    runId: 'run-1',
    members: {},
  };
}

describe('Team Provisioning runtime snapshot feature', () => {
  it('adapts the legacy reader through one explicit narrow dependency', async () => {
    const snapshot = runtimeSnapshot();
    const getTeamAgentRuntimeSnapshot = vi.fn(() => Promise.resolve(snapshot));
    const reader = new LegacyRuntimeSnapshotReaderAdapter({
      snapshotSource: { getTeamAgentRuntimeSnapshot },
    });

    await expect(reader.readByTeamName('  team-1  ')).resolves.toBe(snapshot);
    expect(getTeamAgentRuntimeSnapshot).toHaveBeenCalledOnce();
    expect(getTeamAgentRuntimeSnapshot).toHaveBeenCalledWith('  team-1  ');
  });

  it('composes the adapter and use case behind the stable runtime snapshot API', async () => {
    const firstSnapshot = runtimeSnapshot('2026-07-26T10:00:00.000Z');
    const secondSnapshot = runtimeSnapshot('2026-07-26T10:00:01.000Z');
    const getTeamAgentRuntimeSnapshot = vi
      .fn()
      .mockResolvedValueOnce(firstSnapshot)
      .mockResolvedValueOnce(secondSnapshot);
    const feature = createTeamProvisioningRuntimeSnapshotFeature({
      snapshotSource: { getTeamAgentRuntimeSnapshot },
    });

    const [first, second] = await Promise.all([
      feature.getTeamAgentRuntimeSnapshot('team-1'),
      feature.getTeamAgentRuntimeSnapshot('team-1'),
    ]);

    expect(first).toBe(firstSnapshot);
    expect(second).toBe(secondSnapshot);
    expect(getTeamAgentRuntimeSnapshot).toHaveBeenCalledTimes(2);
  });

  it('preserves the legacy reader error object', async () => {
    const failure = new Error('runtime snapshot unavailable');
    const feature = createTeamProvisioningRuntimeSnapshotFeature({
      snapshotSource: {
        getTeamAgentRuntimeSnapshot: () => Promise.reject(failure),
      },
    });

    await expect(feature.getTeamAgentRuntimeSnapshot('team-1')).rejects.toBe(failure);
  });
});
