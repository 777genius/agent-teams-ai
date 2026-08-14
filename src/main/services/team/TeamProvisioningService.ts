import { TeamProvisioningOpenCodeAggregatePrimaryFacade } from './provisioning/TeamProvisioningOpenCodeAggregatePrimaryFacade';
import { OpenCodeTaskLogAttributionStore } from './taskLogs/stream/OpenCodeTaskLogAttributionStore';
import { TeamAttachmentStore } from './TeamAttachmentStore';
import { TeamConfigReader } from './TeamConfigReader';
import { TeamInboxReader } from './TeamInboxReader';
import { TeamInboxWriter } from './TeamInboxWriter';
import { TeamMcpConfigBuilder } from './TeamMcpConfigBuilder';
import { TeamMembersMetaStore } from './TeamMembersMetaStore';
import { TeamMemberWorktreeManager } from './TeamMemberWorktreeManager';
import { TeamMetaStore } from './TeamMetaStore';
import { TeamSentMessagesStore } from './TeamSentMessagesStore';

export type {
  HostedApprovalRuntimeAdmissionCoordinator,
  HostedApprovalRuntimeAuthoritativeEvidence,
} from './provisioning/HostedApprovalRuntimeAdmissionComposition';
export type {
  HostedApprovalRuntimeLifecycle,
  HostedApprovalRuntimePublication,
} from './provisioning/HostedApprovalRuntimeAdmissionPublisher';
export type {
  HostedApprovalRuntimeTransitionEvidence,
} from './provisioning/HostedApprovalRuntimeAuthoritativeEvidenceAdapter';
export type { RuntimeBootstrapMemberMcpLaunchConfig } from './provisioning/TeamProvisioningBootstrapSpec';
export { buildDirectTmuxRestartEnvAssignments } from './provisioning/TeamProvisioningDirectRestart';
export {
  getMixedLaunchFallbackRecoveryError,
  getOpenCodeMixedProviderProvisioningError,
} from './provisioning/TeamProvisioningLaunchCompatibility';
export {
  shouldWarnOnMissingRegisteredMember,
  shouldWarnOnUnreadableMemberAuditConfig,
} from './provisioning/TeamProvisioningMemberSpawnStatusPolicy';
export {
  buildAddMemberSpawnMessage,
  buildRestartMemberSpawnMessage,
} from './provisioning/TeamProvisioningPromptBuilders';
export type { LeadRuntimeFailureObservation } from './provisioning/TeamProvisioningRuntimeFailureObservationBoundary';

import type { HostedApprovalRuntimeAdmissionCoordinator } from './provisioning/HostedApprovalRuntimeAdmissionComposition';
import type {
  HostedApprovalRuntimeLifecycle,
  HostedApprovalRuntimePublication,
} from './provisioning/HostedApprovalRuntimeAdmissionPublisher';
import type {
  HostedApprovalRuntimeTransitionAuthority,
  HostedApprovalRuntimeTransitionEvidence,
} from './provisioning/HostedApprovalRuntimeAuthoritativeEvidenceAdapter';
import type { ProvisioningRun } from './provisioning/TeamProvisioningRunModel';
import type {
  LeadRuntimeFailureObservation,
  RuntimeFailureObservationInput,
} from './provisioning/TeamProvisioningRuntimeFailureObservationBoundary';
import type { TeamChangeEvent } from '@shared/types';

/** Stable app-shell facade. Construction and orchestration live in focused delegate layers. */
export class TeamProvisioningService extends TeamProvisioningOpenCodeAggregatePrimaryFacade {
  constructor(
    private readonly configReader: TeamConfigReader = new TeamConfigReader(),
    protected readonly inboxReader: TeamInboxReader = new TeamInboxReader(),
    protected readonly membersMetaStore: TeamMembersMetaStore = new TeamMembersMetaStore(),
    private readonly sentMessagesStore: TeamSentMessagesStore = new TeamSentMessagesStore(),
    private readonly mcpConfigBuilder: TeamMcpConfigBuilder = new TeamMcpConfigBuilder(),
    private readonly teamMetaStore: TeamMetaStore = new TeamMetaStore(),
    private readonly inboxWriter: TeamInboxWriter = new TeamInboxWriter(),
    private readonly openCodeTaskLogAttributionStore: OpenCodeTaskLogAttributionStore = new OpenCodeTaskLogAttributionStore(),
    private readonly memberWorktreeManager: TeamMemberWorktreeManager = new TeamMemberWorktreeManager(),
    private readonly attachmentStore: TeamAttachmentStore = new TeamAttachmentStore(),
    private readonly hostedApprovalRuntimeAdmission: HostedApprovalRuntimeAdmissionCoordinator | null = null,
    private readonly hostedApprovalRuntimeTransitionAuthority: HostedApprovalRuntimeTransitionAuthority | null = null
  ) {
    super();
    this.initializeTeamProvisioningService();
  }

  transitionHostedApprovalRuntimeAdmission(
    teamName: string,
    lifecycle: HostedApprovalRuntimeLifecycle,
    evidence?: HostedApprovalRuntimeTransitionEvidence
  ): Promise<HostedApprovalRuntimePublication> {
    if (!this.hostedApprovalRuntimeAdmission) {
      return Promise.resolve(
        Object.freeze({
          state: 'revoked' as const,
          reason: 'hosted-approval-runtime-capability-disabled',
        })
      );
    }
    if (this.hostedApprovalRuntimeTransitionAuthority && evidence) {
      return this.hostedApprovalRuntimeTransitionAuthority.withEvidence(teamName, evidence, () =>
        this.hostedApprovalRuntimeAdmission!.transition(teamName, lifecycle)
      );
    }
    return this.hostedApprovalRuntimeAdmission.transition(teamName, lifecycle);
  }

  async notifyHostedApprovalRuntimeOwnerLoss(teamName: string): Promise<void> {
    await this.hostedApprovalRuntimeAdmission?.beforeOwnerLoss(teamName, async () => undefined);
  }

  async notifyHostedApprovalRuntimeFailure(teamName: string): Promise<void> {
    await this.hostedApprovalRuntimeAdmission?.beforeFailure(teamName, async () => undefined);
  }

  protected override handleProcessExit(run: ProvisioningRun, code: number | null): Promise<void> {
    const handle = () => super.handleProcessExit(run, code);
    if (!this.hostedApprovalRuntimeAdmission) return handle();
    return code === 0
      ? this.hostedApprovalRuntimeAdmission.beforeOwnerLoss(run.teamName, handle)
      : this.hostedApprovalRuntimeAdmission.beforeFailure(run.teamName, handle);
  }

  override stopTeam(teamName: string): Promise<void> {
    const stop = () => super.stopTeam(teamName);
    return this.hostedApprovalRuntimeAdmission
      ? this.hostedApprovalRuntimeAdmission.beforeStop(teamName, stop)
      : stop();
  }

  override cancelProvisioning(runId: string): Promise<void> {
    const teamName = this.runs.get(runId)?.teamName;
    const cancel = () => super.cancelProvisioning(runId);
    return teamName && this.hostedApprovalRuntimeAdmission
      ? this.hostedApprovalRuntimeAdmission.beforeCancel(teamName, cancel)
      : cancel();
  }

  override createTeam(
    ...args: Parameters<TeamProvisioningOpenCodeAggregatePrimaryFacade['createTeam']>
  ): ReturnType<TeamProvisioningOpenCodeAggregatePrimaryFacade['createTeam']> {
    const create = () => super.createTeam(...args);
    return this.hostedApprovalRuntimeAdmission
      ? this.hostedApprovalRuntimeAdmission.beforeBindingChange(args[0].teamName, create)
      : create();
  }

  override launchTeam(
    ...args: Parameters<TeamProvisioningOpenCodeAggregatePrimaryFacade['launchTeam']>
  ): ReturnType<TeamProvisioningOpenCodeAggregatePrimaryFacade['launchTeam']> {
    const launch = () => super.launchTeam(...args);
    return this.hostedApprovalRuntimeAdmission
      ? this.hostedApprovalRuntimeAdmission.beforeBindingChange(args[0].teamName, launch)
      : launch();
  }

  override attachLiveRosterMember(
    ...args: Parameters<TeamProvisioningOpenCodeAggregatePrimaryFacade['attachLiveRosterMember']>
  ): ReturnType<TeamProvisioningOpenCodeAggregatePrimaryFacade['attachLiveRosterMember']> {
    const attach = () => super.attachLiveRosterMember(...args);
    return this.hostedApprovalRuntimeAdmission
      ? this.hostedApprovalRuntimeAdmission.beforeBindingChange(args[0], attach)
      : attach();
  }

  override detachLiveRosterMember(
    ...args: Parameters<TeamProvisioningOpenCodeAggregatePrimaryFacade['detachLiveRosterMember']>
  ): ReturnType<TeamProvisioningOpenCodeAggregatePrimaryFacade['detachLiveRosterMember']> {
    const detach = () => super.detachLiveRosterMember(...args);
    return this.hostedApprovalRuntimeAdmission
      ? this.hostedApprovalRuntimeAdmission.beforeBindingChange(args[0], detach)
      : detach();
  }

  override restartMember(
    ...args: Parameters<TeamProvisioningOpenCodeAggregatePrimaryFacade['restartMember']>
  ): ReturnType<TeamProvisioningOpenCodeAggregatePrimaryFacade['restartMember']> {
    const restart = () => super.restartMember(...args);
    return this.hostedApprovalRuntimeAdmission
      ? this.hostedApprovalRuntimeAdmission.beforeBindingChange(args[0], restart)
      : restart();
  }

  override stopAllTeams(): Promise<void> {
    const stop = () => super.stopAllTeams();
    return this.hostedApprovalRuntimeAdmission
      ? this.hostedApprovalRuntimeAdmission.beforeShutdown(this.getAliveTeams(), stop)
      : stop();
  }

  setTeamChangeEmitter(emitter: ((event: TeamChangeEvent) => void) | null): void {
    this.teamChangeEmitter = emitter;
  }

  setRuntimeRecoveryFailureObserver(
    observer: ((failure: LeadRuntimeFailureObservation) => void) | null
  ): void {
    this.runtimeFailureObservationBoundary.setObserver(observer);
  }

  protected observeRuntimeFailure(
    run: ProvisioningRun,
    failure: RuntimeFailureObservationInput
  ): void {
    this.runtimeFailureObservationBoundary.observe(run, this.getRunLeadName(run), failure);
  }
}
