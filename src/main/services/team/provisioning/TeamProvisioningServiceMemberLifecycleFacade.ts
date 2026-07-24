import {
  isPureOpenCodeMemberLanePlan,
  type TeamRuntimeLanePlan,
} from '@features/team-runtime-lanes';
import { getClaudeBasePath } from '@main/utils/pathDecoder';
import { createLogger } from '@shared/utils/logger';
import { randomUUID } from 'crypto';

import { cleanupAnthropicTeamApiKeyHelperMaterial } from '../../runtime/anthropicTeamApiKeyHelper';
import { boundLaunchDiagnostics } from '../progressPayload';
import { TeamMembersMetaStore } from '../TeamMembersMetaStore';

import { createStaleAnthropicTeamApiKeyHelperCleanupRetryOwner } from './TeamProvisioningAnthropicApiKeyHelperCleanup';
import {
  createAppendDirectProcessRuntimeEventUseCase,
  createNodeAppendDirectProcessRuntimeEventUseCasePorts,
} from './TeamProvisioningAppendDirectProcessRuntimeEventUseCase';
import { type TeamProvisioningCompatibilityDelegation } from './TeamProvisioningCompatibilityFacade';
import { buildLaunchMembersFromMeta } from './TeamProvisioningConfigMaterialization';
import { type TeamProvisioningCreateDeterministicSpawnFlowBoundary } from './TeamProvisioningCreateDeterministicSpawnFlowPortsFactory';
import { type ProvisioningEnvResolution } from './TeamProvisioningEnvBuilder';
import { type TeamProvisioningIdlePromptInjectionBoundary } from './TeamProvisioningIdlePromptInjectionPortsFactory';
import { type TeamProvisioningLaunchDeterministicFlowBoundary } from './TeamProvisioningLaunchDeterministicFlowPortsFactory';
import {
  type MemberLifecycleOperation,
  TeamProvisioningMemberLifecycleController,
} from './TeamProvisioningMemberLifecycle';
import { type TeamProvisioningMemberLifecyclePublicFacade } from './TeamProvisioningMemberLifecycleCompatibilityFacade';
import { createTeamProvisioningMemberLifecycleHostFromPortGroups } from './TeamProvisioningMemberLifecycleHostFactory';
import { createTeamProvisioningMemberLifecycleOperationRunner } from './TeamProvisioningMemberLifecycleOperationRunner';
import { type TeamProvisioningMemberLifecycleOperationRunner } from './TeamProvisioningMemberLifecycleOperationRunner';
import { createTeamProvisioningMemberLifecycleOperationUseCases } from './TeamProvisioningMemberLifecycleOperationUseCases';
import { createTeamProvisioningMemberLifecycleServiceUseCases } from './TeamProvisioningMemberLifecycleServiceUseCases';
import { type ProvisioningRun as MemberLifecycleProvisioningRun } from './TeamProvisioningMemberLifecycleTypes';
import {
  createTeamProvisioningMixedSecondaryLaneWiring,
  createTeamProvisioningMixedSecondaryLaneWiringDepsFromService,
  type TeamProvisioningMixedSecondaryLaneWiringServiceHost,
} from './TeamProvisioningMixedSecondaryLaneWiring';
import {
  createTeamProvisioningOpenCodeLaunchWiring,
  createTeamProvisioningOpenCodeLaunchWiringHostFromService,
  type TeamProvisioningOpenCodeLaunchWiringServiceHost,
} from './TeamProvisioningOpenCodeLaunchWiring';
import { type TeamProvisioningOpenCodeRuntimeDeliveryBoundaryHost } from './TeamProvisioningOpenCodeRuntimeDeliveryBoundaryFactory';
import { createNodePreparePrimaryOwnedMemberRestartRuntimeUseCase } from './TeamProvisioningPreparePrimaryOwnedMemberRestartRuntimeUseCase';
import { type TeamProvisioningProcessExitPorts } from './TeamProvisioningProcessExit';
import {
  type TeamProvisioningProviderRuntimeCompatibility,
  type TeamProvisioningProviderRuntimeFacade,
} from './TeamProvisioningProviderRuntimeFacade';
import {
  createTeamProvisioningReevaluateMemberLaunchStatusBoundary,
  createTeamProvisioningReevaluateMemberLaunchStatusDepsFromService,
  type TeamProvisioningReevaluateMemberLaunchStatusServiceHost,
} from './TeamProvisioningReevaluateMemberLaunchStatusPortsFactory';
import { type ProvisioningRun } from './TeamProvisioningRunModel';
import { nowIso, updateProgress } from './TeamProvisioningRunProgress';
import { TeamProvisioningRuntimeFailureObservationBoundary } from './TeamProvisioningRuntimeFailureObservationBoundary';
import {
  isOpenCodeSecondaryLaneMemberInRun,
  type MixedSecondaryRuntimeLaneState,
} from './TeamProvisioningSecondaryRuntimeRuns';
import {
  createTeamProvisioningServiceComposition,
  type TeamProvisioningServiceComposition,
} from './TeamProvisioningServiceComposition';
import {
  createTeamProvisioningServiceMemberLifecycleHostPortGroups,
  type TeamProvisioningServiceMemberLifecycleHostPortGroupPorts,
  type TeamProvisioningServiceMemberLifecycleHostPortGroups,
} from './TeamProvisioningServiceMemberLifecycleHostPortGroups';
import { TeamProvisioningServiceRuntimeStateFacade } from './TeamProvisioningServiceRuntimeStateFacade';
import { createNodeStopPrimaryOwnedRosterRuntimeUseCase } from './TeamProvisioningStopPrimaryOwnedRosterRuntimeUseCase';
import { type TeamProvisioningVerificationProbePorts } from './TeamProvisioningVerificationProbePortsFactory';
import { createTeamProvisioningWorkspaceTrustPreSpawnBoundary } from './TeamProvisioningWorkspaceTrustPreSpawnBoundary';

import type { TeamProvisioningOutputRecoveryFacade } from './TeamProvisioningOutputRecoveryFacade';
import type { TeamProvisioningPrepareFacade } from './TeamProvisioningPrepareFacade';
import type { TeamProvisioningToolApprovalFacade } from './TeamProvisioningToolApprovalFacade';
import type { TeamProvisioningTransientRunState } from './TeamProvisioningTransientRunState';
import type {
  InboxMessage,
  TeamChangeEvent,
  TeamCreateRequest,
  TeamLaunchRequest,
  TeamLaunchResponse,
  TeamMember,
  TeamProvisioningProgress,
} from '@shared/types';

const logger = createLogger('Service:TeamProvisioning');

function mergeProvisioningMembersWithRemovalTombstones(
  activeMembers: readonly TeamMember[],
  existingMembers: readonly TeamMember[]
): TeamMember[] {
  const removedMembers = existingMembers.filter((member) => member.removedAt != null);
  const removedNames = new Set(
    removedMembers.map((member) => member.name.trim().toLowerCase()).filter(Boolean)
  );
  return [
    ...activeMembers.filter((member) => !removedNames.has(member.name.trim().toLowerCase())),
    ...removedMembers,
  ];
}

function preserveProvisioningRemovalTombstones(store: TeamMembersMetaStore): TeamMembersMetaStore {
  const getMeta = (store as Partial<TeamMembersMetaStore>).getMeta;
  const getMembers = (store as Partial<TeamMembersMetaStore>).getMembers;
  const rawUpdateMembers = (store as Partial<TeamMembersMetaStore>).updateMembers;
  const rawWriteMembers = (store as Partial<TeamMembersMetaStore>).writeMembers;
  if (typeof rawWriteMembers !== 'function') {
    return store;
  }
  const writeMembers = rawWriteMembers.bind(store);
  const updateMembers =
    typeof rawUpdateMembers === 'function'
      ? rawUpdateMembers.bind(store)
      : !(store instanceof TeamMembersMetaStore)
        ? async (
            teamName: string,
            update: Parameters<TeamMembersMetaStore['updateMembers']>[1],
            options?: { providerBackendId?: string }
          ): Promise<void> => {
            // Legacy unit harnesses use structural test doubles that predate updateMembers.
            // Production TeamMembersMetaStore instances always use the atomic branch above.
            const existingMembers =
              typeof getMembers === 'function'
                ? await getMembers.call(store, teamName)
                : ((await getMeta?.call(store, teamName))?.members ?? []);
            await writeMembers(teamName, await update(existingMembers), options);
          }
        : null;
  if (!updateMembers) {
    return store;
  }

  return new Proxy(store, {
    get(target, property) {
      if (property === 'updateMembers') {
        return updateMembers;
      }
      if (property === 'writeMembers') {
        return async (
          teamName: string,
          members: TeamMember[],
          options?: { providerBackendId?: string }
        ): Promise<void> => {
          await updateMembers(
            teamName,
            (existingMembers) =>
              mergeProvisioningMembersWithRemovalTombstones(members, existingMembers),
            options
          );
        };
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

function preserveAuthoritativeMembersMetaResolution(
  facade: TeamProvisioningServiceComposition['configFacade'],
  store: TeamMembersMetaStore
): void {
  const fallback = facade.resolveLaunchExpectedMembers.bind(facade);
  facade.resolveLaunchExpectedMembers = async (teamName, configRaw, leadProviderId) => {
    try {
      const meta = await store.getMeta(teamName);
      if (meta) {
        return {
          members: buildLaunchMembersFromMeta(meta.members),
          source: 'members-meta',
        };
      }
    } catch {
      // The extracted resolver owns warning and fallback behavior for unreadable metadata.
    }
    return fallback(teamName, configRaw, leadProviderId);
  };
}

/** Owns lifecycle host construction and launch-preparation adaptation. */
export abstract class TeamProvisioningServiceMemberLifecycleFacade extends TeamProvisioningServiceRuntimeStateFacade {
  async runLiveRosterMutation(teamName: string, mutation: () => Promise<void>): Promise<void> {
    await this.executeLiveRosterMutation(teamName, mutation);
  }

  private readonly staleAnthropicApiKeyHelperCleanupRetryOwner =
    createStaleAnthropicTeamApiKeyHelperCleanupRetryOwner({
      baseClaudeDir: getClaudeBasePath(),
      logger,
    });
  protected override getOpenCodeAggregatePrimaryRestartTeamNamesForShutdown(): Iterable<string> {
    return Array.from(
      this.openCodeAggregatePrimaryRestartByTeam.values(),
      (restart) => restart.teamName
    );
  }

  protected override getOpenCodeRuntimeAdapterStopInFlightTeamNamesForShutdown(): Iterable<string> {
    return Array.from(
      this.openCodeRuntimeAdapterStopInFlightByTeam.values(),
      (stop) => stop.teamName
    );
  }

  private readonly preparedOpenCodeRuntimeLaunchMembersByTeam = new Map<
    string,
    TeamCreateRequest['members']
  >();
  private readonly memberLifecycleOperations = new Map<string, MemberLifecycleOperation>();
  private readonly baseMemberLifecycleOperationRunner =
    createTeamProvisioningMemberLifecycleOperationRunner({
      memberLifecycleOperations: this.memberLifecycleOperations,
      invalidateRuntimeSnapshotCaches: (teamName) => this.invalidateRuntimeSnapshotCaches(teamName),
      nowMs: () => Date.now(),
    });
  protected readonly memberLifecycleOperationRunner: TeamProvisioningMemberLifecycleOperationRunner =
    {
      isMemberLifecycleOperationActive: (teamName: string, memberName: string) =>
        this.baseMemberLifecycleOperationRunner.isMemberLifecycleOperationActive(
          teamName,
          memberName
        ),
      runMemberLifecycleOperation: <T>(
        teamName: string,
        memberName: string,
        kind: Parameters<
          typeof this.baseMemberLifecycleOperationRunner.runMemberLifecycleOperation
        >[2],
        operation: () => Promise<T>
      ): Promise<T> =>
        this.baseMemberLifecycleOperationRunner.runMemberLifecycleOperation(
          teamName,
          memberName,
          kind,
          async () => {
            const teamKey = teamName.trim().toLowerCase();
            const operationKey = `${teamKey}\0${memberName.trim().toLowerCase()}`;
            const token = Symbol(`${kind}:${operationKey}`);
            let resolveCompletion!: () => void;
            const completion = new Promise<void>((resolve) => {
              resolveCompletion = resolve;
            });
            this.memberLifecycleCompletionByKey.set(operationKey, {
              teamKey,
              token,
              completion,
            });
            try {
              await this.waitForOpenCodeAggregatePrimaryRestart(teamName, memberName);
              return await operation();
            } finally {
              resolveCompletion();
              // eslint-disable-next-line security/detect-possible-timing-attacks -- Symbol tokens are ownership fences, not secret material.
              if (this.memberLifecycleCompletionByKey.get(operationKey)?.token === token) {
                this.memberLifecycleCompletionByKey.delete(operationKey);
              }
            }
          }
        ),
    };
  protected readonly memberLifecycleUseCases = Object.assign(
    createTeamProvisioningMemberLifecycleServiceUseCases({
      persistSentMessage: (teamName, message) =>
        this.persistSentMessage(teamName, message as unknown as InboxMessage),
      readLaunchStateSnapshot: (teamName) => this.launchStateStore.read(teamName),
      getLiveTeamAgentRuntimeMetadata: (teamName) => this.getLiveTeamAgentRuntimeMetadata(teamName),
      appendDirectProcessRuntimeEvent: createAppendDirectProcessRuntimeEventUseCase(
        createNodeAppendDirectProcessRuntimeEventUseCasePorts({ nowIso })
      ),
      stopPrimaryOwnedRosterRuntime: createNodeStopPrimaryOwnedRosterRuntimeUseCase(),
      preparePrimaryOwnedMemberRestartRuntime:
        createNodePreparePrimaryOwnedMemberRestartRuntimeUseCase(),
      nowIso,
      randomUUID,
    }),
    {
      collectFailedOpenCodeSecondaryRetryCandidates: (run: MemberLifecycleProvisioningRun) =>
        this.collectFailedOpenCodeSecondaryRetryCandidates(run),
    }
  );
  protected readonly memberLifecycleOperationUseCases =
    createTeamProvisioningMemberLifecycleOperationUseCases({
      operationRunner: this.memberLifecycleOperationRunner,
    });
  protected readonly memberLifecycleHost = Object.assign(
    createTeamProvisioningMemberLifecycleHostFromPortGroups<
      ProvisioningRun,
      MixedSecondaryRuntimeLaneState
    >(this.createMemberLifecycleHostPortGroups()),
    {
      stopOpenCodeRuntimeAdapterTeam: (teamName: string, runId: string) =>
        this.stopOpenCodeRuntimeAdapterTeam(teamName, runId),
      setAliveRunId: (teamName: string, runId: string) =>
        this.runTracking.setAliveRunId(teamName, runId),
      deleteAliveRunId: (teamName: string) => this.runTracking.deleteAliveRunId(teamName),
      isTeamAlive: (teamName: string) => this.isTeamAlive(teamName),
      setRuntimeAdapterProgress: (
        progress: TeamProvisioningProgress,
        onProgress: (progress: TeamProvisioningProgress) => void
      ) => this.runtimeAdapterProgressState.setRuntimeAdapterProgress(progress, onProgress),
    }
  );
  protected readonly memberLifecycleController = new TeamProvisioningMemberLifecycleController(
    this.memberLifecycleHost,
    this.memberLifecycleOperationUseCases,
    {
      restart: this.memberLifecycleUseCases,
      openCodeRetry: this.memberLifecycleUseCases,
    }
  );
  protected readonly memberLifecycleFacade: TeamProvisioningMemberLifecyclePublicFacade =
    this.memberLifecycleController;
  protected teamChangeEmitter: ((event: TeamChangeEvent) => void) | null = null;
  protected readonly runtimeFailureObservationBoundary =
    new TeamProvisioningRuntimeFailureObservationBoundary();
  protected readonly helpOutputCache = { output: null as string | null, cachedAtMs: 0 };
  protected readonly pendingTimeouts = new Map<string, NodeJS.Timeout>();
  protected readonly toolApprovalFacade!: TeamProvisioningToolApprovalFacade<ProvisioningRun>;
  protected readonly transientRunState!: TeamProvisioningTransientRunState;
  protected readonly idlePromptInjectionBoundary!: TeamProvisioningIdlePromptInjectionBoundary<ProvisioningRun>;
  protected readonly providerRuntime!: TeamProvisioningProviderRuntimeFacade;
  private readonly providerRuntimeCompatibility!: TeamProvisioningProviderRuntimeCompatibility;
  protected readonly compatibilityDelegation!: TeamProvisioningCompatibilityDelegation<ProvisioningRun>;
  protected readonly outputRecoveryFacade!: TeamProvisioningOutputRecoveryFacade<ProvisioningRun>;
  protected readonly deterministicCreateSpawnFlowBoundary!: TeamProvisioningCreateDeterministicSpawnFlowBoundary<ProvisioningRun>;
  private readonly deterministicLaunchFlowBoundary!: TeamProvisioningLaunchDeterministicFlowBoundary<MixedSecondaryRuntimeLaneState>;
  protected readonly prepareFacade!: TeamProvisioningPrepareFacade;
  protected readonly verificationProbePorts!: TeamProvisioningVerificationProbePorts<ProvisioningRun>;
  protected readonly processExitPorts!: TeamProvisioningProcessExitPorts<ProvisioningRun>;
  private readonly workspaceTrustPreSpawnBoundary =
    createTeamProvisioningWorkspaceTrustPreSpawnBoundary<
      ProvisioningRun,
      ProvisioningEnvResolution
    >({
      getWorkspaceTrustCoordinator: () => this.appShellBoundary.getWorkspaceTrustCoordinator(),
      getStopAllTeamsGeneration: () => this.stopAllTeamsGeneration,
      updateProgress,
      boundLaunchDiagnostics,
      isLaunchRunStillCurrent: (run) => this.isLaunchRunStillCurrent(run),
      isRunStillTracked: (run) => this.runs.get(run.runId) === run,
      cleanupAnthropicApiKeyHelperMaterial: cleanupAnthropicTeamApiKeyHelperMaterial,
      restorePrelaunchConfig: (teamName) => this.restorePrelaunchConfig(teamName),
      cleanupRun: (run) => this.cleanupRun(run),
      logger,
    });
  protected readonly reevaluateMemberLaunchStatusBoundary =
    createTeamProvisioningReevaluateMemberLaunchStatusBoundary<ProvisioningRun>(
      createTeamProvisioningReevaluateMemberLaunchStatusDepsFromService(
        this as unknown as TeamProvisioningReevaluateMemberLaunchStatusServiceHost<ProvisioningRun>,
        {
          nowIso,
          nowMs: () => Date.now(),
          isOpenCodeSecondaryLaneMemberInRun,
        }
      )
    );
  protected readonly mixedSecondaryLaneWiring =
    createTeamProvisioningMixedSecondaryLaneWiring<ProvisioningRun>(
      createTeamProvisioningMixedSecondaryLaneWiringDepsFromService(
        this as unknown as TeamProvisioningMixedSecondaryLaneWiringServiceHost<ProvisioningRun>,
        { logger }
      )
    );
  protected readonly openCodeLaunchWiring =
    createTeamProvisioningOpenCodeLaunchWiring<ProvisioningRun>(
      createTeamProvisioningOpenCodeLaunchWiringHostFromService(
        this as unknown as TeamProvisioningOpenCodeLaunchWiringServiceHost<ProvisioningRun>
      )
    );
  protected readonly requestAdmissionBoundary!: TeamProvisioningServiceComposition['requestAdmissionBoundary'];
  protected readonly openCodeRuntimeDeliveryBoundaryHost!: TeamProvisioningOpenCodeRuntimeDeliveryBoundaryHost<ProvisioningRun>;
  protected readonly openCodeRuntimeControlApi!: TeamProvisioningServiceComposition['openCodeRuntimeControlApi'];

  protected abstract waitForOpenCodeAggregatePrimaryRestart(
    teamName: string,
    currentMemberName?: string
  ): Promise<string | null>;

  protected abstract collectFailedOpenCodeSecondaryRetryCandidates(
    run: MemberLifecycleProvisioningRun
  ): ReturnType<
    TeamProvisioningMemberLifecycleController['collectFailedOpenCodeSecondaryRetryCandidatesInternal']
  >;

  protected initializeTeamProvisioningService(): void {
    const service = this as unknown as { membersMetaStore: TeamMembersMetaStore };
    const membersMetaStore = preserveProvisioningRemovalTombstones(service.membersMetaStore);
    service.membersMetaStore = membersMetaStore;
    createTeamProvisioningServiceComposition(this);
    preserveAuthoritativeMembersMetaResolution(this.configFacade, membersMetaStore);
    this.preserveAtomicOpenCodeRuntimePreparation();
    this.staleAnthropicApiKeyHelperCleanupRetryOwner.start();
  }

  private createMemberLifecycleHostPortGroups(): TeamProvisioningServiceMemberLifecycleHostPortGroups {
    return createTeamProvisioningServiceMemberLifecycleHostPortGroups(
      this as unknown as TeamProvisioningServiceMemberLifecycleHostPortGroupPorts
    );
  }

  private preserveAtomicOpenCodeRuntimePreparation(): void {
    const prepareOpenCodeRuntimeAdapterLaunch =
      this.prepareFacade.prepareOpenCodeRuntimeAdapterLaunch.bind(this.prepareFacade);
    this.prepareFacade.prepareOpenCodeRuntimeAdapterLaunch = async (params) => {
      const prepared = await prepareOpenCodeRuntimeAdapterLaunch(params);
      const lanePlan = this.planRuntimeLanesOrThrow(
        prepared.launchRequest.providerId,
        prepared.runtimeLaunchMembers,
        prepared.launchRequest.cwd
      );
      const teamKey = prepared.launchRequest.teamName.trim().toLowerCase();
      if (isPureOpenCodeMemberLanePlan(lanePlan)) {
        this.preparedOpenCodeRuntimeLaunchMembersByTeam.set(teamKey, prepared.runtimeLaunchMembers);
      } else {
        this.preparedOpenCodeRuntimeLaunchMembersByTeam.delete(teamKey);
      }
      return { ...prepared, lanePlan };
    };
  }

  protected override async runOpenCodeWorktreeRootAggregateLaunch(input: {
    request: TeamCreateRequest | TeamLaunchRequest;
    members: TeamCreateRequest['members'];
    lanePlan: Extract<TeamRuntimeLanePlan, { mode: 'pure_opencode_member_lanes' }>;
    prompt: string;
    sourceWarning?: string;
    onProgress: (progress: TeamProvisioningProgress) => void;
  }): Promise<TeamLaunchResponse> {
    const teamKey = input.request.teamName.trim().toLowerCase();
    const runtimeLaunchMembers =
      this.preparedOpenCodeRuntimeLaunchMembersByTeam.get(teamKey) ?? input.members;
    try {
      return await super.runOpenCodeWorktreeRootAggregateLaunch({
        ...input,
        members: runtimeLaunchMembers,
      });
    } finally {
      if (this.preparedOpenCodeRuntimeLaunchMembersByTeam.get(teamKey) === runtimeLaunchMembers) {
        this.preparedOpenCodeRuntimeLaunchMembersByTeam.delete(teamKey);
      }
    }
  }

  protected override async runOpenCodeTeamRuntimeAdapterLaunch(input: {
    request: TeamCreateRequest | TeamLaunchRequest;
    members: TeamCreateRequest['members'];
    prompt: string;
    sourceWarning?: string;
    onProgress: (progress: TeamProvisioningProgress) => void;
  }): Promise<TeamLaunchResponse> {
    const configuredLanePlan = this.planRuntimeLanesOrThrow(
      input.request.providerId,
      input.members,
      input.request.cwd
    );
    const runtimeLaunchMembers = this.prepareFacade.buildOpenCodeRuntimeAdapterLaunchMembers(
      input.request,
      input.members,
      configuredLanePlan
    );
    return super.runOpenCodeTeamRuntimeAdapterLaunch({
      ...input,
      members: runtimeLaunchMembers,
    });
  }
}
