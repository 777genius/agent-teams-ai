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

  // The guard this port feeds reads only an answered `false` as proof that a
  // member holds no session record. The store reader reports a manifest it
  // could not read - a lock held by a concurrent bootstrap check-in, say - as
  // an empty session list, so answering from it would turn that contention
  // into a downgrade of a healthy member. It has to raise instead.
  it('raises rather than answering false when the committed store did not answer', async () => {
    const ports = createTeamProvisioningOpenCodeSecondaryLaneEvidencePortsFromService(
      createHost(),
      {
        getTeamsBasePath: () => '/teams',
        readCommittedBootstrapSessionEvidence: async () => ({
          state: 'invalid_store' as const,
          committed: false,
          activeRunId: null,
          sessions: [],
          diagnostics: ['OpenCode runtime manifest could not be read.'],
        }),
        logWarn: vi.fn(),
      }
    );

    await expect(
      ports.hasCommittedOpenCodeLaneMemberSessionEvidence?.({
        teamName: 'alpha',
        laneId: 'lane-1',
        runId: 'run-1',
        memberName: 'ada',
      })
    ).rejects.toThrow('unavailable (invalid_store)');
  });

  it('answers false when the store answered and holds no record for the member', async () => {
    const ports = createTeamProvisioningOpenCodeSecondaryLaneEvidencePortsFromService(
      createHost(),
      {
        getTeamsBasePath: () => '/teams',
        readCommittedBootstrapSessionEvidence: async () => ({
          state: 'healthy' as const,
          committed: true,
          activeRunId: 'run-1',
          sessions: [],
          diagnostics: [],
        }),
        logWarn: vi.fn(),
      }
    );

    await expect(
      ports.hasCommittedOpenCodeLaneMemberSessionEvidence?.({
        teamName: 'alpha',
        laneId: 'lane-1',
        runId: 'run-1',
        memberName: 'ada',
      })
    ).resolves.toBe(false);
  });
});
