import type { TeamProvisioningMemberLifecycleHost } from './TeamProvisioningMemberLifecycle';

type HostRun = NonNullable<Parameters<TeamProvisioningMemberLifecycleHost['getRunTrackedCwd']>[0]>;
type HostMixedSecondaryLane = Parameters<
  TeamProvisioningMemberLifecycleHost['stopSingleMixedSecondaryRuntimeLane']
>[1];

type WithServiceRun<TInput, TRun> = Omit<TInput, 'run'> & { run: TRun };

export interface TeamProvisioningMemberLifecycleHostFactoryService<TRun, TMixedSecondaryLane> {
  runs: TeamProvisioningMemberLifecycleHost['runs'];
  runtimeAdapterRunByTeam: TeamProvisioningMemberLifecycleHost['runtimeAdapterRunByTeam'];
  failedOpenCodeSecondaryRetryInFlightByTeam: TeamProvisioningMemberLifecycleHost['failedOpenCodeSecondaryRetryInFlightByTeam'];
  memberLifecycleOperations: TeamProvisioningMemberLifecycleHost['memberLifecycleOperations'];
  mcpConfigBuilder: TeamProvisioningMemberLifecycleHost['mcpConfigBuilder'];
  membersMetaStore: TeamProvisioningMemberLifecycleHost['membersMetaStore'];
  teamMetaStore: TeamProvisioningMemberLifecycleHost['teamMetaStore'];
  launchStateStore: TeamProvisioningMemberLifecycleHost['launchStateStore'];
  providerRuntime: {
    buildProvisioningEnv: TeamProvisioningMemberLifecycleHost['buildProvisioningEnv'];
  };
  runTracking: Pick<
    TeamProvisioningMemberLifecycleHost,
    'getAliveRunId' | 'getTrackedRunId' | 'getProvisioningRunId'
  >;
  memberMcpLaunchConfigProvisioner: {
    buildTrackedMemberMcpLaunchConfig(
      input: WithServiceRun<
        Parameters<TeamProvisioningMemberLifecycleHost['buildTrackedMemberMcpLaunchConfig']>[0],
        TRun
      >
    ): ReturnType<TeamProvisioningMemberLifecycleHost['buildTrackedMemberMcpLaunchConfig']>;
    removeTrackedMemberMcpLaunchConfig(
      run: TRun,
      config: Parameters<
        TeamProvisioningMemberLifecycleHost['removeTrackedMemberMcpLaunchConfig']
      >[1]
    ): ReturnType<TeamProvisioningMemberLifecycleHost['removeTrackedMemberMcpLaunchConfig']>;
  };
  getRunTrackedCwd(
    run: TRun | null | undefined
  ): ReturnType<TeamProvisioningMemberLifecycleHost['getRunTrackedCwd']>;
  buildPrimaryOwnedMemberSpecForRuntime(
    input: WithServiceRun<
      Parameters<TeamProvisioningMemberLifecycleHost['buildPrimaryOwnedMemberSpecForRuntime']>[0],
      TRun
    >
  ): ReturnType<TeamProvisioningMemberLifecycleHost['buildPrimaryOwnedMemberSpecForRuntime']>;
  materializeEffectiveTeamMemberSpecs: TeamProvisioningMemberLifecycleHost['materializeEffectiveTeamMemberSpecs'];
  resolveDirectMemberLaunchIdentity(
    input: WithServiceRun<
      Parameters<TeamProvisioningMemberLifecycleHost['resolveDirectMemberLaunchIdentity']>[0],
      TRun
    >
  ): ReturnType<TeamProvisioningMemberLifecycleHost['resolveDirectMemberLaunchIdentity']>;
  buildTeamRuntimeLaunchArgsPlan: TeamProvisioningMemberLifecycleHost['buildTeamRuntimeLaunchArgsPlan'];
  persistInboxMessage: TeamProvisioningMemberLifecycleHost['persistInboxMessage'];
  persistSentMessage: TeamProvisioningMemberLifecycleHost['persistSentMessage'];
  appendMemberBootstrapDiagnostic(
    run: TRun,
    memberName: string,
    text: string
  ): ReturnType<TeamProvisioningMemberLifecycleHost['appendMemberBootstrapDiagnostic']>;
  setMemberSpawnStatus(
    run: TRun,
    ...args: Parameters<TeamProvisioningMemberLifecycleHost['setMemberSpawnStatus']> extends [
      HostRun,
      ...infer TRest,
    ]
      ? TRest
      : never
  ): ReturnType<TeamProvisioningMemberLifecycleHost['setMemberSpawnStatus']>;
  upsertRunAllEffectiveMember(
    run: TRun,
    member: Parameters<TeamProvisioningMemberLifecycleHost['upsertRunAllEffectiveMember']>[1]
  ): ReturnType<TeamProvisioningMemberLifecycleHost['upsertRunAllEffectiveMember']>;
  removeRunAllEffectiveMember(
    run: TRun,
    memberName: string
  ): ReturnType<TeamProvisioningMemberLifecycleHost['removeRunAllEffectiveMember']>;
  invalidateRuntimeSnapshotCaches: TeamProvisioningMemberLifecycleHost['invalidateRuntimeSnapshotCaches'];
  resetRuntimeToolActivity(
    run: TRun,
    memberName?: string
  ): ReturnType<TeamProvisioningMemberLifecycleHost['resetRuntimeToolActivity']>;
  clearMemberSpawnToolTracking(
    run: TRun,
    memberName: string
  ): ReturnType<TeamProvisioningMemberLifecycleHost['clearMemberSpawnToolTracking']>;
  isCurrentTrackedRun(
    run: TRun
  ): ReturnType<TeamProvisioningMemberLifecycleHost['isCurrentTrackedRun']>;
  readConfigForStrictDecision: TeamProvisioningMemberLifecycleHost['readConfigForStrictDecision'];
  resolveEffectiveConfiguredMember: TeamProvisioningMemberLifecycleHost['resolveEffectiveConfiguredMember'];
  resolveLeadMemberName: TeamProvisioningMemberLifecycleHost['resolveLeadMemberName'];
  getLiveTeamAgentRuntimeMetadata: TeamProvisioningMemberLifecycleHost['getLiveTeamAgentRuntimeMetadata'];
  readPersistedRuntimeMembers: TeamProvisioningMemberLifecycleHost['readPersistedRuntimeMembers'];
  persistLaunchStateSnapshot(
    run: TRun,
    phase: Parameters<TeamProvisioningMemberLifecycleHost['persistLaunchStateSnapshot']>[1]
  ): ReturnType<TeamProvisioningMemberLifecycleHost['persistLaunchStateSnapshot']>;
  sendMessageToRun(
    run: TRun,
    message: string
  ): ReturnType<TeamProvisioningMemberLifecycleHost['sendMessageToRun']>;
  getOpenCodeRuntimeAdapter: TeamProvisioningMemberLifecycleHost['getOpenCodeRuntimeAdapter'];
  resolveOpenCodeMemberWorkspacesForRuntime: TeamProvisioningMemberLifecycleHost['resolveOpenCodeMemberWorkspacesForRuntime'];
  buildConfiguredProvisioningMember: TeamProvisioningMemberLifecycleHost['buildConfiguredProvisioningMember'];
  runOpenCodeTeamRuntimeAdapterLaunch: TeamProvisioningMemberLifecycleHost['runOpenCodeTeamRuntimeAdapterLaunch'];
  createMixedSecondaryLaneStateForMember(
    run: TRun,
    member: Parameters<
      TeamProvisioningMemberLifecycleHost['createMixedSecondaryLaneStateForMember']
    >[1]
  ): TMixedSecondaryLane;
  stopSingleMixedSecondaryRuntimeLane(
    run: TRun,
    lane: TMixedSecondaryLane,
    reason: Parameters<
      TeamProvisioningMemberLifecycleHost['stopSingleMixedSecondaryRuntimeLane']
    >[2]
  ): ReturnType<TeamProvisioningMemberLifecycleHost['stopSingleMixedSecondaryRuntimeLane']>;
  getRunLeadName(run: TRun): ReturnType<TeamProvisioningMemberLifecycleHost['getRunLeadName']>;
  launchSingleMixedSecondaryLane(
    run: TRun,
    lane: TMixedSecondaryLane
  ): ReturnType<TeamProvisioningMemberLifecycleHost['launchSingleMixedSecondaryLane']>;
  getMixedSecondaryLaunchPhase(
    run: TRun
  ): ReturnType<TeamProvisioningMemberLifecycleHost['getMixedSecondaryLaunchPhase']>;
  writeLaunchStateSnapshot: TeamProvisioningMemberLifecycleHost['writeLaunchStateSnapshot'];
  readPersistedTeamProjectPath: TeamProvisioningMemberLifecycleHost['readPersistedTeamProjectPath'];
}

function asServiceProvisioningRun<TRun>(run: HostRun): TRun {
  return run as unknown as TRun;
}

function asNullableServiceProvisioningRun<TRun>(
  run: HostRun | null | undefined
): TRun | null | undefined {
  return run == null ? run : asServiceProvisioningRun<TRun>(run);
}

function asServiceMixedSecondaryLane<TMixedSecondaryLane>(
  lane: HostMixedSecondaryLane
): TMixedSecondaryLane {
  return lane as unknown as TMixedSecondaryLane;
}

export function createTeamProvisioningMemberLifecycleHost<TRun, TMixedSecondaryLane>(
  service: TeamProvisioningMemberLifecycleHostFactoryService<TRun, TMixedSecondaryLane>
): TeamProvisioningMemberLifecycleHost {
  return {
    runs: service.runs,
    runtimeAdapterRunByTeam: service.runtimeAdapterRunByTeam,
    failedOpenCodeSecondaryRetryInFlightByTeam: service.failedOpenCodeSecondaryRetryInFlightByTeam,
    memberLifecycleOperations: service.memberLifecycleOperations,
    mcpConfigBuilder: {
      writeConfigFile: (projectPath, options) =>
        service.mcpConfigBuilder.writeConfigFile(projectPath, options as never),
    },
    membersMetaStore: {
      getMembers: (teamName) => service.membersMetaStore.getMembers(teamName),
    },
    teamMetaStore: {
      getMeta: (teamName) => service.teamMetaStore.getMeta(teamName),
    },
    launchStateStore: {
      read: (teamName) => service.launchStateStore.read(teamName),
    },
    getRunTrackedCwd: (run) =>
      service.getRunTrackedCwd(asNullableServiceProvisioningRun<TRun>(run)),
    buildPrimaryOwnedMemberSpecForRuntime: (input) =>
      service.buildPrimaryOwnedMemberSpecForRuntime({
        ...input,
        run: asServiceProvisioningRun<TRun>(input.run),
      }),
    buildProvisioningEnv: (providerId, providerBackendId, options) =>
      service.providerRuntime.buildProvisioningEnv(providerId, providerBackendId, options),
    materializeEffectiveTeamMemberSpecs: (input) =>
      service.materializeEffectiveTeamMemberSpecs(input),
    resolveDirectMemberLaunchIdentity: (input) =>
      service.resolveDirectMemberLaunchIdentity({
        ...input,
        run: asServiceProvisioningRun<TRun>(input.run),
      }),
    buildTeamRuntimeLaunchArgsPlan: (input) => service.buildTeamRuntimeLaunchArgsPlan(input),
    persistInboxMessage: (teamName, memberName, message) =>
      service.persistInboxMessage(teamName, memberName, message),
    persistSentMessage: (teamName, message) => service.persistSentMessage(teamName, message),
    appendMemberBootstrapDiagnostic: (run, memberName, text) =>
      service.appendMemberBootstrapDiagnostic(
        asServiceProvisioningRun<TRun>(run),
        memberName,
        text
      ),
    setMemberSpawnStatus: (run, memberName, status, error, livenessSource, heartbeatAt) =>
      service.setMemberSpawnStatus(
        asServiceProvisioningRun<TRun>(run),
        memberName,
        status,
        error,
        livenessSource,
        heartbeatAt
      ),
    upsertRunAllEffectiveMember: (run, member) =>
      service.upsertRunAllEffectiveMember(asServiceProvisioningRun<TRun>(run), member),
    removeRunAllEffectiveMember: (run, memberName) =>
      service.removeRunAllEffectiveMember(asServiceProvisioningRun<TRun>(run), memberName),
    invalidateRuntimeSnapshotCaches: (teamName) =>
      service.invalidateRuntimeSnapshotCaches(teamName),
    resetRuntimeToolActivity: (run, memberName) =>
      service.resetRuntimeToolActivity(asServiceProvisioningRun<TRun>(run), memberName),
    clearMemberSpawnToolTracking: (run, memberName) =>
      service.clearMemberSpawnToolTracking(asServiceProvisioningRun<TRun>(run), memberName),
    getAliveRunId: (teamName) => service.runTracking.getAliveRunId(teamName),
    getTrackedRunId: (teamName) => service.runTracking.getTrackedRunId(teamName),
    getProvisioningRunId: (teamName) => service.runTracking.getProvisioningRunId(teamName),
    isCurrentTrackedRun: (run) => service.isCurrentTrackedRun(asServiceProvisioningRun<TRun>(run)),
    readConfigForStrictDecision: (teamName) => service.readConfigForStrictDecision(teamName),
    resolveEffectiveConfiguredMember: (configMembers, metaMembers, memberName) =>
      service.resolveEffectiveConfiguredMember(configMembers, metaMembers, memberName),
    resolveLeadMemberName: (configMembers, metaMembers) =>
      service.resolveLeadMemberName(configMembers, metaMembers),
    getLiveTeamAgentRuntimeMetadata: (teamName) =>
      service.getLiveTeamAgentRuntimeMetadata(teamName),
    readPersistedRuntimeMembers: (teamName) => service.readPersistedRuntimeMembers(teamName),
    persistLaunchStateSnapshot: (run, phase) =>
      service.persistLaunchStateSnapshot(asServiceProvisioningRun<TRun>(run), phase),
    buildTrackedMemberMcpLaunchConfig: (input) =>
      service.memberMcpLaunchConfigProvisioner.buildTrackedMemberMcpLaunchConfig({
        ...input,
        run: asServiceProvisioningRun<TRun>(input.run),
      }),
    removeTrackedMemberMcpLaunchConfig: (run, config) =>
      service.memberMcpLaunchConfigProvisioner.removeTrackedMemberMcpLaunchConfig(
        asServiceProvisioningRun<TRun>(run),
        config
      ),
    sendMessageToRun: (run, message) =>
      service.sendMessageToRun(asServiceProvisioningRun<TRun>(run), message),
    getOpenCodeRuntimeAdapter: () => service.getOpenCodeRuntimeAdapter(),
    resolveOpenCodeMemberWorkspacesForRuntime: (input) =>
      service.resolveOpenCodeMemberWorkspacesForRuntime(input),
    buildConfiguredProvisioningMember: (member) =>
      service.buildConfiguredProvisioningMember(member),
    runOpenCodeTeamRuntimeAdapterLaunch: (input) =>
      service.runOpenCodeTeamRuntimeAdapterLaunch(input),
    createMixedSecondaryLaneStateForMember: (run, member) =>
      service.createMixedSecondaryLaneStateForMember(
        asServiceProvisioningRun<TRun>(run),
        member
      ) as unknown as HostMixedSecondaryLane,
    stopSingleMixedSecondaryRuntimeLane: (run, lane, reason) =>
      service.stopSingleMixedSecondaryRuntimeLane(
        asServiceProvisioningRun<TRun>(run),
        asServiceMixedSecondaryLane<TMixedSecondaryLane>(lane),
        reason
      ),
    getRunLeadName: (run) => service.getRunLeadName(asServiceProvisioningRun<TRun>(run)),
    launchSingleMixedSecondaryLane: (run, lane) =>
      service.launchSingleMixedSecondaryLane(
        asServiceProvisioningRun<TRun>(run),
        asServiceMixedSecondaryLane<TMixedSecondaryLane>(lane)
      ),
    getMixedSecondaryLaunchPhase: (run) =>
      service.getMixedSecondaryLaunchPhase(asServiceProvisioningRun<TRun>(run)),
    writeLaunchStateSnapshot: (teamName, snapshot) =>
      service.writeLaunchStateSnapshot(teamName, snapshot),
    readPersistedTeamProjectPath: (teamName) => service.readPersistedTeamProjectPath(teamName),
  };
}
