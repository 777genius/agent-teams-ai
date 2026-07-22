import { describe, expect, it, vi } from 'vitest';

import {
  createTeamProvisioningOpenCodeRuntimeLaneRecoveryPortsFromHost,
  type TeamProvisioningOpenCodeRuntimeLaneRecoveryPortsFactoryHost,
} from '../TeamProvisioningOpenCodeRuntimeLaneRecoveryPortsFactory';

import type { OpenCodeRuntimeLaneRecoveryPorts } from '../TeamProvisioningOpenCodeRuntimeRecoveryFlow';

describe('TeamProvisioningOpenCodeRuntimeLaneRecoveryPortsFactory', () => {
  it('forwards every recovery callback through the host with bound receiver objects', async () => {
    const calls: string[] = [];
    const host = createHost(calls);
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
    };
    const ports = createTeamProvisioningOpenCodeRuntimeLaneRecoveryPortsFromHost(host, {
      teamsBasePath: '/custom/teams',
      logger,
    });
    const missingRecoveryInput: Parameters<
      OpenCodeRuntimeLaneRecoveryPorts['tryRecoverMissingOpenCodeSecondaryLaneFromRuntime']
    >[0] = {
      teamName: 'alpha',
      laneId: 'secondary:opencode:bob',
      member: { name: 'Bob', providerId: 'opencode' },
      projectPath: '/workspace',
      previousLaunchState: null,
      persistedMember: {
        name: 'Bob',
        providerId: 'opencode',
        launchState: 'confirmed_alive',
        agentToolAccepted: true,
        runtimeAlive: true,
        bootstrapConfirmed: true,
        hardFailure: false,
        lastEvaluatedAt: '2026-07-03T00:00:00.000Z',
      },
    };
    const activeRecoveryInput: Parameters<
      OpenCodeRuntimeLaneRecoveryPorts['tryRecoverActiveOpenCodeSecondaryLaneFromRuntime']
    >[0] = {
      teamName: 'alpha',
      laneId: 'secondary:opencode:bob',
      member: { name: 'Bob', providerId: 'opencode' },
      projectPath: '/workspace',
      previousLaunchState: null,
    };
    const directory = {
      config: null,
      teamMeta: null,
      metaMembers: [],
    };

    expect(ports.teamsBasePath).toBe('/custom/teams');
    expect(ports.logger).toBe(logger);
    expect(ports.canDeliverToOpenCodeRuntimeForTeam('alpha')).toBe(true);
    expect(ports.canAttemptCommittedOpenCodeSessionRecovery('alpha')).toBe(false);
    ports.cleanupStoppedTeamOpenCodeRuntimeLanesInBackground('alpha');
    await expect(ports.readLaunchState('alpha')).resolves.toBeNull();
    await expect(
      ports.tryRecoverMissingOpenCodeSecondaryLaneFromRuntime(missingRecoveryInput)
    ).resolves.toBeNull();
    await expect(
      ports.tryRecoverActiveOpenCodeSecondaryLaneFromRuntime(activeRecoveryInput)
    ).resolves.toBeNull();
    await expect(ports.readOpenCodeMemberDirectory('alpha')).resolves.toEqual(directory);
    expect(
      ports.resolveOpenCodeMemberIdentityFromDirectory('alpha', 'Bob', directory)
    ).toMatchObject({
      ok: false,
      reason: 'opencode_recipient_unavailable',
    });
    await expect(ports.readConfigForObservation('alpha')).resolves.toBeNull();
    await expect(ports.readTeamMeta('alpha')).resolves.toBeNull();
    await expect(ports.readMetaMembers('alpha')).resolves.toEqual([]);
    expect(ports.readPersistedTeamProjectPath('alpha')).toBe('/workspace');
    await expect(
      ports.isOpenCodeRuntimeLaneIndexActive('alpha', 'secondary:opencode:bob')
    ).resolves.toBe(true);

    expect(calls).toEqual([
      'runTracking.canDeliverToOpenCodeRuntimeForTeam:alpha',
      'runTracking.canAttemptCommittedOpenCodeSessionRecovery:alpha',
      'host.cleanupStoppedTeamOpenCodeRuntimeLanesInBackground:alpha',
      'launchStateStore.read:alpha',
      'recoveryBoundary.tryRecoverMissingOpenCodeSecondaryLaneFromRuntime:secondary:opencode:bob',
      'recoveryBoundary.tryRecoverActiveOpenCodeSecondaryLaneFromRuntime:secondary:opencode:bob',
      'orgConfigCompatibilityFacade.readOpenCodeMemberDirectory:alpha',
      'orgConfigCompatibilityFacade.resolveOpenCodeMemberIdentityFromDirectory:alpha:Bob',
      'host.readConfigForObservation:alpha',
      'teamMetaStore.getMeta:alpha',
      'membersMetaStore.getMembers:alpha',
      'host.readPersistedTeamProjectPath:alpha',
      'recoveryIdentity.isOpenCodeRuntimeLaneIndexActive:alpha:secondary:opencode:bob',
    ]);
  });

  it('uses the default teams base path and TeamProvisioning logger when overrides are omitted', () => {
    const ports = createTeamProvisioningOpenCodeRuntimeLaneRecoveryPortsFromHost(createHost([]));

    expect(ports.teamsBasePath).toMatch(/[/\\]teams$/);
    expect(typeof ports.logger.info).toBe('function');
    expect(typeof ports.logger.warn).toBe('function');
  });
});

function createHost(calls: string[]): TeamProvisioningOpenCodeRuntimeLaneRecoveryPortsFactoryHost {
  const runTracking = {
    calls,
    canDeliverToOpenCodeRuntimeForTeam(this: { calls: string[] }, teamName: string): boolean {
      this.calls.push(`runTracking.canDeliverToOpenCodeRuntimeForTeam:${teamName}`);
      return true;
    },
    canAttemptCommittedOpenCodeSessionRecovery(
      this: { calls: string[] },
      teamName: string
    ): boolean {
      this.calls.push(`runTracking.canAttemptCommittedOpenCodeSessionRecovery:${teamName}`);
      return false;
    },
  };
  const launchStateStore = {
    calls,
    async read(this: { calls: string[] }, teamName: string): Promise<null> {
      this.calls.push(`launchStateStore.read:${teamName}`);
      return null;
    },
  };
  const openCodeRuntimeRecoveryBoundary = {
    calls,
    async tryRecoverMissingOpenCodeSecondaryLaneFromRuntime(
      this: { calls: string[] },
      input: Parameters<
        OpenCodeRuntimeLaneRecoveryPorts['tryRecoverMissingOpenCodeSecondaryLaneFromRuntime']
      >[0]
    ): Promise<null> {
      this.calls.push(
        `recoveryBoundary.tryRecoverMissingOpenCodeSecondaryLaneFromRuntime:${input.laneId}`
      );
      return null;
    },
    async tryRecoverActiveOpenCodeSecondaryLaneFromRuntime(
      this: { calls: string[] },
      input: Parameters<
        OpenCodeRuntimeLaneRecoveryPorts['tryRecoverActiveOpenCodeSecondaryLaneFromRuntime']
      >[0]
    ): Promise<null> {
      this.calls.push(
        `recoveryBoundary.tryRecoverActiveOpenCodeSecondaryLaneFromRuntime:${input.laneId}`
      );
      return null;
    },
  };
  const teamMetaStore = {
    calls,
    async getMeta(this: { calls: string[] }, teamName: string): Promise<null> {
      this.calls.push(`teamMetaStore.getMeta:${teamName}`);
      return null;
    },
  };
  const membersMetaStore = {
    calls,
    async getMembers(this: { calls: string[] }, teamName: string): Promise<[]> {
      this.calls.push(`membersMetaStore.getMembers:${teamName}`);
      return [];
    },
  };
  const openCodeRuntimeRecoveryIdentity = {
    calls,
    async isOpenCodeRuntimeLaneIndexActive(
      this: { calls: string[] },
      teamName: string,
      laneId: string
    ): Promise<boolean> {
      this.calls.push(`recoveryIdentity.isOpenCodeRuntimeLaneIndexActive:${teamName}:${laneId}`);
      return true;
    },
  };

  const host = {
    calls,
    runTracking,
    cleanupStoppedTeamOpenCodeRuntimeLanesInBackground(
      this: { calls: string[] },
      teamName: string
    ): void {
      this.calls.push(`host.cleanupStoppedTeamOpenCodeRuntimeLanesInBackground:${teamName}`);
    },
    launchStateStore,
    openCodeRuntimeRecoveryBoundary,
    orgConfigCompatibilityFacade: {
      calls,
      async readOpenCodeMemberDirectory(this: { calls: string[] }, teamName: string) {
        this.calls.push(`orgConfigCompatibilityFacade.readOpenCodeMemberDirectory:${teamName}`);
        return {
          config: null,
          teamMeta: null,
          metaMembers: [],
        };
      },
      resolveOpenCodeMemberIdentityFromDirectory(
        this: { calls: string[] },
        teamName: string,
        memberName: string
      ) {
        this.calls.push(
          `orgConfigCompatibilityFacade.resolveOpenCodeMemberIdentityFromDirectory:${teamName}:${memberName}`
        );
        return {
          ok: false as const,
          reason: 'opencode_recipient_unavailable' as const,
        };
      },
    },
    async readOpenCodeMemberDirectory(this: { calls: string[] }, teamName: string) {
      this.calls.push(`orgConfigCompatibilityFacade.readOpenCodeMemberDirectory:${teamName}`);
      return {
        config: null,
        teamMeta: null,
        metaMembers: [],
      };
    },
    resolveOpenCodeMemberIdentityFromDirectory(
      this: { calls: string[] },
      teamName: string,
      memberName: string
    ) {
      this.calls.push(
        `orgConfigCompatibilityFacade.resolveOpenCodeMemberIdentityFromDirectory:${teamName}:${memberName}`
      );
      return {
        ok: false as const,
        reason: 'opencode_recipient_unavailable' as const,
      };
    },
    async readConfigForObservation(this: { calls: string[] }, teamName: string) {
      this.calls.push(`host.readConfigForObservation:${teamName}`);
      return null;
    },
    teamMetaStore,
    membersMetaStore,
    readPersistedTeamProjectPath(this: { calls: string[] }, teamName: string): string {
      this.calls.push(`host.readPersistedTeamProjectPath:${teamName}`);
      return '/workspace';
    },
    openCodeRuntimeRecoveryIdentity,
  };
  return host;
}
