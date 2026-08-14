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
    private readonly attachmentStore: TeamAttachmentStore = new TeamAttachmentStore()
  ) {
    super();
    this.initializeTeamProvisioningService();
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
