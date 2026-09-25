import type {
  HostedLifecycleEpochUpdate,
  HostedLifecycleMemberRetirement,
  HostedLifecycleRunStateChange,
} from '../../../contracts/hostedLifecycleCurrentAuthorityContracts';
import type {
  HostedLifecycleRunAliasClaim,
  HostedLifecycleRunReservationInput,
} from '../../../contracts/hostedLifecycleRunReservationContracts';
import type {
  HostedPromotionBegin,
  HostedPromotionLookup,
} from '../../../contracts/hostedPromotionStorageContracts';
import type {
  HostedTeamConfigurationStorageCreateRequest,
  HostedTeamConfigurationStorageDeleteRequest,
  HostedTeamConfigurationStorageUpdateRequest,
} from '../../../contracts/hostedTeamConfigurationStorageContracts';
import type { TeamDraftPublicationScope } from '../../../contracts/teamDraftPublicationContracts';
import type { RunId, TeamId, WorkspaceId } from '@shared/contracts/hosted';

export interface HostedTeamConfigurationWorkerPayloadByOp {
  'hostedLifecycleRun.lookupByResource': Pick<
    HostedLifecycleRunReservationInput,
    'deploymentId' | 'bootId' | 'teamId' | 'expectedRevision'
  >;
  'hostedLifecycleRun.currentPlanGeneration': TeamDraftPublicationScope;
  'hostedLifecycleRun.reserve': HostedLifecycleRunReservationInput;
  'hostedLifecycleRun.claimAlias': HostedLifecycleRunAliasClaim;
  'hostedLifecycleRun.lookup': RunId;
  'hostedLifecycleRun.resolveMember': {
    readonly runId: RunId;
    readonly memberId: string;
  };
  'hostedLifecycleCurrent.lookupAuthority': import('@shared/contracts/hosted').DeploymentId;
  'hostedLifecycleCurrent.setAuthority': HostedLifecycleEpochUpdate;
  'hostedLifecycleCurrent.retireAuthority': HostedLifecycleEpochUpdate;
  'hostedLifecycleCurrent.activateRun': HostedLifecycleRunStateChange;
  'hostedLifecycleCurrent.retireRun': HostedLifecycleRunStateChange;
  'hostedLifecycleCurrent.retireMember': HostedLifecycleMemberRetirement;
  'hostedPromotion.begin': HostedPromotionBegin;
  'hostedPromotion.lookup': HostedPromotionLookup;
  'hostedPromotion.lookupRosterBinding': HostedPromotionLookup;
  'hostedTeamConfiguration.create': HostedTeamConfigurationStorageCreateRequest;
  'hostedTeamConfiguration.read': {
    readonly workspaceId: WorkspaceId;
    readonly teamId: TeamId;
  };
  'hostedTeamConfiguration.update': HostedTeamConfigurationStorageUpdateRequest;
  'hostedTeamConfiguration.delete': HostedTeamConfigurationStorageDeleteRequest;
}
