import { describe, expect, it } from 'vitest';

import {
  createTeamProvisioningMemberLifecycleHost,
  type TeamProvisioningMemberLifecycleHostFactoryService,
} from '../TeamProvisioningMemberLifecycleHostFactory';

import type { TeamProvisioningMemberLifecycleHost } from '../TeamProvisioningMemberLifecycle';

type Host = TeamProvisioningMemberLifecycleHost;
type HostRun = NonNullable<Parameters<Host['getRunTrackedCwd']>[0]>;
type HostMixedSecondaryLane = Parameters<Host['stopSingleMixedSecondaryRuntimeLane']>[1];
type HostMember = Parameters<Host['createMixedSecondaryLaneStateForMember']>[1];

interface ServiceRun {
  id: string;
  cwd: string;
}

interface ServiceMixedSecondaryLane {
  laneId: string;
}

interface ReceiverBoundService extends TeamProvisioningMemberLifecycleHostFactoryService<
  ServiceRun,
  ServiceMixedSecondaryLane
> {
  events: string[];
  expectedLane: ServiceMixedSecondaryLane;
}

type BuildTrackedMemberMcpLaunchConfigInput = Parameters<
  ReceiverBoundService['memberMcpLaunchConfigProvisioner']['buildTrackedMemberMcpLaunchConfig']
>[0];

function createService(): ReceiverBoundService {
  const serviceRun: ServiceRun = { id: 'run-1', cwd: '/project' };
  const expectedLane: ServiceMixedSecondaryLane = { laneId: 'lane-1' };

  return {
    events: [],
    expectedLane,
    runs: new Map([['team-a', serviceRun as unknown as HostRun]]) as Host['runs'],
    runtimeAdapterRunByTeam: new Map(),
    failedOpenCodeSecondaryRetryInFlightByTeam: new Map(),
    memberLifecycleOperations: new Map(),
    mcpConfigBuilder: {
      async writeConfigFile(projectPath) {
        return `${projectPath}/.mcp.json`;
      },
    },
    membersMetaStore: {
      async getMembers() {
        return [];
      },
    },
    teamMetaStore: {
      async getMeta() {
        return null;
      },
    },
    launchStateStore: {
      async read() {
        return null;
      },
    },
    providerRuntime: {
      async buildProvisioningEnv(
        this: { marker: string },
        providerId: Parameters<Host['buildProvisioningEnv']>[0]
      ) {
        return {
          env: { RECEIVER: this.marker, PROVIDER: providerId },
        } as Awaited<ReturnType<Host['buildProvisioningEnv']>>;
      },
      marker: 'provider-runtime',
    } as ReceiverBoundService['providerRuntime'] & { marker: string },
    runTracking: {
      getAliveRunId(this: { marker: string }, teamName: string) {
        return `${this.marker}:${teamName}:alive`;
      },
      getTrackedRunId(this: { marker: string }, teamName: string) {
        return `${this.marker}:${teamName}:tracked`;
      },
      getProvisioningRunId(this: { marker: string }, teamName: string) {
        return `${this.marker}:${teamName}:provisioning`;
      },
      marker: 'run-tracking',
    } as ReceiverBoundService['runTracking'] & { marker: string },
    memberMcpLaunchConfigProvisioner: {
      async buildTrackedMemberMcpLaunchConfig(
        this: { marker: string; events: string[] },
        input: BuildTrackedMemberMcpLaunchConfigInput
      ) {
        this.events.push(`${this.marker}:build:${input.run.id}`);
        return null;
      },
      async removeTrackedMemberMcpLaunchConfig(
        this: { marker: string; events: string[] },
        run: ServiceRun
      ) {
        this.events.push(`${this.marker}:remove:${run.id}`);
      },
      marker: 'mcp-provisioner',
      events: [],
    } as ReceiverBoundService['memberMcpLaunchConfigProvisioner'] & {
      marker: string;
      events: string[];
    },
    getRunTrackedCwd(this: ReceiverBoundService, run) {
      this.events.push(`service:get-cwd:${run?.id ?? 'none'}`);
      return run?.cwd ?? null;
    },
    buildPrimaryOwnedMemberSpecForRuntime(this: ReceiverBoundService, input) {
      this.events.push(`service:build-primary:${input.run.id}`);
      return input.configuredMember as ReturnType<Host['buildPrimaryOwnedMemberSpecForRuntime']>;
    },
    async materializeEffectiveTeamMemberSpecs(input) {
      return input.members;
    },
    async resolveDirectMemberLaunchIdentity(this: ReceiverBoundService, input) {
      this.events.push(`service:resolve-identity:${input.run.id}`);
      return null;
    },
    async buildTeamRuntimeLaunchArgsPlan() {
      return {} as Awaited<ReturnType<Host['buildTeamRuntimeLaunchArgsPlan']>>;
    },
    persistInboxMessage(this: ReceiverBoundService, teamName, memberName) {
      this.events.push(`service:persist-inbox:${teamName}:${memberName}`);
    },
    persistSentMessage(this: ReceiverBoundService, teamName) {
      this.events.push(`service:persist-sent:${teamName}`);
    },
    appendMemberBootstrapDiagnostic(this: ReceiverBoundService, run, memberName) {
      this.events.push(`service:diagnostic:${run.id}:${memberName}`);
    },
    setMemberSpawnStatus(this: ReceiverBoundService, run, memberName, status) {
      this.events.push(`service:spawn-status:${run.id}:${memberName}:${status}`);
    },
    upsertRunAllEffectiveMember(this: ReceiverBoundService, run) {
      this.events.push(`service:upsert:${run.id}`);
    },
    removeRunAllEffectiveMember(this: ReceiverBoundService, run, memberName) {
      this.events.push(`service:remove:${run.id}:${memberName}`);
    },
    invalidateRuntimeSnapshotCaches(this: ReceiverBoundService, teamName) {
      this.events.push(`service:invalidate:${teamName}`);
    },
    resetRuntimeToolActivity(this: ReceiverBoundService, run, memberName) {
      this.events.push(`service:reset-tool:${run.id}:${memberName ?? 'all'}`);
    },
    clearMemberSpawnToolTracking(this: ReceiverBoundService, run, memberName) {
      this.events.push(`service:clear-tool:${run.id}:${memberName}`);
    },
    isCurrentTrackedRun(this: ReceiverBoundService, run) {
      this.events.push(`service:is-current:${run.id}`);
      return true;
    },
    async readConfigForStrictDecision() {
      return null;
    },
    resolveEffectiveConfiguredMember() {
      return null;
    },
    resolveLeadMemberName() {
      return 'Lead';
    },
    async getLiveTeamAgentRuntimeMetadata() {
      return new Map();
    },
    readPersistedRuntimeMembers() {
      return [];
    },
    async persistLaunchStateSnapshot(this: ReceiverBoundService, run) {
      this.events.push(`service:persist-launch:${run.id}`);
      return null;
    },
    async sendMessageToRun(this: ReceiverBoundService, run, message) {
      this.events.push(`service:send:${run.id}:${message}`);
      return null;
    },
    getOpenCodeRuntimeAdapter() {
      return null;
    },
    async resolveOpenCodeMemberWorkspacesForRuntime(input) {
      return input.members;
    },
    buildConfiguredProvisioningMember(member) {
      return member as ReturnType<Host['buildConfiguredProvisioningMember']>;
    },
    async runOpenCodeTeamRuntimeAdapterLaunch() {
      return null;
    },
    createMixedSecondaryLaneStateForMember(this: ReceiverBoundService, run) {
      this.events.push(`service:create-lane:${run.id}`);
      return this.expectedLane;
    },
    async stopSingleMixedSecondaryRuntimeLane(this: ReceiverBoundService, run, lane, reason) {
      this.events.push(`service:stop-lane:${run.id}:${lane.laneId}:${reason}`);
    },
    getRunLeadName(this: ReceiverBoundService, run) {
      this.events.push(`service:get-lead:${run.id}`);
      return 'Lead';
    },
    async launchSingleMixedSecondaryLane(this: ReceiverBoundService, run, lane) {
      this.events.push(`service:launch-lane:${run.id}:${lane.laneId}`);
    },
    getMixedSecondaryLaunchPhase(this: ReceiverBoundService, run) {
      this.events.push(`service:phase:${run.id}`);
      return 'members_spawning' as ReturnType<Host['getMixedSecondaryLaunchPhase']>;
    },
    async writeLaunchStateSnapshot() {
      return null;
    },
    readPersistedTeamProjectPath() {
      return '/project';
    },
  };
}

describe('TeamProvisioningMemberLifecycleHostFactory', () => {
  it('keeps shared lifecycle state references on the created host', () => {
    const service = createService();

    const host = createTeamProvisioningMemberLifecycleHost(service);

    expect(host.runs).toBe(service.runs);
    expect(host.runtimeAdapterRunByTeam).toBe(service.runtimeAdapterRunByTeam);
    expect(host.failedOpenCodeSecondaryRetryInFlightByTeam).toBe(
      service.failedOpenCodeSecondaryRetryInFlightByTeam
    );
    expect(host.memberLifecycleOperations).toBe(service.memberLifecycleOperations);
  });

  it('forwards callbacks through the service receivers with run and lane casts intact', async () => {
    const service = createService();
    const host = createTeamProvisioningMemberLifecycleHost(service);
    const run = { id: 'run-2', cwd: '/other' } as unknown as HostRun;
    const lane = { laneId: 'lane-2' } as unknown as HostMixedSecondaryLane;
    const member = { name: 'Member' } as HostMember;

    expect(host.getRunTrackedCwd(run)).toBe('/other');
    expect(host.getRunTrackedCwd(null)).toBeNull();
    expect(host.getAliveRunId('team-a')).toBe('run-tracking:team-a:alive');
    await expect(
      host.buildProvisioningEnv('anthropic', undefined, {
        teamRuntimeAuth: {
          teamName: 'team-a',
          authMaterialId: 'auth-1',
          allowAnthropicApiKeyHelper: false,
        },
      })
    ).resolves.toMatchObject({
      env: { RECEIVER: 'provider-runtime', PROVIDER: 'anthropic' },
    });
    await host.buildTrackedMemberMcpLaunchConfig({
      cwd: '/project',
      mcpPolicy: undefined,
      run,
    });
    const createdLane = host.createMixedSecondaryLaneStateForMember(run, member);
    expect(createdLane).toBe(service.expectedLane);
    await host.stopSingleMixedSecondaryRuntimeLane(run, lane, 'relaunch');
    await host.launchSingleMixedSecondaryLane(run, lane);

    expect(service.events).toEqual([
      'service:get-cwd:run-2',
      'service:get-cwd:none',
      'service:create-lane:run-2',
      'service:stop-lane:run-2:lane-2:relaunch',
      'service:launch-lane:run-2:lane-2',
    ]);
    type MemberMcpLaunchConfigProvisionerWithEvents =
      ReceiverBoundService['memberMcpLaunchConfigProvisioner'] & {
        events: string[];
      };
    expect(
      (service.memberMcpLaunchConfigProvisioner as MemberMcpLaunchConfigProvisionerWithEvents)
        .events
    ).toEqual(['mcp-provisioner:build:run-2']);
  });
});
