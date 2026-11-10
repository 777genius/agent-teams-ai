import { describe, expect, it, vi } from 'vitest';

import { createTeamProvisioningOpenCodeSecondaryEvidenceOverlayPorts } from '../TeamProvisioningOpenCodeSecondaryEvidenceOverlayPortsFactory';

import type { RuntimeRunTombstoneStore } from '../../opencode/store/RuntimeRunTombstoneStore';

describe('TeamProvisioningOpenCodeSecondaryEvidenceOverlayPortsFactory', () => {
  it('wires secondary overlay evidence readers through the current teams base path', async () => {
    const getTeamsBasePath = vi
      .fn()
      .mockReturnValueOnce('/teams/base-a')
      .mockReturnValueOnce('/teams/base-b');
    const laneIndex = {
      version: 1 as const,
      updatedAt: '2026-01-01T00:00:00.000Z',
      lanes: {},
    };
    const readLaneIndex = vi.fn(async () => laneIndex);
    const readCommittedBootstrapSessionEvidence = vi.fn(async () => ({
      state: 'healthy' as const,
      committed: true,
      activeRunId: 'run-1',
      sessions: [],
      diagnostics: [],
    }));
    const nowIso = vi.fn(() => '2026-01-01T00:00:00.000Z');

    const ports = createTeamProvisioningOpenCodeSecondaryEvidenceOverlayPorts({
      getTeamsBasePath,
      nowIso,
      readLaneIndex,
      readCommittedBootstrapSessionEvidence,
    });

    await expect(ports.readLaneIndex('Team')).resolves.toEqual(laneIndex);
    await expect(
      ports.readCommittedBootstrapSessionEvidence({ teamName: 'Team', laneId: 'lane-a' })
    ).resolves.toMatchObject({ committed: true, activeRunId: 'run-1' });
    expect(ports.nowIso()).toBe('2026-01-01T00:00:00.000Z');

    expect(readLaneIndex).toHaveBeenCalledWith('/teams/base-a', 'Team');
    expect(readCommittedBootstrapSessionEvidence).toHaveBeenCalledWith({
      teamsBasePath: '/teams/base-b',
      teamName: 'Team',
      laneId: 'lane-a',
    });
    expect(nowIso).toHaveBeenCalledTimes(1);
  });

  it('wires bootstrap check-in tombstone lookup and treats store errors as absent', async () => {
    const find = vi
      .fn()
      .mockResolvedValueOnce({ tombstoneId: 'tombstone-1' })
      .mockRejectedValueOnce(new Error('store unavailable'));
    const createRuntimeRunTombstoneStore = vi.fn(
      () =>
        ({
          find,
        }) as unknown as RuntimeRunTombstoneStore
    );
    const getRuntimeRunTombstonesPath = vi.fn(
      (teamsBasePath: string, teamName: string, laneId?: string | null) =>
        `${teamsBasePath}/${teamName}/${laneId ?? 'primary'}/tombstones.json`
    );

    const ports = createTeamProvisioningOpenCodeSecondaryEvidenceOverlayPorts({
      getTeamsBasePath: () => '/teams/base',
      nowIso: () => '2026-01-01T00:00:00.000Z',
      getRuntimeRunTombstonesPath,
      createRuntimeRunTombstoneStore,
    });

    await expect(
      ports.hasBootstrapCheckinTombstone({
        teamName: 'Team',
        laneId: 'lane-a',
        runId: 'run-1',
      })
    ).resolves.toBe(true);
    await expect(
      ports.hasBootstrapCheckinTombstone({
        teamName: 'Team',
        laneId: 'lane-a',
        runId: 'run-2',
      })
    ).resolves.toBe(false);

    expect(getRuntimeRunTombstonesPath).toHaveBeenCalledWith('/teams/base', 'Team', 'lane-a');
    expect(createRuntimeRunTombstoneStore).toHaveBeenCalledWith({
      filePath: '/teams/base/Team/lane-a/tombstones.json',
    });
    expect(find).toHaveBeenCalledWith({
      teamName: 'Team',
      runId: 'run-1',
      evidenceKind: 'bootstrap_checkin',
    });
    expect(find).toHaveBeenCalledWith({
      teamName: 'Team',
      runId: 'run-2',
      evidenceKind: 'bootstrap_checkin',
    });
  });
});
