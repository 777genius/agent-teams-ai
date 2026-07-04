import { describe, expect, it, vi } from 'vitest';

import {
  TeamProvisioningOpenCodeRuntimeLaneRecoveryFacade,
  type TeamProvisioningOpenCodeRuntimeLaneRecoveryFacadeHelpers,
  type TeamProvisioningOpenCodeRuntimeLaneRecoveryFacadeHost,
} from '../TeamProvisioningOpenCodeRuntimeLaneRecoveryFacade';

import type { OpenCodeRuntimeLaneRecoveryPorts } from '../TeamProvisioningOpenCodeRuntimeRecoveryFlow';

type FacadeHelpers = TeamProvisioningOpenCodeRuntimeLaneRecoveryFacadeHelpers;

describe('TeamProvisioningOpenCodeRuntimeLaneRecoveryFacade', () => {
  it('delegates recovery operations through TeamProvisioning lane recovery ports', async () => {
    const capturedPorts: OpenCodeRuntimeLaneRecoveryPorts[] = [];
    const helpers = createHelpers(capturedPorts);
    const host = createHost();
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
    };
    const facade = new TeamProvisioningOpenCodeRuntimeLaneRecoveryFacade(host, {
      getTeamsBasePath: () => '/custom/teams',
      logger,
      helpers,
    });
    const beforeInput = {
      teamName: 'alpha',
      laneId: 'secondary:opencode:bob',
      member: { name: 'Bob', providerId: 'opencode' as const },
      projectPath: '/workspace',
    };
    const committedInput = {
      ...beforeInput,
      previousLaunchState: null,
    };
    const configuredInput = {
      teamName: 'alpha',
      memberName: 'Bob',
    };
    const verifiedInput = {
      ...configuredInput,
      laneId: 'secondary:opencode:bob',
    };
    const watchdogOptions = {
      allowCommittedSessionRecoveryWithoutTeamRuntime: true,
    };

    await expect(facade.tryRecoverOpenCodeRuntimeLaneBeforeDelivery(beforeInput)).resolves.toBe(
      true
    );
    await expect(
      facade.tryRecoverOpenCodeRuntimeLaneFromCommittedSessionBeforeDelivery(committedInput)
    ).resolves.toBe(false);
    await expect(
      facade.tryRecoverOpenCodeRuntimeLaneForConfiguredMemberBeforeDelivery(configuredInput)
    ).resolves.toBe(true);
    await expect(
      facade.tryRecoverOpenCodeRuntimeLaneForConfiguredMemberAndVerifyActive(verifiedInput)
    ).resolves.toBe(true);
    await expect(
      facade.tryRecoverOpenCodeRuntimeLanesForDeliveryWatchdog('alpha', watchdogOptions)
    ).resolves.toEqual(['secondary:opencode:bob']);

    expect(helpers.tryRecoverOpenCodeRuntimeLaneBeforeDelivery).toHaveBeenCalledWith(
      beforeInput,
      expect.objectContaining({ teamsBasePath: '/custom/teams', logger })
    );
    expect(
      helpers.tryRecoverOpenCodeRuntimeLaneFromCommittedSessionBeforeDelivery
    ).toHaveBeenCalledWith(
      committedInput,
      expect.objectContaining({ teamsBasePath: '/custom/teams', logger })
    );
    expect(
      helpers.tryRecoverOpenCodeRuntimeLaneForConfiguredMemberBeforeDelivery
    ).toHaveBeenCalledWith(
      configuredInput,
      expect.objectContaining({ teamsBasePath: '/custom/teams', logger })
    );
    expect(
      helpers.tryRecoverOpenCodeRuntimeLaneForConfiguredMemberAndVerifyActive
    ).toHaveBeenCalledWith(
      verifiedInput,
      expect.objectContaining({ teamsBasePath: '/custom/teams', logger })
    );
    expect(helpers.tryRecoverOpenCodeRuntimeLanesForDeliveryWatchdog).toHaveBeenCalledWith(
      'alpha',
      watchdogOptions,
      expect.objectContaining({ teamsBasePath: '/custom/teams', logger })
    );

    expect(capturedPorts).toHaveLength(5);
    const firstPorts = capturedPorts[0];
    expect(firstPorts).toBeDefined();
    if (!firstPorts) {
      return;
    }
    firstPorts.cleanupStoppedTeamOpenCodeRuntimeLanesInBackground('alpha');
    await expect(firstPorts.readLaunchState('alpha')).resolves.toBeNull();
    expect(firstPorts.readPersistedTeamProjectPath('alpha')).toBe('/workspace');
    await expect(
      firstPorts.isOpenCodeRuntimeLaneIndexActive('alpha', 'secondary:opencode:bob')
    ).resolves.toBe(true);
    expect(host.cleanupStoppedTeamOpenCodeRuntimeLanesInBackground).toHaveBeenCalledWith('alpha');
    expect(host.launchStateStore.read).toHaveBeenCalledWith('alpha');
    expect(host.readPersistedTeamProjectPath).toHaveBeenCalledWith('alpha');
    expect(
      host.openCodeRuntimeRecoveryIdentity.isOpenCodeRuntimeLaneIndexActive
    ).toHaveBeenCalledWith('alpha', 'secondary:opencode:bob');
  });

  it('resolves the teams base path for each helper delegation', async () => {
    const capturedPorts: OpenCodeRuntimeLaneRecoveryPorts[] = [];
    const getTeamsBasePath = vi
      .fn()
      .mockReturnValueOnce('/teams-one')
      .mockReturnValueOnce('/teams-two');
    const recoverBeforeDelivery: FacadeHelpers['tryRecoverOpenCodeRuntimeLaneBeforeDelivery'] =
      async (_input, ports) => {
        capturedPorts.push(ports);
        return true;
      };
    const recoverConfiguredMember: FacadeHelpers['tryRecoverOpenCodeRuntimeLaneForConfiguredMemberBeforeDelivery'] =
      async (_input, ports) => {
        capturedPorts.push(ports);
        return false;
      };
    const facade = new TeamProvisioningOpenCodeRuntimeLaneRecoveryFacade(createHost(), {
      getTeamsBasePath,
      helpers: {
        tryRecoverOpenCodeRuntimeLaneBeforeDelivery: vi.fn(recoverBeforeDelivery),
        tryRecoverOpenCodeRuntimeLaneForConfiguredMemberBeforeDelivery:
          vi.fn(recoverConfiguredMember),
      },
    });

    await facade.tryRecoverOpenCodeRuntimeLaneBeforeDelivery({
      teamName: 'alpha',
      laneId: 'secondary:opencode:bob',
      member: { name: 'Bob', providerId: 'opencode' as const },
      projectPath: null,
    });
    await facade.tryRecoverOpenCodeRuntimeLaneForConfiguredMemberBeforeDelivery({
      teamName: 'alpha',
      memberName: 'Bob',
    });

    expect(getTeamsBasePath).toHaveBeenCalledTimes(2);
    expect(capturedPorts.map((ports) => ports.teamsBasePath)).toEqual(['/teams-one', '/teams-two']);
  });
});

function createHelpers(
  capturedPorts: OpenCodeRuntimeLaneRecoveryPorts[]
): TeamProvisioningOpenCodeRuntimeLaneRecoveryFacadeHelpers {
  const recoverBeforeDelivery: FacadeHelpers['tryRecoverOpenCodeRuntimeLaneBeforeDelivery'] =
    async (_input, ports) => {
      capturedPorts.push(ports);
      return true;
    };
  const recoverCommittedSession: FacadeHelpers['tryRecoverOpenCodeRuntimeLaneFromCommittedSessionBeforeDelivery'] =
    async (_input, ports) => {
      capturedPorts.push(ports);
      return false;
    };
  const recoverConfiguredMember: FacadeHelpers['tryRecoverOpenCodeRuntimeLaneForConfiguredMemberBeforeDelivery'] =
    async (_input, ports) => {
      capturedPorts.push(ports);
      return true;
    };
  const recoverConfiguredMemberAndVerify: FacadeHelpers['tryRecoverOpenCodeRuntimeLaneForConfiguredMemberAndVerifyActive'] =
    async (_input, ports) => {
      capturedPorts.push(ports);
      return true;
    };
  const recoverWatchdogLanes: FacadeHelpers['tryRecoverOpenCodeRuntimeLanesForDeliveryWatchdog'] =
    async (_teamName, _options, ports) => {
      capturedPorts.push(ports);
      return ['secondary:opencode:bob'];
    };

  return {
    tryRecoverOpenCodeRuntimeLaneBeforeDelivery: vi.fn(recoverBeforeDelivery),
    tryRecoverOpenCodeRuntimeLaneFromCommittedSessionBeforeDelivery: vi.fn(recoverCommittedSession),
    tryRecoverOpenCodeRuntimeLaneForConfiguredMemberBeforeDelivery: vi.fn(recoverConfiguredMember),
    tryRecoverOpenCodeRuntimeLaneForConfiguredMemberAndVerifyActive: vi.fn(
      recoverConfiguredMemberAndVerify
    ),
    tryRecoverOpenCodeRuntimeLanesForDeliveryWatchdog: vi.fn(recoverWatchdogLanes),
  };
}

function createHost(): TeamProvisioningOpenCodeRuntimeLaneRecoveryFacadeHost {
  return {
    runTracking: {
      canDeliverToOpenCodeRuntimeForTeam: vi.fn(() => true),
      canAttemptCommittedOpenCodeSessionRecovery: vi.fn(() => true),
    },
    cleanupStoppedTeamOpenCodeRuntimeLanesInBackground: vi.fn(),
    launchStateStore: {
      read: vi.fn(async () => null),
    },
    openCodeRuntimeRecoveryBoundary: {
      tryRecoverMissingOpenCodeSecondaryLaneFromRuntime: vi.fn(async () => null),
      tryRecoverActiveOpenCodeSecondaryLaneFromRuntime: vi.fn(async () => null),
    },
    readOpenCodeMemberDirectory: vi.fn(async () => ({
      config: null,
      teamMeta: null,
      metaMembers: [],
    })),
    resolveOpenCodeMemberIdentityFromDirectory: vi.fn(() => ({
      ok: false as const,
      reason: 'opencode_recipient_unavailable' as const,
    })),
    readConfigForObservation: vi.fn(async () => null),
    teamMetaStore: {
      getMeta: vi.fn(async () => null),
    },
    membersMetaStore: {
      getMembers: vi.fn(async () => []),
    },
    readPersistedTeamProjectPath: vi.fn(() => '/workspace'),
    openCodeRuntimeRecoveryIdentity: {
      isOpenCodeRuntimeLaneIndexActive: vi.fn(async () => true),
    },
  };
}
