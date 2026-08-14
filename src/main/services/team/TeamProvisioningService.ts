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

export type { RuntimeBootstrapMemberMcpLaunchConfig } from './provisioning/TeamProvisioningBootstrapSpec';
export {
  type AuthoritativeHostedApprovalRuntimeBinding,
  type HostedApprovalRuntimeAdmissionPublisherPorts,
  HostedApprovalRuntimeAdmissionPublisher,
  type HostedApprovalRuntimeLifecycle,
  type HostedApprovalRuntimePublication,
  HOSTED_APPROVAL_RUNTIME_ADMISSION_FILE,
} from './provisioning/HostedApprovalRuntimeAdmissionPublisher';
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

import type { ProvisioningRun } from './provisioning/TeamProvisioningRunModel';
import type {
  HostedApprovalRuntimeAdmissionPublisher,
  HostedApprovalRuntimeLifecycle,
  HostedApprovalRuntimePublication,
} from './provisioning/HostedApprovalRuntimeAdmissionPublisher';
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
    /** Explicit per-team opt-in; normal desktop and hosted production remain capability-false. */
    private readonly hostedApprovalRuntimeAdmissionPublisher?: HostedApprovalRuntimeAdmissionPublisher
  ) {
    super();
    this.initializeTeamProvisioningService();
  }

  reconcileHostedApprovalRuntimeAdmission(
    teamName: string,
    lifecycle: HostedApprovalRuntimeLifecycle
  ): Promise<HostedApprovalRuntimePublication> {
    return this.hostedApprovalRuntimeAdmissionPublisher
      ? this.hostedApprovalRuntimeAdmissionPublisher.reconcile(teamName, lifecycle)
      : Promise.resolve(
          Object.freeze({
            state: 'revoked' as const,
            reason: 'hosted-approval-runtime-publisher-not-configured',
          })
        );
  }

  override async stopTeam(teamName: string): Promise<void> {
    try {
      await super.stopTeam(teamName);
    } finally {
      await this.hostedApprovalRuntimeAdmissionPublisher?.revoke(teamName, 'stopped');
    }
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
