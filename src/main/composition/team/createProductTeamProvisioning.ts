import { createDesktopTeamFeatureCapabilitySources } from '@main/ipc/desktopTeamFeatureCapabilitySources';
import {
  observeHostedApprovalRuntimeFailure,
  stopAllTeamsWithHostedApprovalRuntime,
} from '@main/services/team/provisioning/HostedApprovalRuntimeDesktopLifecycle';
import { createHostedApprovalRuntimeLifecycleOwner } from '@main/services/team/provisioning/HostedApprovalRuntimeLifecycleOwner';
import { createProductOwnedTeamProvisioningService } from '@main/services/team/provisioning/HostedApprovalRuntimeProductionComposition';
import { getAppDataPath, getTeamsBasePath } from '@main/utils/pathDecoder';

import type { HostedApprovalRuntimeRevocationLogger } from '@main/services/team/provisioning/HostedApprovalRuntimeDesktopLifecycle';
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
  return Object.freeze({
    service: composition.service,
    capabilities,
    trustedLifecycleOwner,
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
