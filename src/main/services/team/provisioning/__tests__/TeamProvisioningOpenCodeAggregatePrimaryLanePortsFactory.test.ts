import { describe, expect, it, vi } from 'vitest';

import {
  createTeamProvisioningOpenCodeAggregatePrimaryLanePortsFromService,
  type TeamProvisioningOpenCodeAggregatePrimaryLaneServiceHost,
} from '../TeamProvisioningOpenCodeAggregatePrimaryLanePortsFactory';

import type { TeamRuntimeLaunchInput, TeamRuntimeLaunchResult } from '../../runtime';
import type { PersistedTeamLaunchSnapshot } from '@shared/types';

function createHost(): TeamProvisioningOpenCodeAggregatePrimaryLaneServiceHost {
  return {
    prepareFacade: {
      getOpenCodeRuntimeLaunchCwd: vi.fn((baseCwd) => `${baseCwd}/.opencode`),
    },
    persistOpenCodeRuntimeAdapterLaunchResult: vi.fn(async (result, launchInput) => ({
      snapshot: {
        teamName: launchInput.teamName,
        runId: launchInput.runId,
        members: [],
      } as unknown as PersistedTeamLaunchSnapshot,
      result,
    })),
    toolApprovalFacade: {
      syncOpenCodeRuntimeToolApprovals: vi.fn(),
    },
    runtimeAdapterRunByTeam: new Map(),
  };
}

describe('TeamProvisioningOpenCodeAggregatePrimaryLanePortsFactory', () => {
  it('builds aggregate primary lane ports from service-shaped dependencies', async () => {
    const host = createHost();
    const migrateLegacyOpenCodeRuntimeState = vi.fn(async () => ({ degraded: false }));
    const upsertOpenCodeRuntimeLaneIndexEntry = vi.fn(async () => undefined);
    const setOpenCodeRuntimeActiveRunManifest = vi.fn(async () => undefined);
    const ports = createTeamProvisioningOpenCodeAggregatePrimaryLanePortsFromService(host, {
      getTeamsBasePath: () => '/teams',
      migrateLegacyOpenCodeRuntimeState,
      upsertOpenCodeRuntimeLaneIndexEntry,
      setOpenCodeRuntimeActiveRunManifest,
    });
    const launchInput = {
      runId: 'run-1',
      laneId: 'primary',
      teamName: 'alpha',
      cwd: '/workspace',
      prompt: 'go',
      providerId: 'opencode',
      skipPermissions: true,
      expectedMembers: [],
      previousLaunchState: null,
    } as TeamRuntimeLaunchInput;
    const launchResult = {
      runId: 'run-1',
      cwd: '/workspace',
      members: {},
    } as unknown as TeamRuntimeLaunchResult;

    expect(ports.getTeamsBasePath()).toBe('/teams');
    expect(ports.getOpenCodeRuntimeLaunchCwd('/workspace', [])).toBe('/workspace/.opencode');
    await expect(
      ports.persistOpenCodeRuntimeAdapterLaunchResult(launchResult, launchInput)
    ).resolves.toMatchObject({ result: launchResult });
    ports.syncOpenCodeRuntimeToolApprovals({
      teamName: 'alpha',
      runId: 'run-1',
      laneId: 'primary',
      cwd: '/workspace',
      members: {},
      expectedMembers: [],
    });
    ports.setRuntimeAdapterRunByTeam('alpha', {
      runId: 'run-1',
      providerId: 'opencode',
      cwd: '/workspace',
      members: {},
    });

    await ports.migrateLegacyOpenCodeRuntimeState({
      teamsBasePath: '/teams',
      teamName: 'alpha',
      laneId: 'primary',
    });
    await ports.upsertOpenCodeRuntimeLaneIndexEntry({
      teamsBasePath: '/teams',
      teamName: 'alpha',
      laneId: 'primary',
      state: 'active',
    });
    await ports.setOpenCodeRuntimeActiveRunManifest({
      teamsBasePath: '/teams',
      teamName: 'alpha',
      laneId: 'primary',
      runId: 'run-1',
    });

    expect(host.prepareFacade.getOpenCodeRuntimeLaunchCwd).toHaveBeenCalledWith('/workspace', []);
    expect(host.persistOpenCodeRuntimeAdapterLaunchResult).toHaveBeenCalledWith(
      launchResult,
      launchInput
    );
    expect(host.toolApprovalFacade.syncOpenCodeRuntimeToolApprovals).toHaveBeenCalledWith(
      expect.objectContaining({ teamName: 'alpha', runId: 'run-1' })
    );
    expect(host.runtimeAdapterRunByTeam.get('alpha')).toMatchObject({
      runId: 'run-1',
      providerId: 'opencode',
    });
    expect(migrateLegacyOpenCodeRuntimeState).toHaveBeenCalledWith(
      expect.objectContaining({ teamsBasePath: '/teams' })
    );
    expect(upsertOpenCodeRuntimeLaneIndexEntry).toHaveBeenCalledWith(
      expect.objectContaining({ state: 'active' })
    );
    expect(setOpenCodeRuntimeActiveRunManifest).toHaveBeenCalledWith(
      expect.objectContaining({ runId: 'run-1' })
    );
  });
});
