import { describe, expect, it, vi } from 'vitest';

import {
  createTeamProvisioningOpenCodeRuntimeRecoveryFacadeFromService,
  type TeamProvisioningOpenCodeRuntimeRecoveryFacadeServiceHost,
} from '../TeamProvisioningOpenCodeRuntimeRecoveryFacade';

import type { TeamProvisioningOpenCodeRuntimeLaneRecoveryFacadeHelpers } from '../TeamProvisioningOpenCodeRuntimeLaneRecoveryFacade';
import type { OpenCodeRuntimeLaneRecoveryPorts } from '../TeamProvisioningOpenCodeRuntimeRecoveryFlow';

describe('TeamProvisioningOpenCodeRuntimeRecoveryFacade', () => {
  it('owns OpenCode runtime directory identity and lane recovery delegation', async () => {
    const capturedPorts: OpenCodeRuntimeLaneRecoveryPorts[] = [];
    const recoverBeforeDelivery: TeamProvisioningOpenCodeRuntimeLaneRecoveryFacadeHelpers['tryRecoverOpenCodeRuntimeLaneBeforeDelivery'] =
      async (_input, ports) => {
        capturedPorts.push(ports);
        const directory = await ports.readOpenCodeMemberDirectory('alpha');
        expect(
          ports.resolveOpenCodeMemberIdentityFromDirectory('alpha', 'bob', directory)
        ).toMatchObject({
          ok: true,
          canonicalMemberName: 'Bob',
          laneId: 'secondary:opencode:bob',
        });
        return true;
      };
    const service = createService();
    const facade = createTeamProvisioningOpenCodeRuntimeRecoveryFacadeFromService(service, {
      getTeamsBasePath: () => '/safe-test/teams',
      helpers: {
        tryRecoverOpenCodeRuntimeLaneBeforeDelivery: vi.fn(recoverBeforeDelivery),
      },
    });

    await expect(
      facade.resolveOpenCodeMemberDeliveryIdentity('alpha', 'bob')
    ).resolves.toMatchObject({
      ok: true,
      canonicalMemberName: 'Bob',
      laneId: 'secondary:opencode:bob',
    });
    await expect(
      facade.openCodeRuntimeRecoveryIdentity.resolveCurrentOpenCodeRuntimeRunId(
        'alpha',
        'secondary:opencode:bob'
      )
    ).resolves.toBe('runtime-run-1');
    await expect(
      facade.tryRecoverOpenCodeRuntimeLaneBeforeDelivery({
        teamName: 'alpha',
        laneId: 'secondary:opencode:bob',
        member: { name: 'Bob', providerId: 'opencode' },
        projectPath: '/workspace',
      })
    ).resolves.toBe(true);

    expect(capturedPorts).toHaveLength(1);
    expect(capturedPorts[0]?.teamsBasePath).toBe('/safe-test/teams');
    expect(service.configFacade.readConfigForObservation).toHaveBeenCalledWith('alpha');
    expect(service.membersMetaStore.getMembers).toHaveBeenCalledWith('alpha');
    expect(service.getSecondaryRuntimeRuns).toHaveBeenCalledWith('alpha');
  });
});

function createService(): TeamProvisioningOpenCodeRuntimeRecoveryFacadeServiceHost {
  return {
    runTracking: {
      canDeliverToOpenCodeRuntimeForTeam: vi.fn(() => true),
      canAttemptCommittedOpenCodeSessionRecovery: vi.fn(() => true),
    },
    openCodeStoppedLaneCleanup: {
      cleanupStoppedTeamOpenCodeRuntimeLanesInBackground: vi.fn(),
    },
    launchStateStore: {
      read: vi.fn(async () => null),
    },
    openCodeRuntimeRecoveryBoundary: {
      tryRecoverMissingOpenCodeSecondaryLaneFromRuntime: vi.fn(async () => null),
      tryRecoverActiveOpenCodeSecondaryLaneFromRuntime: vi.fn(async () => null),
    },
    configFacade: {
      readConfigForObservation: vi.fn(async () => ({
        name: 'alpha',
        projectPath: '/workspace',
        members: [{ name: 'Bob', role: 'Builder', providerId: 'opencode' as const }],
      })),
    },
    teamMetaStore: {
      getMeta: vi.fn(async () => ({
        providerId: 'anthropic',
      })),
    },
    membersMetaStore: {
      getMembers: vi.fn(async () => [
        { name: 'Bob', role: 'Builder', providerId: 'opencode' as const },
      ]),
    },
    readPersistedTeamProjectPath: vi.fn(() => '/workspace'),
    getCurrentOpenCodeRuntimeRunId: vi.fn(() => 'runtime-run-1'),
    getSecondaryRuntimeRuns: vi.fn(() => [
      {
        laneId: 'secondary:opencode:bob',
        memberName: 'Bob',
        cwd: '/workspace/.agents/bob',
      },
    ]),
    runtimeAdapterRunByTeam: {
      get: vi.fn(() => ({ providerId: 'anthropic' as const })),
    },
  };
}
