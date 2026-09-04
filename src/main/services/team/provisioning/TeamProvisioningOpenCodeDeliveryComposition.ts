import type { OpenCodePrimaryLaneBootstrapSelfHealPorts } from '../opencode/delivery/OpenCodePrimaryLaneBootstrapSelfHeal';
import type { OpenCodePromptDeliveryWatchdogCoordinatorPorts } from '../opencode/delivery/OpenCodePromptDeliveryWatchdogCoordinator';

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

/**
 * The service-side half of the primary-lane bootstrap self-heal.
 *
 * Declared with the delivery pipeline's other ports rather than in
 * `TeamProvisioningServiceComposition`: that module is already past the repo's
 * default source-size limit and builds only against a frozen legacy allowance
 * the size guard exists to retire, so a delivery port belongs next to the
 * pipeline it serves rather than against the little headroom left there.
 *
 * Both members are optional and both fail safe. Without
 * `rebootstrapOpenCodeAggregatePrimaryLane` the tracker can decide but never
 * relaunch, and without `isOpenCodePrimaryLaneSelfHealEnabled` the shipped
 * default (`OPENCODE_PRIMARY_LANE_SELF_HEAL_DEFAULT_ENABLED`) applies. This is
 * the single seam for turning the automatic relaunch off: supply a predicate
 * that returns `false` and nothing else in the app changes.
 */
export interface TeamProvisioningOpenCodePrimaryLaneSelfHealPorts {
  rebootstrapOpenCodeAggregatePrimaryLane?(teamName: string, reason: string): Promise<boolean>;
  isOpenCodePrimaryLaneSelfHealEnabled?: OpenCodePrimaryLaneBootstrapSelfHealPorts['isOpenCodePrimaryLaneSelfHealEnabled'];
}
