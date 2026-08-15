import { createDesktopTeamFeatureCapabilitySources } from '@main/ipc/desktopTeamFeatureCapabilitySources';
import {
  observeHostedApprovalRuntimeFailure,
  stopAllTeamsWithHostedApprovalRuntime,
} from '@main/services/team/provisioning/HostedApprovalRuntimeDesktopLifecycle';
import { createHostedApprovalRuntimeLifecycleOwner } from '@main/services/team/provisioning/HostedApprovalRuntimeLifecycleOwner';
import { createProductOwnedTeamProvisioningService } from '@main/services/team/provisioning/HostedApprovalRuntimeProductionComposition';
import { HostedApprovalRuntimeProductionLifecycleBoundary } from '@main/services/team/provisioning/HostedApprovalRuntimeProductionLifecycleBoundary';
import { getAppDataPath, getTeamsBasePath } from '@main/utils/pathDecoder';

import type { HostedApprovalRuntimeLifecycle } from '@main/services/team/provisioning/HostedApprovalRuntimeAdmissionPublisher';
import type { HostedApprovalRuntimeRevocationLogger } from '@main/services/team/provisioning/HostedApprovalRuntimeDesktopLifecycle';
import type { HostedApprovalRuntimeOwnerLeaseContract } from '@main/services/team/provisioning/HostedApprovalRuntimeProductionLifecycleBoundary';
import type { LeadRuntimeFailureObservation } from '@main/services/team/TeamProvisioningService';

/** Product composition beside the compatibility facade; lifecycle authority stays on focused ports. */
export function createProductTeamProvisioning() {
  const composition = createProductOwnedTeamProvisioningService(
    getTeamsBasePath(),
    getAppDataPath()
  );
  const capabilities = createDesktopTeamFeatureCapabilitySources(
    composition.service,
    composition.hostedApprovalRuntime
  );
  const trustedLifecycleOwner = createHostedApprovalRuntimeLifecycleOwner(
    composition.hostedApprovalRuntime
  );
  const lifecycleBoundary = new HostedApprovalRuntimeProductionLifecycleBoundary(
    trustedLifecycleOwner,
    composition.hostedApprovalRuntime
  );
  return Object.freeze({
    service: composition.service,
    capabilities,
    publishLifecycleTransition: (
      teamName: string,
      lifecycle: HostedApprovalRuntimeLifecycle,
      ownerLease: HostedApprovalRuntimeOwnerLeaseContract | null
    ) => lifecycleBoundary.publish(teamName, lifecycle, ownerLease),
    ensureAdmissionAbsent: (teamName: string, reason: string) =>
      composition.hostedApprovalRuntime.ensureAbsent(teamName, reason),
    observeFailure: (
      failure: LeadRuntimeFailureObservation,
      logger: HostedApprovalRuntimeRevocationLogger
    ) => observeHostedApprovalRuntimeFailure(composition.hostedApprovalRuntime, failure, logger),
    stop: () =>
      stopAllTeamsWithHostedApprovalRuntime(composition.hostedApprovalRuntime, composition.service),
  });
}
