import { describe, expect, it } from 'vitest';

import { TeamProvisioningMemberLifecycleController } from '../TeamProvisioningMemberLifecycle';
import {
  createTeamProvisioningMemberLifecycleHost,
  createTeamProvisioningMemberLifecycleHostFromPortGroups,
  createTeamProvisioningMemberLifecycleHostPortGroups,
  TEAM_PROVISIONING_MEMBER_LIFECYCLE_HOST_FACTORY_PORT_KEYS,
  TEAM_PROVISIONING_MEMBER_LIFECYCLE_HOST_FACTORY_PORT_KEYS_COVER_HOST,
  type TeamProvisioningMemberLifecycleHostFactoryService,
} from '../TeamProvisioningMemberLifecycleHostFactory';
import { type TeamProvisioningMemberLifecycleHost } from '../TeamProvisioningMemberLifecycleHostPorts';
import { type TeamProvisioningMemberLifecycleActionUseCaseSeams } from '../TeamProvisioningMemberLifecycleUseCaseSeams';

type Host = TeamProvisioningMemberLifecycleHost;
type HostRun = NonNullable<Parameters<Host['getRunTrackedCwd']>[0]>;
type HostMixedSecondaryLane = Parameters<Host['stopSingleMixedSecondaryRuntimeLane']>[1];
type HostMember = Parameters<Host['createMixedSecondaryLaneStateForMember']>[1];

interface ServiceRun {
  id: string;
  cwd: string;
  request: {
    providerId: 'codex';
    providerBackendId?: 'codex-native';
    model: 'gpt-5';
    effort: 'high';
    fastMode: 'on';
  };
}

interface ServiceMixedSecondaryLane {
  laneId: string;
}

interface ReceiverBoundService extends TeamProvisioningMemberLifecycleHostFactoryService<
  ServiceRun,
  ServiceMixedSecondaryLane
> {
  events: string[];
  marker: string;
  expectedLane: ServiceMixedSecondaryLane;
}

type BuildTrackedMemberMcpLaunchConfigInput = Parameters<
  ReceiverBoundService['memberMcpLaunchConfigProvisioner']['buildTrackedMemberMcpLaunchConfig']
>[0];

function createService(): ReceiverBoundService {
  const serviceRun: ServiceRun = {
    id: 'run-1',
    cwd: '/project',
    request: {
      providerId: 'codex',
      providerBackendId: 'codex-native',
      model: 'gpt-5',
      effort: 'high',
      fastMode: 'on',
    },
  };
  const expectedLane: ServiceMixedSecondaryLane = { laneId: 'lane-1' };

  return {
    events: [],
    marker: 'provider-runtime',
    expectedLane,
    runs: new Map([['team-a', serviceRun as unknown as HostRun]]),
    runtimeAdapterRunByTeam: new Map(),
    failedOpenCodeSecondaryRetryInFlightByTeam: new Map(),
    mcpConfigBuilder: {
      async writeConfigFile(this: { marker: string }, projectPath) {
        return `${projectPath}/${this.marker}.json`;
      },
      marker: 'mcp-builder',
    } as ReceiverBoundService['mcpConfigBuilder'] & { marker: string },
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
    async readConfigForStrictDecision() {
      return null;
    },
    readPersistedRuntimeMembers() {
      return [];
    },
    readPersistedTeamProjectPath() {
      return '/project';
    },
    async buildProvisioningEnv(
      this: { marker: string },
      providerId: Parameters<Host['buildProvisioningEnv']>[0]
    ) {
      return {
        env: { RECEIVER: this.marker, PROVIDER: providerId },
      } as Awaited<ReturnType<Host['buildProvisioningEnv']>>;
    },
    getAliveRunId(this: ReceiverBoundService, teamName: string) {
      this.events.push(`service:run-tracking:alive:${teamName}`);
      return `service:${teamName}:alive`;
    },
    getTrackedRunId(this: ReceiverBoundService, teamName: string) {
      this.events.push(`service:run-tracking:tracked:${teamName}`);
      return `service:${teamName}:tracked`;
    },
    getProvisioningRunId(this: ReceiverBoundService, teamName: string) {
      this.events.push(`service:run-tracking:provisioning:${teamName}`);
      return `service:${teamName}:provisioning`;
    },
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
    async materializeEffectiveTeamMemberSpecs(this: ReceiverBoundService, input) {
      this.events.push(`service:materialize:${input.cwd}`);
      return input.members;
    },
    async resolveDirectMemberLaunchIdentity(this: ReceiverBoundService, input) {
      this.events.push(`service:resolve-identity:${input.run.id}`);
      return null;
    },
    async buildTeamRuntimeLaunchArgsPlan(this: ReceiverBoundService) {
      this.events.push('service:args-plan');
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
    async getLiveTeamAgentRuntimeMetadata(this: ReceiverBoundService, teamName) {
      this.events.push(`service:metadata:${teamName}`);
      return new Map();
    },
    async persistLaunchStateSnapshot(this: ReceiverBoundService, run) {
      this.events.push(`service:persist-launch:${run.id}`);
      return null;
    },
    async sendMessageToRun(this: ReceiverBoundService, run, message) {
      this.events.push(`service:send:${run.id}:${message}`);
      return null;
    },
    getOpenCodeRuntimeAdapter(this: ReceiverBoundService) {
      this.events.push('service:adapter');
      return null;
    },
    async resolveOpenCodeMemberWorkspacesForRuntime(this: ReceiverBoundService, input) {
      this.events.push(`service:workspaces:${input.teamName}`);
      return input.members;
    },
    async runOpenCodeTeamRuntimeAdapterLaunch(this: ReceiverBoundService) {
      this.events.push('service:opencode-launch');
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
      return 'active';
    },
    async writeLaunchStateSnapshot(this: ReceiverBoundService, teamName) {
      this.events.push(`service:write-launch:${teamName}`);
      return null;
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
  });

  it('projects the service into narrow lifecycle host port groups', () => {
    const service = createService();

    const portGroups = createTeamProvisioningMemberLifecycleHostPortGroups(service);

    expect(portGroups.sharedState).not.toBe(service);
    expect(portGroups.runState).not.toBe(service);
    expect(portGroups.runtimeLaunch).not.toBe(service);
    expect(portGroups.memberMcpLaunchConfig).not.toBe(service);
    expect(portGroups.sharedState.runs).toBe(service.runs);
    expect(portGroups.sharedState.runtimeAdapterRunByTeam).toBe(service.runtimeAdapterRunByTeam);
    expect(portGroups.sharedState.failedOpenCodeSecondaryRetryInFlightByTeam).toBe(
      service.failedOpenCodeSecondaryRetryInFlightByTeam
    );
    expect('getAliveRunId' in portGroups.runState).toBe(false);
    expect('updateDirectTmuxRestartMemberConfig' in portGroups.runtimeLaunch).toBe(false);
    expect('memberMcpLaunchConfigProvisioner' in portGroups.runtimeLaunch).toBe(false);
    expect('sendMessageToRun' in portGroups.memberMcpLaunchConfig).toBe(false);
  });

  it('preserves the service receiver for optional direct restart prompt seams', () => {
    const service = createService();
    service.enqueueDirectRestartPrompt = function (this: ReceiverBoundService, input) {
      this.events.push(`service:enqueue-restart:${input.memberName}`);
    };
    const portGroups = createTeamProvisioningMemberLifecycleHostPortGroups(service);
    const host = createTeamProvisioningMemberLifecycleHostFromPortGroups(portGroups);

    host.enqueueDirectRestartPrompt?.({
      teamName: 'team-a',
      memberName: 'Worker',
      leadName: 'Lead',
      leadSessionId: 'lead-session',
      prompt: 'restart',
    });

    expect(service.events).toEqual(['service:enqueue-restart:Worker']);
  });

  it('groups every lifecycle host member exactly once', () => {
    const service = createService();
    const host = createTeamProvisioningMemberLifecycleHost(service);
    const groupedKeys = Object.values(
      TEAM_PROVISIONING_MEMBER_LIFECYCLE_HOST_FACTORY_PORT_KEYS
    ).flat();

    expect(TEAM_PROVISIONING_MEMBER_LIFECYCLE_HOST_FACTORY_PORT_KEYS_COVER_HOST).toBe(true);
    expect(new Set(groupedKeys).size).toBe(groupedKeys.length);
    expect(Object.keys(host).sort()).toEqual([...groupedKeys].sort());
  });

  it('routes run tracking through its dedicated port group', () => {
    const service = createService();
    const portGroups = createTeamProvisioningMemberLifecycleHostPortGroups(service);
    const runTrackingEvents: string[] = [];
    portGroups.runTracking = {
      getAliveRunId(teamName) {
        runTrackingEvents.push(`run-tracking:alive:${teamName}`);
        return `alive:${teamName}`;
      },
      getTrackedRunId(teamName) {
        runTrackingEvents.push(`run-tracking:tracked:${teamName}`);
        return `tracked:${teamName}`;
      },
      getProvisioningRunId(teamName) {
        runTrackingEvents.push(`run-tracking:provisioning:${teamName}`);
        return `provisioning:${teamName}`;
      },
    };
    const host = createTeamProvisioningMemberLifecycleHostFromPortGroups(portGroups);
    const run = { id: 'run-1', cwd: '/project' } as unknown as HostRun;

    expect(host.getAliveRunId('team-a')).toBe('alive:team-a');
    expect(host.getTrackedRunId('team-a')).toBe('tracked:team-a');
    expect(host.getProvisioningRunId('team-a')).toBe('provisioning:team-a');
    expect(host.getRunTrackedCwd(run)).toBe('/project');

    expect(runTrackingEvents).toEqual([
      'run-tracking:alive:team-a',
      'run-tracking:tracked:team-a',
      'run-tracking:provisioning:team-a',
    ]);
    expect(service.events).toEqual(['service:get-cwd:run-1']);
  });

  it('routes member MCP launch config through its dedicated port group', async () => {
    const service = createService();
    const portGroups = createTeamProvisioningMemberLifecycleHostPortGroups(service);
    const mcpEvents: string[] = [];
    portGroups.memberMcpLaunchConfig = {
      memberMcpLaunchConfigProvisioner: {
        async buildTrackedMemberMcpLaunchConfig(input) {
          mcpEvents.push(`mcp:${input.run.id}:${input.cwd}`);
          return null;
        },
        async removeTrackedMemberMcpLaunchConfig(run) {
          mcpEvents.push(`mcp:remove:${run.id}`);
        },
      },
    };
    const host = createTeamProvisioningMemberLifecycleHostFromPortGroups(portGroups);
    const run = { id: 'run-mcp', cwd: '/project' } as unknown as HostRun;

    await host.buildTrackedMemberMcpLaunchConfig({
      cwd: '/project',
      mcpPolicy: undefined,
      run,
    });
    await host.removeTrackedMemberMcpLaunchConfig(run, null);
    await host.sendMessageToRun(run, 'hello');

    expect(mcpEvents).toEqual(['mcp:run-mcp:/project', 'mcp:remove:run-mcp']);
    expect(service.events).toEqual(['service:send:run-mcp:hello']);
    expect(
      (
        service.memberMcpLaunchConfigProvisioner as ReceiverBoundService['memberMcpLaunchConfigProvisioner'] & {
          events: string[];
        }
      ).events
    ).toEqual([]);
  });

  it('routes OpenCode runtime operations through their dedicated port group', async () => {
    const service = createService();
    const portGroups = createTeamProvisioningMemberLifecycleHostPortGroups(service);
    const openCodeEvents: string[] = [];
    const adapter = { providerId: 'opencode' };
    portGroups.openCodeRuntime = {
      getOpenCodeRuntimeAdapter() {
        openCodeEvents.push('opencode:adapter');
        return adapter;
      },
      async resolveOpenCodeMemberWorkspacesForRuntime(input) {
        openCodeEvents.push(`opencode:workspaces:${input.teamName}:${input.members.length}`);
        return input.members;
      },
      async runOpenCodeTeamRuntimeAdapterLaunch(input) {
        openCodeEvents.push(`opencode:launch:${input.request.teamName}:${input.members.length}`);
        return { ok: true };
      },
    };
    const host = createTeamProvisioningMemberLifecycleHostFromPortGroups(portGroups);
    const run = { id: 'run-opencode', cwd: '/project' } as unknown as HostRun;
    const member = { name: 'OpenCode Worker' } as HostMember;

    expect(host.getOpenCodeRuntimeAdapter()).toBe(adapter);
    await host.resolveOpenCodeMemberWorkspacesForRuntime({
      teamName: 'team-opencode',
      baseCwd: '/project',
      leadProviderId: 'codex',
      members: [member],
    });
    await host.runOpenCodeTeamRuntimeAdapterLaunch({
      request: {
        teamName: 'team-opencode',
        cwd: '/project',
        providerId: 'codex',
        members: [member],
      },
      members: [member],
      prompt: 'prompt',
      onProgress: () => undefined,
    });
    await host.sendMessageToRun(run, 'still-runtime-launch');

    expect(openCodeEvents).toEqual([
      'opencode:adapter',
      'opencode:workspaces:team-opencode:1',
      'opencode:launch:team-opencode:1',
    ]);
    expect(service.events).toEqual(['service:send:run-opencode:still-runtime-launch']);
  });

  it('keeps lifecycle action seams outside the host port surface', async () => {
    const service = createService();
    const host = createTeamProvisioningMemberLifecycleHost(service);
    const operationEvents: string[] = [];
    const seamEvents: string[] = [];
    const retryResult = {
      attempted: ['Worker'],
      confirmed: ['Worker'],
      pending: [],
      failed: [],
      skipped: [],
    };
    const operationUseCases: ConstructorParameters<
      typeof TeamProvisioningMemberLifecycleController
    >[1] = {
      isMemberLifecycleOperationActive: () => false,
      runMemberLifecycleOperation(teamName, memberName, kind, operation) {
        operationEvents.push(`${kind}:${teamName}:${memberName}`);
        return operation();
      },
    };
    const actionUseCases: TeamProvisioningMemberLifecycleActionUseCaseSeams = {
      attachLiveRosterMember(teamName, memberName, options) {
        seamEvents.push(`attach:${teamName}:${memberName}:${options?.reason ?? 'none'}`);
        return Promise.resolve();
      },
      detachLiveRosterMember(teamName, memberName) {
        seamEvents.push(`detach:${teamName}:${memberName}`);
        return Promise.resolve();
      },
      restartMember(teamName, memberName) {
        seamEvents.push(`restart:${teamName}:${memberName}`);
        return Promise.resolve();
      },
      retryFailedOpenCodeSecondaryLanes(teamName) {
        seamEvents.push(`retry:${teamName}`);
        return Promise.resolve(retryResult);
      },
      skipMemberForLaunch(teamName, memberName) {
        seamEvents.push(`skip:${teamName}:${memberName}`);
        return Promise.resolve();
      },
    };
    const controller = new TeamProvisioningMemberLifecycleController(host, operationUseCases, {
      actions: actionUseCases,
    });

    await controller.attachLiveRosterMember('team-a', 'Worker', { reason: 'member_updated' });
    await controller.detachLiveRosterMember('team-a', 'Worker');
    await controller.restartMember('team-a', 'Worker');
    await expect(
      Promise.all([
        controller.retryFailedOpenCodeSecondaryLanes('team-a'),
        controller.retryFailedOpenCodeSecondaryLanes('team-a'),
      ])
    ).resolves.toEqual([retryResult, retryResult]);
    await controller.skipMemberForLaunch('team-a', 'Worker');

    expect(operationEvents).toEqual([
      'primary_member_updated:team-a:Worker',
      'primary_member_removed:team-a:Worker',
      'manual_restart:team-a:Worker',
      'skip_for_launch:team-a:Worker',
    ]);
    expect(seamEvents).toEqual([
      'attach:team-a:Worker:member_updated',
      'detach:team-a:Worker',
      'restart:team-a:Worker',
      'retry:team-a',
      'skip:team-a:Worker',
    ]);
    expect(service.failedOpenCodeSecondaryRetryInFlightByTeam.size).toBe(0);
    expect('launchDirectProcessMemberRestart' in host).toBe(false);
    expect('collectFailedOpenCodeSecondaryRetryCandidates' in host).toBe(false);
    expect('skipMemberForLaunch' in host).toBe(false);
  });

  it('forwards callbacks through the service receivers with run and lane casts intact', async () => {
    const service = createService();
    const portGroups = createTeamProvisioningMemberLifecycleHostPortGroups(service);
    const host = createTeamProvisioningMemberLifecycleHostFromPortGroups(portGroups);
    const run = { id: 'run-2', cwd: '/other' } as unknown as HostRun;
    const lane = { laneId: 'lane-2' } as unknown as HostMixedSecondaryLane;
    const member = { name: 'Member' } as HostMember;

    await expect(host.mcpConfigBuilder.writeConfigFile('/project')).resolves.toBe(
      '/project/mcp-builder.json'
    );
    expect(host.getRunTrackedCwd(run)).toBe('/other');
    expect(host.getRunTrackedCwd(null)).toBeNull();
    expect(host.getAliveRunId('team-a')).toBe('service:team-a:alive');
    expect(host.getTrackedRunId('team-a')).toBe('service:team-a:tracked');
    expect(host.getProvisioningRunId('team-a')).toBe('service:team-a:provisioning');
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
    await host.removeTrackedMemberMcpLaunchConfig(run, null);
    await host.materializeEffectiveTeamMemberSpecs({
      claudePath: '/bin/claude',
      cwd: '/project',
      members: [member],
      defaults: { providerId: 'codex' },
      primaryProviderId: 'codex',
      primaryEnv: { env: {} },
      teamRuntimeAuth: {
        teamName: 'team-a',
        authMaterialId: 'auth-2',
        allowAnthropicApiKeyHelper: false,
      },
    });
    await host.resolveDirectMemberLaunchIdentity({
      claudePath: '/bin/claude',
      cwd: '/project',
      providerId: 'codex',
      provisioningEnv: { env: {} },
      memberSpec: member,
      run,
    });
    await host.buildTeamRuntimeLaunchArgsPlan({
      teamName: 'team-a',
      providerId: 'codex',
      launchIdentity: null,
      envResolution: { env: {} },
      extraArgs: [],
      includeAnthropicHelper: false,
      contextLabel: 'test',
    });
    host.persistInboxMessage('team-a', 'Member', {});
    host.persistSentMessage('team-a', {});
    host.appendMemberBootstrapDiagnostic(run, 'Member', 'diagnostic');
    host.setMemberSpawnStatus(run, 'Member', 'waiting');
    host.upsertRunAllEffectiveMember(run, member);
    host.removeRunAllEffectiveMember(run, 'Member');
    host.invalidateRuntimeSnapshotCaches('team-a');
    host.resetRuntimeToolActivity(run);
    host.clearMemberSpawnToolTracking(run, 'Member');
    expect(host.isCurrentTrackedRun(run)).toBe(true);
    await host.getLiveTeamAgentRuntimeMetadata('team-a');
    await host.persistLaunchStateSnapshot(run, 'active');
    await host.sendMessageToRun(run, 'hello');
    expect(host.getOpenCodeRuntimeAdapter()).toBeNull();
    await host.resolveOpenCodeMemberWorkspacesForRuntime({
      teamName: 'team-a',
      baseCwd: '/project',
      leadProviderId: 'codex',
      members: [member],
    });
    await host.runOpenCodeTeamRuntimeAdapterLaunch({
      request: {
        teamName: 'team-a',
        cwd: '/project',
        providerId: 'codex',
        members: [member],
      },
      members: [member],
      prompt: 'prompt',
      onProgress: () => undefined,
    });
    const createdLane = host.createMixedSecondaryLaneStateForMember(run, member);
    expect(createdLane).toBe(service.expectedLane);
    await host.stopSingleMixedSecondaryRuntimeLane(run, lane, 'relaunch');
    expect(host.getRunLeadName(run)).toBe('Lead');
    await host.launchSingleMixedSecondaryLane(run, lane);
    expect(host.getMixedSecondaryLaunchPhase(run)).toBe('active');
    await host.writeLaunchStateSnapshot(
      'team-a',
      {} as Parameters<Host['writeLaunchStateSnapshot']>[1]
    );

    expect(service.events).toEqual([
      'service:get-cwd:run-2',
      'service:get-cwd:none',
      'service:run-tracking:alive:team-a',
      'service:run-tracking:tracked:team-a',
      'service:run-tracking:provisioning:team-a',
      'service:materialize:/project',
      'service:resolve-identity:run-2',
      'service:args-plan',
      'service:persist-inbox:team-a:Member',
      'service:persist-sent:team-a',
      'service:diagnostic:run-2:Member',
      'service:spawn-status:run-2:Member:waiting',
      'service:upsert:run-2',
      'service:remove:run-2:Member',
      'service:invalidate:team-a',
      'service:reset-tool:run-2:all',
      'service:clear-tool:run-2:Member',
      'service:is-current:run-2',
      'service:metadata:team-a',
      'service:persist-launch:run-2',
      'service:send:run-2:hello',
      'service:adapter',
      'service:workspaces:team-a',
      'service:opencode-launch',
      'service:create-lane:run-2',
      'service:stop-lane:run-2:lane-2:relaunch',
      'service:get-lead:run-2',
      'service:launch-lane:run-2:lane-2',
      'service:phase:run-2',
      'service:write-launch:team-a',
    ]);
    type MemberMcpLaunchConfigProvisionerWithEvents =
      ReceiverBoundService['memberMcpLaunchConfigProvisioner'] & {
        events: string[];
      };
    expect(
      (service.memberMcpLaunchConfigProvisioner as MemberMcpLaunchConfigProvisionerWithEvents)
        .events
    ).toEqual(['mcp-provisioner:build:run-2', 'mcp-provisioner:remove:run-2']);
  });
});
