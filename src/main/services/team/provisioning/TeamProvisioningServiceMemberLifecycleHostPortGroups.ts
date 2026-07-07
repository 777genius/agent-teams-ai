import type { TeamProvisioningMemberLifecycleHostFactoryPortGroups } from './TeamProvisioningMemberLifecycleHostFactory';
import type { ProvisioningRun } from './TeamProvisioningRunModel';
import type { MixedSecondaryRuntimeLaneState } from './TeamProvisioningSecondaryRuntimeRuns';
import type { InboxMessage } from '@shared/types';

export type TeamProvisioningServiceMemberLifecycleHostPortGroups =
  TeamProvisioningMemberLifecycleHostFactoryPortGroups<
    ProvisioningRun,
    MixedSecondaryRuntimeLaneState
  >;

type PortGroups = TeamProvisioningServiceMemberLifecycleHostPortGroups;
type MemberMcpLaunchConfigPorts = PortGroups['memberMcpLaunchConfig'];
type OpenCodeRuntimePorts = PortGroups['openCodeRuntime'];
type MixedSecondaryRuntimePorts = PortGroups['mixedSecondaryRuntime'];
type FailedOpenCodeSecondaryRetryInFlightByTeam =
  PortGroups['sharedState']['failedOpenCodeSecondaryRetryInFlightByTeam'];
type ResolveOpenCodeMemberWorkspacesForRuntime =
  OpenCodeRuntimePorts['resolveOpenCodeMemberWorkspacesForRuntime'];
type CreateMixedSecondaryLaneStateForMember =
  MixedSecondaryRuntimePorts['createMixedSecondaryLaneStateForMember'];
type StopSingleMixedSecondaryRuntimeLane =
  MixedSecondaryRuntimePorts['stopSingleMixedSecondaryRuntimeLane'];
type ServiceMemberLifecycleUseCases = PortGroups['useCases'];

export interface TeamProvisioningServiceMemberLifecycleHostPortGroupPorts {
  runs: unknown;
  runtimeAdapterRunByTeam: unknown;
  failedOpenCodeSecondaryRetryInFlightByTeam: unknown;
  mcpConfigBuilder: {
    writeConfigFile(
      projectPath: Parameters<PortGroups['stores']['mcpConfigBuilder']['writeConfigFile']>[0],
      options: never
    ): ReturnType<PortGroups['stores']['mcpConfigBuilder']['writeConfigFile']>;
  };
  membersMetaStore: PortGroups['stores']['membersMetaStore'];
  teamMetaStore: {
    getMeta(teamName: string): Promise<unknown>;
  };
  readConfigForStrictDecision: PortGroups['stores']['readConfigForStrictDecision'];
  readPersistedRuntimeMembers: PortGroups['stores']['readPersistedRuntimeMembers'];
  readPersistedTeamProjectPath: PortGroups['stores']['readPersistedTeamProjectPath'];
  materializeEffectiveTeamMemberSpecs(
    input: never
  ): ReturnType<PortGroups['memberSpec']['materializeEffectiveTeamMemberSpecs']>;
  buildProvisioningEnv: PortGroups['runtimeLaunch']['buildProvisioningEnv'];
  resolveDirectMemberLaunchIdentity(
    input: never
  ): ReturnType<PortGroups['runtimeLaunch']['resolveDirectMemberLaunchIdentity']>;
  buildTeamRuntimeLaunchArgsPlan: PortGroups['runtimeLaunch']['buildTeamRuntimeLaunchArgsPlan'];
  sendMessageToRun: PortGroups['runtimeLaunch']['sendMessageToRun'];
  memberMcpLaunchConfigProvisioner: MemberMcpLaunchConfigPorts['memberMcpLaunchConfigProvisioner'];
  launchStateStore: PortGroups['launchState']['launchStateStore'];
  persistLaunchStateSnapshot: PortGroups['launchState']['persistLaunchStateSnapshot'];
  writeLaunchStateSnapshot: PortGroups['launchState']['writeLaunchStateSnapshot'];
  runTracking: PortGroups['runTracking'];
  getRunTrackedCwd: PortGroups['runState']['getRunTrackedCwd'];
  appendMemberBootstrapDiagnostic: PortGroups['runState']['appendMemberBootstrapDiagnostic'];
  setMemberSpawnStatus: PortGroups['runState']['setMemberSpawnStatus'];
  upsertRunAllEffectiveMember: PortGroups['runState']['upsertRunAllEffectiveMember'];
  removeRunAllEffectiveMember: PortGroups['runState']['removeRunAllEffectiveMember'];
  invalidateRuntimeSnapshotCaches: PortGroups['runState']['invalidateRuntimeSnapshotCaches'];
  resetRuntimeToolActivity: PortGroups['runState']['resetRuntimeToolActivity'];
  clearMemberSpawnToolTracking: PortGroups['runState']['clearMemberSpawnToolTracking'];
  isCurrentTrackedRun: PortGroups['runState']['isCurrentTrackedRun'];
  getLiveTeamAgentRuntimeMetadata: PortGroups['runState']['getLiveTeamAgentRuntimeMetadata'];
  persistInboxMessage(teamName: string, memberName: string, message: InboxMessage): void;
  persistSentMessage(teamName: string, message: InboxMessage): void;
  getOpenCodeRuntimeAdapter: PortGroups['openCodeRuntime']['getOpenCodeRuntimeAdapter'];
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
      runs: service.runs as PortGroups['sharedState']['runs'],
      runtimeAdapterRunByTeam:
        service.runtimeAdapterRunByTeam as PortGroups['sharedState']['runtimeAdapterRunByTeam'],
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
            PortGroups['stores']['teamMetaStore']['getMeta']
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
