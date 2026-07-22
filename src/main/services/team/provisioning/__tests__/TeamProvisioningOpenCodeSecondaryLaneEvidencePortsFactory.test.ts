import { describe, expect, it, vi } from 'vitest';

import {
  createTeamProvisioningOpenCodeSecondaryLaneEvidencePortsFromService,
  type TeamProvisioningOpenCodeSecondaryLaneEvidenceServiceHost,
} from '../TeamProvisioningOpenCodeSecondaryLaneEvidencePortsFactory';

import type { TeamRuntimeLaunchResult } from '../../runtime';

function createHost(): TeamProvisioningOpenCodeSecondaryLaneEvidenceServiceHost {
  return {
    commitOpenCodeRuntimeAdapterLaunchSessionEvidence: vi.fn(async (input) => input.result),
  };
}

describe('TeamProvisioningOpenCodeSecondaryLaneEvidencePortsFactory', () => {
  it('builds secondary lane evidence guard ports from service dependencies', async () => {
    const host = createHost();
    const inspectOpenCodeRuntimeLaneStorage = vi.fn(async () => ({
      laneDirectoryExists: true,
      hasStateOnDisk: true,
      hasRuntimeEvidenceOnDisk: true,
      manifestEntryCount: 1,
      manifestUpdatedAt: '2026-07-08T00:00:00.000Z',
      fileNames: ['runtime.json'],
    }));
    const upsertOpenCodeRuntimeLaneIndexEntry = vi.fn(async () => undefined);
    const logWarn = vi.fn();
    const ports = createTeamProvisioningOpenCodeSecondaryLaneEvidencePortsFromService(host, {
      getTeamsBasePath: () => '/teams',
      inspectOpenCodeRuntimeLaneStorage,
      upsertOpenCodeRuntimeLaneIndexEntry,
      logWarn,
    });
    const result = {
      runId: 'run-1',
      members: {},
      diagnostics: [],
    } as unknown as TeamRuntimeLaunchResult;

    await expect(
      ports.commitOpenCodeRuntimeAdapterLaunchSessionEvidence({
        teamName: 'alpha',
        laneId: 'lane-1',
        result,
      })
    ).resolves.toBe(result);
    await ports.inspectOpenCodeRuntimeLaneStorage({
      teamName: 'alpha',
      laneId: 'lane-1',
    });
    await ports.upsertOpenCodeRuntimeLaneIndexEntry({
      teamName: 'alpha',
      laneId: 'lane-1',
      state: 'active',
      diagnostics: ['missing evidence'],
    });
    ports.logWarn('warn');

    expect(host.commitOpenCodeRuntimeAdapterLaunchSessionEvidence).toHaveBeenCalledWith({
      teamName: 'alpha',
      laneId: 'lane-1',
      result,
    });
    expect(inspectOpenCodeRuntimeLaneStorage).toHaveBeenCalledWith({
      teamsBasePath: '/teams',
      teamName: 'alpha',
      laneId: 'lane-1',
    });
    expect(upsertOpenCodeRuntimeLaneIndexEntry).toHaveBeenCalledWith({
      teamsBasePath: '/teams',
      teamName: 'alpha',
      laneId: 'lane-1',
      state: 'active',
      diagnostics: ['missing evidence'],
    });
    expect(logWarn).toHaveBeenCalledWith('warn');
  });
});
