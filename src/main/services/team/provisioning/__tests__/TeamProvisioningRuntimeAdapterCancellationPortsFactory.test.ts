import { describe, expect, it, vi } from 'vitest';

import {
  createTeamProvisioningRuntimeAdapterCancellationPorts,
  type TeamProvisioningRuntimeAdapterCancellationPortsFactoryDeps,
} from '../TeamProvisioningRuntimeAdapterCancellationPortsFactory';

import type { TeamChangeEvent, TeamProvisioningProgress } from '@shared/types';

describe('TeamProvisioningRuntimeAdapterCancellationPortsFactory', () => {
  it('wires runtime adapter cancellation ports from provisioning service dependencies', async () => {
    const deps = buildDeps();
    const ports = createTeamProvisioningRuntimeAdapterCancellationPorts(deps);
    const progress = buildProgress();
    const event: TeamChangeEvent = {
      type: 'process',
      teamName: 'alpha',
      runId: 'run-1',
      detail: 'cancelled',
    };

    expect(ports.cancelledRuntimeAdapterRunIds).toBe(deps.cancelledRuntimeAdapterRunIds);
    expect(ports.runtimeAdapterRunByTeam).toBe(deps.runtimeAdapterRunByTeam);
    expect(ports.provisioningRunByTeam).toBe(deps.provisioningRunByTeam);
    expect(ports.aliveRunByTeam).toBe(deps.aliveRunByTeam);
    expect(ports.teamsBasePath).toMatch(/[/\\]teams$/);
    expect(typeof ports.clearOpenCodeRuntimeLaneStorage).toBe('function');

    ports.clearOpenCodeRuntimeToolApprovals('alpha', {
      runId: 'run-1',
      laneId: 'primary',
      emitDismiss: true,
    });
    ports.deleteAliveRunId('alpha');
    ports.invalidateRuntimeSnapshotCaches('alpha');
    ports.setRuntimeAdapterProgress(progress);
    ports.emitTeamChange(event);
    await ports.readLaunchState('alpha');
    ports.getOpenCodeRuntimeAdapter();
    ports.readPersistedTeamProjectPath('alpha');
    ports.logWarning('cancel warning');

    expect(deps.clearOpenCodeRuntimeToolApprovals).toHaveBeenCalledWith('alpha', {
      runId: 'run-1',
      laneId: 'primary',
      emitDismiss: true,
    });
    expect(deps.deleteAliveRunId).toHaveBeenCalledWith('alpha');
    expect(deps.invalidateRuntimeSnapshotCaches).toHaveBeenCalledWith('alpha');
    expect(deps.setRuntimeAdapterProgress).toHaveBeenCalledWith(progress);
    expect(deps.emitTeamChange).toHaveBeenCalledWith(event);
    expect(deps.readLaunchState).toHaveBeenCalledWith('alpha');
    expect(deps.getOpenCodeRuntimeAdapter).toHaveBeenCalled();
    expect(deps.readPersistedTeamProjectPath).toHaveBeenCalledWith('alpha');
    expect(deps.logWarning).toHaveBeenCalledWith('cancel warning');
  });

  it('keeps the optional team change emitter behavior', () => {
    const deps = buildDeps({ emitTeamChange: undefined });
    const ports = createTeamProvisioningRuntimeAdapterCancellationPorts(deps);

    expect(() =>
      ports.emitTeamChange({
        type: 'process',
        teamName: 'alpha',
        runId: 'run-1',
        detail: 'cancelled',
      })
    ).not.toThrow();
  });
});

function buildDeps(
  overrides: Partial<TeamProvisioningRuntimeAdapterCancellationPortsFactoryDeps> = {}
): TeamProvisioningRuntimeAdapterCancellationPortsFactoryDeps {
  return {
    cancelledRuntimeAdapterRunIds: new Set<string>(),
    runtimeAdapterRunByTeam: new Map(),
    provisioningRunByTeam: new Map(),
    aliveRunByTeam: new Map(),
    nowIso: vi.fn(() => '2026-01-01T00:00:00.000Z'),
    clearOpenCodeRuntimeToolApprovals: vi.fn(),
    deleteAliveRunId: vi.fn(),
    invalidateRuntimeSnapshotCaches: vi.fn(),
    setRuntimeAdapterProgress: vi.fn((progress) => progress),
    emitTeamChange: vi.fn(),
    readLaunchState: vi.fn(async () => null),
    getOpenCodeRuntimeAdapter: vi.fn(() => null),
    readPersistedTeamProjectPath: vi.fn(() => '/workspace'),
    logWarning: vi.fn(),
    ...overrides,
  };
}

function buildProgress(): TeamProvisioningProgress {
  return {
    runId: 'run-1',
    teamName: 'alpha',
    state: 'cancelled',
    message: 'Provisioning cancelled by user',
    startedAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}
