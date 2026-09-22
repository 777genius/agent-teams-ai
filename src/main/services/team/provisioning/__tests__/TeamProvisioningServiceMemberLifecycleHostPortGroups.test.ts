import { describe, expect, it } from 'vitest';

import {
  createTeamProvisioningServiceMemberLifecycleHostPortGroups,
  type TeamProvisioningServiceMemberLifecycleHostPortGroupPorts,
  type TeamProvisioningServiceMemberLifecycleHostPortGroups,
} from '../TeamProvisioningServiceMemberLifecycleHostPortGroups';

import type { ProvisioningRun } from '../TeamProvisioningRunModel';
import type { MixedSecondaryRuntimeLaneState } from '../TeamProvisioningSecondaryRuntimeRuns';
import type { TeamCreateRequest } from '@shared/types';

type PortGroups = TeamProvisioningServiceMemberLifecycleHostPortGroups;
type MaterializeInput = Parameters<
  PortGroups['memberSpec']['materializeEffectiveTeamMemberSpecs']
>[0];
type ResolveIdentityInput = Parameters<
  PortGroups['runtimeLaunch']['resolveDirectMemberLaunchIdentity']
>[0];

function createRun(member: TeamCreateRequest['members'][number]): ProvisioningRun {
  return {
    runId: 'run-1',
    teamName: 'team-a',
    request: {
      teamName: 'team-a',
      cwd: '/repo',
      members: [member],
      providerId: 'codex',
    },
  } as unknown as ProvisioningRun;
}

function createLane(member: TeamCreateRequest['members'][number]): MixedSecondaryRuntimeLaneState {
  return {
    laneId: 'lane-1',
    providerId: 'opencode',
    member,
    runId: null,
    state: 'queued',
    result: null,
    warnings: [],
    diagnostics: [],
  };
}

function createService(events: string[]): TeamProvisioningServiceMemberLifecycleHostPortGroupPorts {
  const member: TeamCreateRequest['members'][number] = { name: 'Worker' };
  const run = createRun(member);
  const lane = createLane(member);

  return {
    runs: new Map([['run-1', run]]),
    runtimeAdapterRunByTeam: new Map(),
    failedOpenCodeSecondaryRetryInFlightByTeam: new Map(),
    mcpConfigBuilder: {
      async writeConfigFile(projectPath) {
        events.push(`mcp:${projectPath}`);
        return `${projectPath}/mcp.json`;
      },
    },
    membersMetaStore: {
      async getMembers(teamName) {
        events.push(`members:${teamName}`);
        return [];
      },
    },
    teamMetaStore: {
      async getMeta(teamName) {
        events.push(`meta:${teamName}`);
        return { providerId: 'codex' };
      },
    },
    async readConfigForStrictDecision(teamName) {
      events.push(`config:${teamName}`);
      return null;
    },
    readPersistedRuntimeMembers(teamName) {
      events.push(`runtime-members:${teamName}`);
      return [];
    },
    readPersistedTeamProjectPath(teamName) {
      events.push(`project:${teamName}`);
      return '/repo';
    },
    async materializeEffectiveTeamMemberSpecs(input: unknown) {
      const materializeInput = input as MaterializeInput;
      events.push(`materialize:${materializeInput.cwd}`);
      return materializeInput.members;
    },
    async buildProvisioningEnv(providerId) {
      events.push(`env:${providerId}`);
      return { env: { PROVIDER: providerId } };
    },
    async resolveDirectMemberLaunchIdentity(input: unknown) {
      const identityInput = input as ResolveIdentityInput;
      events.push(`identity:${identityInput.run.runId}`);
      return null;
    },
    async buildTeamRuntimeLaunchArgsPlan(input) {
      events.push(`args:${input.teamName}`);
      return {
        settingsArgs: [],
        fastModeArgs: [],
        runtimeTurnSettledHookArgs: [],
        providerArgs: [],
        appManagedSettingsPath: null,
      };
    },
    async sendMessageToRun(targetRun, message) {
      events.push(`send:${targetRun.runId}:${message}`);
      return null;
    },
    memberMcpLaunchConfigProvisioner: {
      async buildTrackedMemberMcpLaunchConfig(input) {
        events.push(`member-mcp:${input.run.runId}:${input.cwd}`);
        return null;
      },
      async removeTrackedMemberMcpLaunchConfig(targetRun) {
        events.push(`member-mcp-remove:${targetRun.runId}`);
      },
    },
    launchStateStore: {
      async read(teamName) {
        events.push(`launch-read:${teamName}`);
        return null;
      },
    },
    async persistLaunchStateSnapshot(targetRun, phase) {
      events.push(`launch-persist:${targetRun.runId}:${phase}`);
      return null;
    },
    async writeLaunchStateSnapshot(teamName) {
      events.push(`launch-write:${teamName}`);
    },
    runTracking: {
      getAliveRunId(teamName) {
        events.push(`alive:${teamName}`);
        return `${teamName}:alive`;
      },
      getTrackedRunId(teamName) {
        events.push(`tracked:${teamName}`);
        return `${teamName}:tracked`;
      },
      getProvisioningRunId(teamName) {
        events.push(`provisioning:${teamName}`);
        return `${teamName}:provisioning`;
      },
    },
    getRunTrackedCwd(targetRun) {
      events.push(`cwd:${targetRun?.runId ?? 'none'}`);
      return targetRun?.request.cwd ?? null;
    },
    appendMemberBootstrapDiagnostic(targetRun, memberName) {
      events.push(`diagnostic:${targetRun.runId}:${memberName}`);
    },
    setMemberSpawnStatus(targetRun, memberName, status) {
      events.push(`spawn:${targetRun.runId}:${memberName}:${status}`);
    },
    upsertRunAllEffectiveMember(targetRun, targetMember) {
      events.push(`upsert:${targetRun.runId}:${targetMember.name}`);
    },
    removeRunAllEffectiveMember(targetRun, memberName) {
      events.push(`remove:${targetRun.runId}:${memberName}`);
    },
    invalidateRuntimeSnapshotCaches(teamName) {
      events.push(`invalidate:${teamName}`);
    },
    resetRuntimeToolActivity(targetRun, memberName) {
      events.push(`tool-reset:${targetRun.runId}:${memberName ?? 'all'}`);
    },
    clearMemberSpawnToolTracking(targetRun, memberName) {
      events.push(`tool-clear:${targetRun.runId}:${memberName}`);
    },
    isCurrentTrackedRun(targetRun) {
      events.push(`current:${targetRun.runId}`);
      return true;
    },
    async getLiveTeamAgentRuntimeMetadata(teamName) {
      events.push(`metadata:${teamName}`);
      return new Map();
    },
    persistInboxMessage(teamName, memberName, message) {
      events.push(`inbox:${teamName}:${memberName}:${message.messageId ?? 'none'}`);
    },
    persistSentMessage(teamName, message) {
      events.push(`sent:${teamName}:${message.messageId ?? 'none'}`);
    },
    getOpenCodeRuntimeAdapter() {
      events.push('adapter');
      return null;
    },
    async resolveOpenCodeMemberWorkspacesForRuntime(input) {
      events.push(`workspaces:${input.teamName}`);
      return input.members;
    },
    async runOpenCodeTeamRuntimeAdapterLaunch(input) {
      events.push(`adapter-launch:${input.request.teamName}`);
      return null;
    },
    createMixedSecondaryLaneStateForMember(targetRun, targetMember) {
      events.push(`lane-create:${targetRun.runId}:${targetMember.name}`);
      return lane;
    },
    async stopSingleMixedSecondaryRuntimeLane(targetRun, targetLane, reason) {
      events.push(`lane-stop:${targetRun.runId}:${targetLane.laneId}:${reason}`);
    },
    getRunLeadName(targetRun) {
      events.push(`lead:${targetRun.runId}`);
      return 'Lead';
    },
    async launchSingleMixedSecondaryLane(targetRun, targetLane) {
      events.push(`lane-launch:${targetRun.runId}:${targetLane.laneId}`);
    },
    getMixedSecondaryLaunchPhase(targetRun) {
      events.push(`phase:${targetRun.runId}`);
      return 'active';
    },
  };
}

describe('TeamProvisioningServiceMemberLifecycleHostPortGroups', () => {
  it('forwards optional direct restart prompt seams through the messaging group', () => {
    const events: string[] = [];
    const service = createService(
      events
    ) as TeamProvisioningServiceMemberLifecycleHostPortGroupPorts & {
      marker: string;
    };
    service.marker = 'service-bound';
    service.enqueueDirectRestartPrompt = function (this: typeof service, input) {
      events.push(`${this.marker}:enqueue:${input.teamName}:${input.memberName}`);
    };
    const portGroups = createTeamProvisioningServiceMemberLifecycleHostPortGroups(service);

    portGroups.messaging.enqueueDirectRestartPrompt?.({
      teamName: 'team-a',
      memberName: 'Worker',
      leadName: 'Lead',
      leadSessionId: null,
      prompt: 'restart',
    });

    expect(events).toEqual(['service-bound:enqueue:team-a:Worker']);
  });

  it('assembles the TeamProvisioningService lifecycle host ports into focused groups', async () => {
    const events: string[] = [];
    const service = createService(events);
    const portGroups = createTeamProvisioningServiceMemberLifecycleHostPortGroups(service);
    const run = (service.runs as Map<string, ProvisioningRun>).get('run-1');
    const member: TeamCreateRequest['members'][number] = { name: 'Worker' };
    const memberMcpLaunchConfig = portGroups.memberMcpLaunchConfig.memberMcpLaunchConfigProvisioner;

    expect(Object.keys(portGroups).sort()).toEqual([
      'launchState',
      'memberMcpLaunchConfig',
      'memberSpec',
      'messaging',
      'mixedSecondaryRuntime',
      'openCodeRuntime',
      'runState',
      'runTracking',
      'runtimeLaunch',
      'sharedState',
      'stores',
    ]);
    expect(portGroups.sharedState.runs).toBe(service.runs);
    expect(portGroups.sharedState.runtimeAdapterRunByTeam).toBe(service.runtimeAdapterRunByTeam);
    expect(portGroups.sharedState.failedOpenCodeSecondaryRetryInFlightByTeam).toBe(
      service.failedOpenCodeSecondaryRetryInFlightByTeam
    );
    expect(run).toBeDefined();

    await portGroups.stores.mcpConfigBuilder.writeConfigFile('/repo');
    await portGroups.stores.membersMetaStore.getMembers('team-a');
    await portGroups.stores.teamMetaStore.getMeta('team-a');
    await portGroups.runtimeLaunch.buildProvisioningEnv('codex', undefined, {
      teamRuntimeAuth: {
        teamName: 'team-a',
        authMaterialId: 'auth-1',
        allowAnthropicApiKeyHelper: false,
      },
    });
    await portGroups.memberSpec.materializeEffectiveTeamMemberSpecs({
      claudePath: '/bin/claude',
      cwd: '/repo',
      members: [member],
      defaults: { providerId: 'codex' },
      primaryProviderId: 'codex',
      primaryEnv: { env: {} },
      teamRuntimeAuth: {
        teamName: 'team-a',
        authMaterialId: 'auth-1',
        allowAnthropicApiKeyHelper: false,
      },
    });
    await portGroups.runtimeLaunch.resolveDirectMemberLaunchIdentity({
      claudePath: '/bin/claude',
      cwd: '/repo',
      providerId: 'codex',
      provisioningEnv: { env: {} },
      memberSpec: member,
      run: run!,
    });
    await memberMcpLaunchConfig.buildTrackedMemberMcpLaunchConfig({
      cwd: '/repo',
      mcpPolicy: undefined,
      run: run!,
    });
    portGroups.messaging.persistInboxMessage('team-a', 'Worker', { messageId: 'm-1' });
    portGroups.messaging.persistSentMessage('team-a', { messageId: 'm-2' });
    expect(portGroups.runTracking.getTrackedRunId('team-a')).toBe('team-a:tracked');
    expect(portGroups.runState.getRunTrackedCwd(run)).toBe('/repo');
    await portGroups.openCodeRuntime.runOpenCodeTeamRuntimeAdapterLaunch({
      request: {
        teamName: 'team-a',
        cwd: '/repo',
        members: [member],
        providerId: 'codex',
      },
      members: [member],
      prompt: 'prompt',
      onProgress: () => undefined,
    });
    expect(
      portGroups.mixedSecondaryRuntime.createMixedSecondaryLaneStateForMember(run!, member)
    ).toMatchObject({ laneId: 'lane-1' });

    expect(events).toEqual([
      'mcp:/repo',
      'members:team-a',
      'meta:team-a',
      'env:codex',
      'materialize:/repo',
      'identity:run-1',
      'member-mcp:run-1:/repo',
      'inbox:team-a:Worker:m-1',
      'sent:team-a:m-2',
      'tracked:team-a',
      'cwd:run-1',
      'adapter-launch:team-a',
      'lane-create:run-1:Worker',
    ]);
  });
});
