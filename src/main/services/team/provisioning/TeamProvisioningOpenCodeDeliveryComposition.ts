import { findDeliverableOpenCodeRuntimeBootstrapSessionEvidence } from './TeamProvisioningOpenCodeBootstrapEvidence';
import { getTrackedOpenCodeBootstrapWakeRunId } from './TeamProvisioningSecondaryRuntimeRuns';

import type { OpenCodePromptDeliveryWatchdogCoordinatorPorts } from '../opencode/delivery/OpenCodePromptDeliveryWatchdogCoordinator';
import type { OpenCodeRuntimeBootstrapEvidencePorts } from './TeamProvisioningOpenCodeBootstrapEvidence';

export function createOpenCodeBootstrapWakePorts(
  runtime: Parameters<typeof getTrackedOpenCodeBootstrapWakeRunId>[1],
  createEvidencePorts: () => OpenCodeRuntimeBootstrapEvidencePorts
): Pick<
  OpenCodePromptDeliveryWatchdogCoordinatorPorts,
  'resolveTrackedBootstrapRunId' | 'hasCommittedBootstrapSession'
> {
  return {
    resolveTrackedBootstrapRunId: (input) => getTrackedOpenCodeBootstrapWakeRunId(input, runtime),
    hasCommittedBootstrapSession: async (input) =>
      Boolean(
        await findDeliverableOpenCodeRuntimeBootstrapSessionEvidence(input, createEvidencePorts())
      ),
  };
}

/**
 * Service-side ports the OpenCode prompt-delivery pipeline is composed from.
 *
 * These live next to the OpenCode provisioning modules rather than inside
 * `TeamProvisioningServiceComposition`, which sits at its frozen size cap:
 * growing the delivery pipeline by one port would otherwise mean shrinking an
 * unrelated part of the composition module in the same commit.
 */
export interface TeamProvisioningOpenCodeDeliveryCompositionPorts {
  memberWorkSyncProofBoundary: {
    hasAcceptedMemberWorkSyncReport: OpenCodePromptDeliveryWatchdogCoordinatorPorts['hasAcceptedMemberWorkSyncReport'];
  };
  maybeSyncOpenCodeRuntimePermissionsAfterDelivery: OpenCodePromptDeliveryWatchdogCoordinatorPorts['maybeSyncRuntimePermissionsAfterDelivery'];
  rememberOpenCodeRuntimePidFromBridge: OpenCodePromptDeliveryWatchdogCoordinatorPorts['rememberRuntimePidFromBridge'];
  scheduleOpenCodePromptDeliveryWatchdog: NonNullable<
    OpenCodePromptDeliveryWatchdogCoordinatorPorts['schedulePromptDeliveryWatchdog']
  >;
  notifyOpenCodeLeadTurnActivity: NonNullable<
    OpenCodePromptDeliveryWatchdogCoordinatorPorts['notifyLeadTurnActivity']
  >;
  canDeliverToOpenCodeRuntimeForTeam: OpenCodePromptDeliveryWatchdogCoordinatorPorts['canDeliverToTeamRuntime'];
  tryRecoverOpenCodeRuntimeLanesForDeliveryWatchdog: OpenCodePromptDeliveryWatchdogCoordinatorPorts['recoverRuntimeLanesForWatchdog'];
  openCodeStoppedLaneCleanup: {
    stopOpenCodeRuntimeLanesForStoppedTeam: OpenCodePromptDeliveryWatchdogCoordinatorPorts['stopRuntimeLanesForStoppedTeam'];
  };
  createOpenCodePromptDeliveryLedger: OpenCodePromptDeliveryWatchdogCoordinatorPorts['createLedger'];
  openCodeRuntimeRecoveryIdentity: {
    resolveOpenCodeMembersForRuntimeLane: OpenCodePromptDeliveryWatchdogCoordinatorPorts['resolveMembersForRuntimeLane'];
    resolveCurrentOpenCodeRuntimeRunId: OpenCodePromptDeliveryWatchdogCoordinatorPorts['resolveCurrentRuntimeRunId'];
  };
  logOpenCodePromptDeliveryEvent: OpenCodePromptDeliveryWatchdogCoordinatorPorts['logPromptDeliveryEvent'];
}
