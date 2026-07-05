import {
  buildConfiguredProvisioningMember,
  buildPrimaryOwnedMemberSpecForRuntime,
} from './TeamProvisioningConfiguredMemberSpecs';
import {
  resolveEffectiveConfiguredMember,
  resolveLeadMemberName,
} from './TeamProvisioningMemberStatusProjection';

import type { TeamProvisioningMemberLifecycleHost } from './TeamProvisioningMemberLifecycle';
import type { TeamCreateRequest } from '@shared/types';

type HostRun = NonNullable<Parameters<TeamProvisioningMemberLifecycleHost['getRunTrackedCwd']>[0]>;
type HostMixedSecondaryLane = Parameters<
  TeamProvisioningMemberLifecycleHost['stopSingleMixedSecondaryRuntimeLane']
>[1];

type WithServiceRun<TInput, TRun> = Omit<TInput, 'run'> & { run: TRun };

export interface TeamProvisioningMemberLifecycleHostFactoryRun {
  request: Pick<
    TeamCreateRequest,
    'providerId' | 'providerBackendId' | 'model' | 'effort' | 'fastMode'
  >;
}

type HostSetMemberSpawnStatusRest =
  Parameters<TeamProvisioningMemberLifecycleHost['setMemberSpawnStatus']> extends [
    HostRun,
    ...infer TRest,
  ]
    ? TRest
    : never;

export interface TeamProvisioningMemberLifecycleHostFactorySharedStatePorts {
  runs: TeamProvisioningMemberLifecycleHost['runs'];
  runtimeAdapterRunByTeam: TeamProvisioningMemberLifecycleHost['runtimeAdapterRunByTeam'];
  failedOpenCodeSecondaryRetryInFlightByTeam: TeamProvisioningMemberLifecycleHost['failedOpenCodeSecondaryRetryInFlightByTeam'];
  memberLifecycleOperations: TeamProvisioningMemberLifecycleHost['memberLifecycleOperations'];
}

export interface TeamProvisioningMemberLifecycleHostFactoryStorePorts {
  mcpConfigBuilder: TeamProvisioningMemberLifecycleHost['mcpConfigBuilder'];
  membersMetaStore: TeamProvisioningMemberLifecycleHost['membersMetaStore'];
  teamMetaStore: TeamProvisioningMemberLifecycleHost['teamMetaStore'];
  readConfigForStrictDecision: TeamProvisioningMemberLifecycleHost['readConfigForStrictDecision'];
  readPersistedRuntimeMembers: TeamProvisioningMemberLifecycleHost['readPersistedRuntimeMembers'];
  readPersistedTeamProjectPath: TeamProvisioningMemberLifecycleHost['readPersistedTeamProjectPath'];
}

export interface TeamProvisioningMemberLifecycleHostFactoryMemberSpecPorts {
  materializeEffectiveTeamMemberSpecs: TeamProvisioningMemberLifecycleHost['materializeEffectiveTeamMemberSpecs'];
}

export interface TeamProvisioningMemberLifecycleHostFactoryRuntimeLaunchPorts<
  TRun extends TeamProvisioningMemberLifecycleHostFactoryRun,
> {
  buildProvisioningEnv: TeamProvisioningMemberLifecycleHost['buildProvisioningEnv'];
  resolveDirectMemberLaunchIdentity(
    input: WithServiceRun<
      Parameters<TeamProvisioningMemberLifecycleHost['resolveDirectMemberLaunchIdentity']>[0],
      TRun
    >
  ): ReturnType<TeamProvisioningMemberLifecycleHost['resolveDirectMemberLaunchIdentity']>;
  buildTeamRuntimeLaunchArgsPlan: TeamProvisioningMemberLifecycleHost['buildTeamRuntimeLaunchArgsPlan'];
  updateDirectTmuxRestartMemberConfig?: NonNullable<
    TeamProvisioningMemberLifecycleHost['updateDirectTmuxRestartMemberConfig']
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
  sendMessageToRun(
    run: TRun,
    message: string
  ): ReturnType<TeamProvisioningMemberLifecycleHost['sendMessageToRun']>;
}

export interface TeamProvisioningMemberLifecycleHostFactoryLaunchStatePorts<
  TRun extends TeamProvisioningMemberLifecycleHostFactoryRun,
> {
  launchStateStore: TeamProvisioningMemberLifecycleHost['launchStateStore'];
  persistLaunchStateSnapshot(
    run: TRun,
    phase: Parameters<TeamProvisioningMemberLifecycleHost['persistLaunchStateSnapshot']>[1]
  ): ReturnType<TeamProvisioningMemberLifecycleHost['persistLaunchStateSnapshot']>;
  writeLaunchStateSnapshot: TeamProvisioningMemberLifecycleHost['writeLaunchStateSnapshot'];
}

export interface TeamProvisioningMemberLifecycleHostFactoryRunStatePorts<
  TRun extends TeamProvisioningMemberLifecycleHostFactoryRun,
> {
  runTracking: Pick<
    TeamProvisioningMemberLifecycleHost,
    'getAliveRunId' | 'getTrackedRunId' | 'getProvisioningRunId'
  >;
  getRunTrackedCwd(
    run: TRun | null | undefined
  ): ReturnType<TeamProvisioningMemberLifecycleHost['getRunTrackedCwd']>;
  appendMemberBootstrapDiagnostic(
    run: TRun,
    memberName: string,
    text: string
  ): ReturnType<TeamProvisioningMemberLifecycleHost['appendMemberBootstrapDiagnostic']>;
  setMemberSpawnStatus(
    run: TRun,
    ...args: HostSetMemberSpawnStatusRest
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
  getLiveTeamAgentRuntimeMetadata: TeamProvisioningMemberLifecycleHost['getLiveTeamAgentRuntimeMetadata'];
}

export interface TeamProvisioningMemberLifecycleHostFactoryMessagingPorts {
  persistInboxMessage: TeamProvisioningMemberLifecycleHost['persistInboxMessage'];
  persistSentMessage: TeamProvisioningMemberLifecycleHost['persistSentMessage'];
  enqueueDirectRestartPrompt?: NonNullable<
    TeamProvisioningMemberLifecycleHost['enqueueDirectRestartPrompt']
  >;
}

export interface TeamProvisioningMemberLifecycleHostFactoryOpenCodeRuntimePorts {
  getOpenCodeRuntimeAdapter: TeamProvisioningMemberLifecycleHost['getOpenCodeRuntimeAdapter'];
  resolveOpenCodeMemberWorkspacesForRuntime: TeamProvisioningMemberLifecycleHost['resolveOpenCodeMemberWorkspacesForRuntime'];
  runOpenCodeTeamRuntimeAdapterLaunch: TeamProvisioningMemberLifecycleHost['runOpenCodeTeamRuntimeAdapterLaunch'];
}

export interface TeamProvisioningMemberLifecycleHostFactoryMixedSecondaryRuntimePorts<
  TRun extends TeamProvisioningMemberLifecycleHostFactoryRun,
  TMixedSecondaryLane,
> {
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
}

export interface TeamProvisioningMemberLifecycleHostFactoryService<
  TRun extends TeamProvisioningMemberLifecycleHostFactoryRun,
  TMixedSecondaryLane,
>
  extends
    TeamProvisioningMemberLifecycleHostFactorySharedStatePorts,
    TeamProvisioningMemberLifecycleHostFactoryStorePorts,
    TeamProvisioningMemberLifecycleHostFactoryMemberSpecPorts,
    TeamProvisioningMemberLifecycleHostFactoryRuntimeLaunchPorts<TRun>,
    TeamProvisioningMemberLifecycleHostFactoryLaunchStatePorts<TRun>,
    TeamProvisioningMemberLifecycleHostFactoryRunStatePorts<TRun>,
    TeamProvisioningMemberLifecycleHostFactoryMessagingPorts,
    TeamProvisioningMemberLifecycleHostFactoryOpenCodeRuntimePorts,
    TeamProvisioningMemberLifecycleHostFactoryMixedSecondaryRuntimePorts<
      TRun,
      TMixedSecondaryLane
    > {}

export interface TeamProvisioningMemberLifecycleHostFactoryPortGroups<
  TRun extends TeamProvisioningMemberLifecycleHostFactoryRun,
  TMixedSecondaryLane,
> {
  sharedState: TeamProvisioningMemberLifecycleHostFactorySharedStatePorts;
  stores: TeamProvisioningMemberLifecycleHostFactoryStorePorts;
  memberSpec: TeamProvisioningMemberLifecycleHostFactoryMemberSpecPorts;
  runtimeLaunch: TeamProvisioningMemberLifecycleHostFactoryRuntimeLaunchPorts<TRun>;
  launchState: TeamProvisioningMemberLifecycleHostFactoryLaunchStatePorts<TRun>;
  runState: TeamProvisioningMemberLifecycleHostFactoryRunStatePorts<TRun>;
  messaging: TeamProvisioningMemberLifecycleHostFactoryMessagingPorts;
  openCodeRuntime: TeamProvisioningMemberLifecycleHostFactoryOpenCodeRuntimePorts;
  mixedSecondaryRuntime: TeamProvisioningMemberLifecycleHostFactoryMixedSecondaryRuntimePorts<
    TRun,
    TMixedSecondaryLane
  >;
}

export const TEAM_PROVISIONING_MEMBER_LIFECYCLE_HOST_FACTORY_PORT_KEYS = {
  sharedState: [
    'runs',
    'runtimeAdapterRunByTeam',
    'failedOpenCodeSecondaryRetryInFlightByTeam',
    'memberLifecycleOperations',
  ],
  stores: [
    'mcpConfigBuilder',
    'membersMetaStore',
    'teamMetaStore',
    'readConfigForStrictDecision',
    'readPersistedRuntimeMembers',
    'readPersistedTeamProjectPath',
  ],
  memberSpec: [
    'buildPrimaryOwnedMemberSpecForRuntime',
    'materializeEffectiveTeamMemberSpecs',
    'resolveEffectiveConfiguredMember',
    'resolveLeadMemberName',
    'buildConfiguredProvisioningMember',
  ],
  runtimeLaunch: [
    'buildProvisioningEnv',
    'resolveDirectMemberLaunchIdentity',
    'buildTeamRuntimeLaunchArgsPlan',
    'updateDirectTmuxRestartMemberConfig',
    'buildTrackedMemberMcpLaunchConfig',
    'removeTrackedMemberMcpLaunchConfig',
    'sendMessageToRun',
  ],
  launchState: ['launchStateStore', 'persistLaunchStateSnapshot', 'writeLaunchStateSnapshot'],
  runState: [
    'getRunTrackedCwd',
    'appendMemberBootstrapDiagnostic',
    'setMemberSpawnStatus',
    'upsertRunAllEffectiveMember',
    'removeRunAllEffectiveMember',
    'invalidateRuntimeSnapshotCaches',
    'resetRuntimeToolActivity',
    'clearMemberSpawnToolTracking',
    'getAliveRunId',
    'getTrackedRunId',
    'getProvisioningRunId',
    'isCurrentTrackedRun',
    'getLiveTeamAgentRuntimeMetadata',
  ],
  messaging: ['persistInboxMessage', 'persistSentMessage', 'enqueueDirectRestartPrompt'],
  openCodeRuntime: [
    'getOpenCodeRuntimeAdapter',
    'resolveOpenCodeMemberWorkspacesForRuntime',
    'runOpenCodeTeamRuntimeAdapterLaunch',
  ],
  mixedSecondaryRuntime: [
    'createMixedSecondaryLaneStateForMember',
    'stopSingleMixedSecondaryRuntimeLane',
    'getRunLeadName',
    'launchSingleMixedSecondaryLane',
    'getMixedSecondaryLaunchPhase',
  ],
} as const satisfies Record<
  keyof TeamProvisioningMemberLifecycleHostFactoryPortGroups<
    TeamProvisioningMemberLifecycleHostFactoryRun,
    unknown
  >,
  readonly (keyof TeamProvisioningMemberLifecycleHost)[]
>;

type TeamProvisioningMemberLifecycleHostFactoryGroupedHostKey =
  (typeof TEAM_PROVISIONING_MEMBER_LIFECYCLE_HOST_FACTORY_PORT_KEYS)[keyof typeof TEAM_PROVISIONING_MEMBER_LIFECYCLE_HOST_FACTORY_PORT_KEYS][number];

export const TEAM_PROVISIONING_MEMBER_LIFECYCLE_HOST_FACTORY_PORT_KEYS_COVER_HOST: Exclude<
  keyof TeamProvisioningMemberLifecycleHost,
  TeamProvisioningMemberLifecycleHostFactoryGroupedHostKey
> extends never
  ? true
  : never = true;

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

export function createTeamProvisioningMemberLifecycleHost<
  TRun extends TeamProvisioningMemberLifecycleHostFactoryRun,
  TMixedSecondaryLane,
>(
  service: TeamProvisioningMemberLifecycleHostFactoryService<TRun, TMixedSecondaryLane>
): TeamProvisioningMemberLifecycleHost {
  return createTeamProvisioningMemberLifecycleHostFromPortGroups(
    createTeamProvisioningMemberLifecycleHostPortGroups(service)
  );
}

export function createTeamProvisioningMemberLifecycleHostPortGroups<
  TRun extends TeamProvisioningMemberLifecycleHostFactoryRun,
  TMixedSecondaryLane,
>(
  service: TeamProvisioningMemberLifecycleHostFactoryService<TRun, TMixedSecondaryLane>
): TeamProvisioningMemberLifecycleHostFactoryPortGroups<TRun, TMixedSecondaryLane> {
  return {
    sharedState: service,
    stores: service,
    memberSpec: service,
    runtimeLaunch: service,
    launchState: service,
    runState: service,
    messaging: service,
    openCodeRuntime: service,
    mixedSecondaryRuntime: service,
  };
}

export function createTeamProvisioningMemberLifecycleHostFromPortGroups<
  TRun extends TeamProvisioningMemberLifecycleHostFactoryRun,
  TMixedSecondaryLane,
>(
  portGroups: TeamProvisioningMemberLifecycleHostFactoryPortGroups<TRun, TMixedSecondaryLane>
): TeamProvisioningMemberLifecycleHost {
  const {
    sharedState,
    stores,
    memberSpec,
    runtimeLaunch,
    launchState,
    runState,
    messaging,
    openCodeRuntime,
    mixedSecondaryRuntime,
  } = portGroups;

  return {
    runs: sharedState.runs,
    runtimeAdapterRunByTeam: sharedState.runtimeAdapterRunByTeam,
    failedOpenCodeSecondaryRetryInFlightByTeam:
      sharedState.failedOpenCodeSecondaryRetryInFlightByTeam,
    memberLifecycleOperations: sharedState.memberLifecycleOperations,
    mcpConfigBuilder: {
      writeConfigFile: (projectPath, options) =>
        stores.mcpConfigBuilder.writeConfigFile(projectPath, options as never),
    },
    membersMetaStore: {
      getMembers: (teamName) => stores.membersMetaStore.getMembers(teamName),
    },
    teamMetaStore: {
      getMeta: (teamName) => stores.teamMetaStore.getMeta(teamName),
    },
    launchStateStore: {
      read: (teamName) => launchState.launchStateStore.read(teamName),
    },
    getRunTrackedCwd: (run) =>
      runState.getRunTrackedCwd(asNullableServiceProvisioningRun<TRun>(run)),
    buildPrimaryOwnedMemberSpecForRuntime: (input) =>
      buildPrimaryOwnedMemberSpecForRuntime({
        configuredMember: input.configuredMember,
        request: asServiceProvisioningRun<TRun>(input.run).request,
      }),
    buildProvisioningEnv: (providerId, providerBackendId, options) =>
      runtimeLaunch.buildProvisioningEnv(providerId, providerBackendId, options),
    materializeEffectiveTeamMemberSpecs: (input) =>
      memberSpec.materializeEffectiveTeamMemberSpecs(input),
    resolveDirectMemberLaunchIdentity: (input) =>
      runtimeLaunch.resolveDirectMemberLaunchIdentity({
        ...input,
        run: asServiceProvisioningRun<TRun>(input.run),
      }),
    buildTeamRuntimeLaunchArgsPlan: (input) => runtimeLaunch.buildTeamRuntimeLaunchArgsPlan(input),
    get updateDirectTmuxRestartMemberConfig() {
      const seam = runtimeLaunch.updateDirectTmuxRestartMemberConfig;
      return seam
        ? (
            input: Parameters<
              NonNullable<
                TeamProvisioningMemberLifecycleHost['updateDirectTmuxRestartMemberConfig']
              >
            >[0]
          ) => seam(input)
        : undefined;
    },
    persistInboxMessage: (teamName, memberName, message) =>
      messaging.persistInboxMessage(teamName, memberName, message),
    persistSentMessage: (teamName, message) => messaging.persistSentMessage(teamName, message),
    get enqueueDirectRestartPrompt() {
      const seam = messaging.enqueueDirectRestartPrompt;
      return seam
        ? (
            input: Parameters<
              NonNullable<TeamProvisioningMemberLifecycleHost['enqueueDirectRestartPrompt']>
            >[0]
          ) => seam(input)
        : undefined;
    },
    appendMemberBootstrapDiagnostic: (run, memberName, text) =>
      runState.appendMemberBootstrapDiagnostic(
        asServiceProvisioningRun<TRun>(run),
        memberName,
        text
      ),
    setMemberSpawnStatus: (run, memberName, status, error, livenessSource, heartbeatAt) =>
      runState.setMemberSpawnStatus(
        asServiceProvisioningRun<TRun>(run),
        memberName,
        status,
        error,
        livenessSource,
        heartbeatAt
      ),
    upsertRunAllEffectiveMember: (run, member) =>
      runState.upsertRunAllEffectiveMember(asServiceProvisioningRun<TRun>(run), member),
    removeRunAllEffectiveMember: (run, memberName) =>
      runState.removeRunAllEffectiveMember(asServiceProvisioningRun<TRun>(run), memberName),
    invalidateRuntimeSnapshotCaches: (teamName) =>
      runState.invalidateRuntimeSnapshotCaches(teamName),
    resetRuntimeToolActivity: (run, memberName) =>
      runState.resetRuntimeToolActivity(asServiceProvisioningRun<TRun>(run), memberName),
    clearMemberSpawnToolTracking: (run, memberName) =>
      runState.clearMemberSpawnToolTracking(asServiceProvisioningRun<TRun>(run), memberName),
    getAliveRunId: (teamName) => runState.runTracking.getAliveRunId(teamName),
    getTrackedRunId: (teamName) => runState.runTracking.getTrackedRunId(teamName),
    getProvisioningRunId: (teamName) => runState.runTracking.getProvisioningRunId(teamName),
    isCurrentTrackedRun: (run) => runState.isCurrentTrackedRun(asServiceProvisioningRun<TRun>(run)),
    readConfigForStrictDecision: (teamName) => stores.readConfigForStrictDecision(teamName),
    resolveEffectiveConfiguredMember: (configMembers, metaMembers, memberName) =>
      resolveEffectiveConfiguredMember(configMembers, metaMembers, memberName),
    resolveLeadMemberName: (configMembers, metaMembers) =>
      resolveLeadMemberName(configMembers, metaMembers),
    getLiveTeamAgentRuntimeMetadata: (teamName) =>
      runState.getLiveTeamAgentRuntimeMetadata(teamName),
    readPersistedRuntimeMembers: (teamName) => stores.readPersistedRuntimeMembers(teamName),
    persistLaunchStateSnapshot: (run, phase) =>
      launchState.persistLaunchStateSnapshot(asServiceProvisioningRun<TRun>(run), phase),
    buildTrackedMemberMcpLaunchConfig: (input) =>
      runtimeLaunch.memberMcpLaunchConfigProvisioner.buildTrackedMemberMcpLaunchConfig({
        ...input,
        run: asServiceProvisioningRun<TRun>(input.run),
      }),
    removeTrackedMemberMcpLaunchConfig: (run, config) =>
      runtimeLaunch.memberMcpLaunchConfigProvisioner.removeTrackedMemberMcpLaunchConfig(
        asServiceProvisioningRun<TRun>(run),
        config
      ),
    sendMessageToRun: (run, message) =>
      runtimeLaunch.sendMessageToRun(asServiceProvisioningRun<TRun>(run), message),
    getOpenCodeRuntimeAdapter: () => openCodeRuntime.getOpenCodeRuntimeAdapter(),
    resolveOpenCodeMemberWorkspacesForRuntime: (input) =>
      openCodeRuntime.resolveOpenCodeMemberWorkspacesForRuntime(input),
    buildConfiguredProvisioningMember,
    runOpenCodeTeamRuntimeAdapterLaunch: (input) =>
      openCodeRuntime.runOpenCodeTeamRuntimeAdapterLaunch(input),
    createMixedSecondaryLaneStateForMember: (run, member) =>
      mixedSecondaryRuntime.createMixedSecondaryLaneStateForMember(
        asServiceProvisioningRun<TRun>(run),
        member
      ) as unknown as HostMixedSecondaryLane,
    stopSingleMixedSecondaryRuntimeLane: (run, lane, reason) =>
      mixedSecondaryRuntime.stopSingleMixedSecondaryRuntimeLane(
        asServiceProvisioningRun<TRun>(run),
        asServiceMixedSecondaryLane<TMixedSecondaryLane>(lane),
        reason
      ),
    getRunLeadName: (run) =>
      mixedSecondaryRuntime.getRunLeadName(asServiceProvisioningRun<TRun>(run)),
    launchSingleMixedSecondaryLane: (run, lane) =>
      mixedSecondaryRuntime.launchSingleMixedSecondaryLane(
        asServiceProvisioningRun<TRun>(run),
        asServiceMixedSecondaryLane<TMixedSecondaryLane>(lane)
      ),
    getMixedSecondaryLaunchPhase: (run) =>
      mixedSecondaryRuntime.getMixedSecondaryLaunchPhase(asServiceProvisioningRun<TRun>(run)),
    writeLaunchStateSnapshot: (teamName, snapshot) =>
      launchState.writeLaunchStateSnapshot(teamName, snapshot),
    readPersistedTeamProjectPath: (teamName) => stores.readPersistedTeamProjectPath(teamName),
  };
}
