import type { TeamProvisioningMemberLifecycleHostFactoryPortGroups } from './TeamProvisioningMemberLifecycleHostFactory';
import type { ProvisioningRun } from './TeamProvisioningRunModel';
import type { MixedSecondaryRuntimeLaneState } from './TeamProvisioningSecondaryRuntimeRuns';
import type { InboxMessage } from '@shared/types';

export type TeamProvisioningServiceMemberLifecycleHostPortGroups =
  TeamProvisioningMemberLifecycleHostFactoryPortGroups<
    ProvisioningRun,
    MixedSecondaryRuntimeLaneState
  >;

type MemberMcpLaunchConfigPorts =
  TeamProvisioningServiceMemberLifecycleHostPortGroups['memberMcpLaunchConfig'];
type OpenCodeRuntimePorts = TeamProvisioningServiceMemberLifecycleHostPortGroups['openCodeRuntime'];
type MixedSecondaryRuntimePorts =
  TeamProvisioningServiceMemberLifecycleHostPortGroups['mixedSecondaryRuntime'];
type FailedOpenCodeSecondaryRetryInFlightByTeam =
  TeamProvisioningServiceMemberLifecycleHostPortGroups['sharedState']['failedOpenCodeSecondaryRetryInFlightByTeam'];
type ResolveOpenCodeMemberWorkspacesForRuntime =
  OpenCodeRuntimePorts['resolveOpenCodeMemberWorkspacesForRuntime'];
type CreateMixedSecondaryLaneStateForMember =
  MixedSecondaryRuntimePorts['createMixedSecondaryLaneStateForMember'];
type StopSingleMixedSecondaryRuntimeLane =
  MixedSecondaryRuntimePorts['stopSingleMixedSecondaryRuntimeLane'];
type ServiceMemberLifecycleUseCases =
  TeamProvisioningServiceMemberLifecycleHostPortGroups['useCases'];

export interface TeamProvisioningServiceMemberLifecycleHostPortGroupPorts {
  runs: unknown;
  runtimeAdapterRunByTeam: unknown;
  failedOpenCodeSecondaryRetryInFlightByTeam: unknown;
  mcpConfigBuilder: {
    writeConfigFile(
      projectPath: Parameters<
        TeamProvisioningServiceMemberLifecycleHostPortGroups['stores']['mcpConfigBuilder']['writeConfigFile']
      >[0],
      options: never
    ): ReturnType<
      TeamProvisioningServiceMemberLifecycleHostPortGroups['stores']['mcpConfigBuilder']['writeConfigFile']
    >;
  };
  membersMetaStore: TeamProvisioningServiceMemberLifecycleHostPortGroups['stores']['membersMetaStore'];
  teamMetaStore: {
    getMeta(teamName: string): Promise<unknown>;
  };
  readConfigForStrictDecision: TeamProvisioningServiceMemberLifecycleHostPortGroups['stores']['readConfigForStrictDecision'];
  readPersistedRuntimeMembers: TeamProvisioningServiceMemberLifecycleHostPortGroups['stores']['readPersistedRuntimeMembers'];
  readPersistedTeamProjectPath: TeamProvisioningServiceMemberLifecycleHostPortGroups['stores']['readPersistedTeamProjectPath'];
  materializeEffectiveTeamMemberSpecs(
    input: never
  ): ReturnType<
    TeamProvisioningServiceMemberLifecycleHostPortGroups['memberSpec']['materializeEffectiveTeamMemberSpecs']
  >;
  buildProvisioningEnv: TeamProvisioningServiceMemberLifecycleHostPortGroups['runtimeLaunch']['buildProvisioningEnv'];
  resolveDirectMemberLaunchIdentity(
    input: never
  ): ReturnType<
    TeamProvisioningServiceMemberLifecycleHostPortGroups['runtimeLaunch']['resolveDirectMemberLaunchIdentity']
  >;
  buildTeamRuntimeLaunchArgsPlan: TeamProvisioningServiceMemberLifecycleHostPortGroups['runtimeLaunch']['buildTeamRuntimeLaunchArgsPlan'];
  sendMessageToRun: TeamProvisioningServiceMemberLifecycleHostPortGroups['runtimeLaunch']['sendMessageToRun'];
  memberMcpLaunchConfigProvisioner: MemberMcpLaunchConfigPorts['memberMcpLaunchConfigProvisioner'];
  launchStateStore: TeamProvisioningServiceMemberLifecycleHostPortGroups['launchState']['launchStateStore'];
  persistLaunchStateSnapshot: TeamProvisioningServiceMemberLifecycleHostPortGroups['launchState']['persistLaunchStateSnapshot'];
  writeLaunchStateSnapshot: TeamProvisioningServiceMemberLifecycleHostPortGroups['launchState']['writeLaunchStateSnapshot'];
  runTracking: TeamProvisioningServiceMemberLifecycleHostPortGroups['runTracking'];
  getRunTrackedCwd: TeamProvisioningServiceMemberLifecycleHostPortGroups['runState']['getRunTrackedCwd'];
  appendMemberBootstrapDiagnostic: TeamProvisioningServiceMemberLifecycleHostPortGroups['runState']['appendMemberBootstrapDiagnostic'];
  setMemberSpawnStatus: TeamProvisioningServiceMemberLifecycleHostPortGroups['runState']['setMemberSpawnStatus'];
  upsertRunAllEffectiveMember: TeamProvisioningServiceMemberLifecycleHostPortGroups['runState']['upsertRunAllEffectiveMember'];
  removeRunAllEffectiveMember: TeamProvisioningServiceMemberLifecycleHostPortGroups['runState']['removeRunAllEffectiveMember'];
  invalidateRuntimeSnapshotCaches: TeamProvisioningServiceMemberLifecycleHostPortGroups['runState']['invalidateRuntimeSnapshotCaches'];
  resetRuntimeToolActivity: TeamProvisioningServiceMemberLifecycleHostPortGroups['runState']['resetRuntimeToolActivity'];
  clearMemberSpawnToolTracking: TeamProvisioningServiceMemberLifecycleHostPortGroups['runState']['clearMemberSpawnToolTracking'];
  isCurrentTrackedRun: TeamProvisioningServiceMemberLifecycleHostPortGroups['runState']['isCurrentTrackedRun'];
  getLiveTeamAgentRuntimeMetadata: TeamProvisioningServiceMemberLifecycleHostPortGroups['runState']['getLiveTeamAgentRuntimeMetadata'];
  persistInboxMessage(teamName: string, memberName: string, message: InboxMessage): void;
  persistSentMessage(teamName: string, message: InboxMessage): void;
  getOpenCodeRuntimeAdapter: TeamProvisioningServiceMemberLifecycleHostPortGroups['openCodeRuntime']['getOpenCodeRuntimeAdapter'];
  resolveOpenCodeMemberWorkspacesForRuntime: ResolveOpenCodeMemberWorkspacesForRuntime;
  runOpenCodeTeamRuntimeAdapterLaunch: OpenCodeRuntimePorts['runOpenCodeTeamRuntimeAdapterLaunch'];
  createMixedSecondaryLaneStateForMember: CreateMixedSecondaryLaneStateForMember;
  stopSingleMixedSecondaryRuntimeLane: StopSingleMixedSecondaryRuntimeLane;
  getRunLeadName: MixedSecondaryRuntimePorts['getRunLeadName'];
  launchSingleMixedSecondaryLane: MixedSecondaryRuntimePorts['launchSingleMixedSecondaryLane'];
  getMixedSecondaryLaunchPhase: MixedSecondaryRuntimePorts['getMixedSecondaryLaunchPhase'];
  memberLifecycleUseCases: ServiceMemberLifecycleUseCases;
}

export function createTeamProvisioningServiceMemberLifecycleHostPortGroups(
  service: TeamProvisioningServiceMemberLifecycleHostPortGroupPorts
): TeamProvisioningServiceMemberLifecycleHostPortGroups {
  return {
    sharedState: {
      runs: service.runs as TeamProvisioningServiceMemberLifecycleHostPortGroups['sharedState']['runs'],
      runtimeAdapterRunByTeam:
        service.runtimeAdapterRunByTeam as TeamProvisioningServiceMemberLifecycleHostPortGroups['sharedState']['runtimeAdapterRunByTeam'],
      failedOpenCodeSecondaryRetryInFlightByTeam:
        service.failedOpenCodeSecondaryRetryInFlightByTeam as FailedOpenCodeSecondaryRetryInFlightByTeam,
    },
    stores: {
      mcpConfigBuilder: {
        writeConfigFile: (projectPath, options) =>
          service.mcpConfigBuilder.writeConfigFile(projectPath, options as never),
      },
      membersMetaStore: {
        getMembers: (teamName) => service.membersMetaStore.getMembers(teamName),
      },
      teamMetaStore: {
        getMeta: (teamName) =>
          service.teamMetaStore.getMeta(teamName) as ReturnType<
            TeamProvisioningServiceMemberLifecycleHostPortGroups['stores']['teamMetaStore']['getMeta']
          >,
      },
      readConfigForStrictDecision: (teamName) => service.readConfigForStrictDecision(teamName),
      readPersistedRuntimeMembers: (teamName) => service.readPersistedRuntimeMembers(teamName),
      readPersistedTeamProjectPath: (teamName) => service.readPersistedTeamProjectPath(teamName),
    },
    memberSpec: {
      materializeEffectiveTeamMemberSpecs: (input) =>
        service.materializeEffectiveTeamMemberSpecs(input as never),
    },
    runtimeLaunch: {
      buildProvisioningEnv: (providerId, providerBackendId, options) =>
        service.buildProvisioningEnv(providerId, providerBackendId, options),
      resolveDirectMemberLaunchIdentity: (input) =>
        service.resolveDirectMemberLaunchIdentity(input as never),
      buildTeamRuntimeLaunchArgsPlan: (input) => service.buildTeamRuntimeLaunchArgsPlan(input),
      sendMessageToRun: (run, message) => service.sendMessageToRun(run, message),
    },
    memberMcpLaunchConfig: {
      memberMcpLaunchConfigProvisioner: {
        buildTrackedMemberMcpLaunchConfig: (input) =>
          service.memberMcpLaunchConfigProvisioner.buildTrackedMemberMcpLaunchConfig(input),
        removeTrackedMemberMcpLaunchConfig: (run, config) =>
          service.memberMcpLaunchConfigProvisioner.removeTrackedMemberMcpLaunchConfig(run, config),
      },
    },
    launchState: {
      launchStateStore: {
        read: (teamName) => service.launchStateStore.read(teamName),
      },
      persistLaunchStateSnapshot: (run, phase) => service.persistLaunchStateSnapshot(run, phase),
      writeLaunchStateSnapshot: (teamName, snapshot) =>
        service.writeLaunchStateSnapshot(teamName, snapshot),
    },
    runTracking: {
      getAliveRunId: (teamName) => service.runTracking.getAliveRunId(teamName),
      getTrackedRunId: (teamName) => service.runTracking.getTrackedRunId(teamName),
      getProvisioningRunId: (teamName) => service.runTracking.getProvisioningRunId(teamName),
    },
    runState: {
      getRunTrackedCwd: (run) => service.getRunTrackedCwd(run),
      appendMemberBootstrapDiagnostic: (run, memberName, text) =>
        service.appendMemberBootstrapDiagnostic(run, memberName, text),
      setMemberSpawnStatus: (run, memberName, status, error, livenessSource, heartbeatAt) =>
        service.setMemberSpawnStatus(run, memberName, status, error, livenessSource, heartbeatAt),
      upsertRunAllEffectiveMember: (run, member) =>
        service.upsertRunAllEffectiveMember(run, member),
      removeRunAllEffectiveMember: (run, memberName) =>
        service.removeRunAllEffectiveMember(run, memberName),
      invalidateRuntimeSnapshotCaches: (teamName) =>
        service.invalidateRuntimeSnapshotCaches(teamName),
      resetRuntimeToolActivity: (run, memberName) =>
        service.resetRuntimeToolActivity(run, memberName),
      clearMemberSpawnToolTracking: (run, memberName) =>
        service.clearMemberSpawnToolTracking(run, memberName),
      isCurrentTrackedRun: (run) => service.isCurrentTrackedRun(run),
      getLiveTeamAgentRuntimeMetadata: (teamName) =>
        service.getLiveTeamAgentRuntimeMetadata(teamName),
    },
    messaging: {
      persistInboxMessage: (teamName, memberName, message) =>
        service.persistInboxMessage(teamName, memberName, message as unknown as InboxMessage),
      persistSentMessage: (teamName, message) =>
        service.persistSentMessage(teamName, message as unknown as InboxMessage),
    },
    openCodeRuntime: {
      getOpenCodeRuntimeAdapter: () => service.getOpenCodeRuntimeAdapter(),
      resolveOpenCodeMemberWorkspacesForRuntime: (input) =>
        service.resolveOpenCodeMemberWorkspacesForRuntime(input),
      runOpenCodeTeamRuntimeAdapterLaunch: (input) =>
        service.runOpenCodeTeamRuntimeAdapterLaunch(input),
    },
    mixedSecondaryRuntime: {
      createMixedSecondaryLaneStateForMember: (run, member) =>
        service.createMixedSecondaryLaneStateForMember(run, member),
      stopSingleMixedSecondaryRuntimeLane: (run, lane, reason) =>
        service.stopSingleMixedSecondaryRuntimeLane(run, lane, reason),
      getRunLeadName: (run) => service.getRunLeadName(run),
      launchSingleMixedSecondaryLane: (run, lane) =>
        service.launchSingleMixedSecondaryLane(run, lane),
      getMixedSecondaryLaunchPhase: (run) => service.getMixedSecondaryLaunchPhase(run),
    },
    useCases: {
      persistOpenCodeMemberRestartSystemMessage:
        service.memberLifecycleUseCases.persistOpenCodeMemberRestartSystemMessage,
      launchDirectProcessMemberRestart:
        service.memberLifecycleUseCases.launchDirectProcessMemberRestart,
      appendDirectProcessRuntimeEvent:
        service.memberLifecycleUseCases.appendDirectProcessRuntimeEvent,
      stopPrimaryOwnedRosterRuntime: service.memberLifecycleUseCases.stopPrimaryOwnedRosterRuntime,
      preparePrimaryOwnedMemberRestartRuntime:
        service.memberLifecycleUseCases.preparePrimaryOwnedMemberRestartRuntime,
    },
    openCodeRetryUseCases: {},
  };
}
