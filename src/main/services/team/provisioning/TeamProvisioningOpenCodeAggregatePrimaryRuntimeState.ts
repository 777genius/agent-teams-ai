import type { OpenCodeMemberInboxDelivery } from '../opencode/delivery/OpenCodeMemberMessageDeliveryService';
import type { ProvisioningRun } from './TeamProvisioningRunModel';
import type { TeamProvisioningProgress } from '@shared/types';

export function getOpenCodeAggregatePrimaryDeliveryRejection(input: {
  stopRequested: boolean;
  primaryRuntimeStopping: boolean;
  hasSecondaryRuntime: boolean;
}): OpenCodeMemberInboxDelivery | null {
  if (!input.stopRequested && !input.primaryRuntimeStopping) {
    return null;
  }
  if (input.hasSecondaryRuntime) {
    return { delivered: false, reason: 'opencode_runtime_not_active' };
  }
  return {
    delivered: false,
    accepted: false,
    responsePending: false,
    responseState: 'not_observed',
    ledgerStatus: 'retry_scheduled',
    laneId: 'primary',
    reason: 'opencode_primary_runtime_not_deliverable',
    diagnostics: ['opencode_primary_runtime_not_deliverable'],
  };
}

export function isOpenCodeAggregateTeamAlive(input: {
  stopRequested: boolean;
  runId: string | null;
  stoppingRunId: string | null;
  primaryRuntimeOwned: boolean;
  secondaryRuntimeOwned: boolean;
  runtimeProgressState: TeamProvisioningProgress['state'] | undefined;
  run: ProvisioningRun | undefined;
}): boolean {
  if (input.stopRequested || !input.runId) {
    return false;
  }
  if (input.stoppingRunId === input.runId) {
    return false;
  }
  if (
    !input.secondaryRuntimeOwned &&
    (input.runtimeProgressState === 'disconnected' ||
      input.runtimeProgressState === 'failed' ||
      input.runtimeProgressState === 'cancelled')
  ) {
    return false;
  }
  if (!input.run) {
    return input.primaryRuntimeOwned || input.secondaryRuntimeOwned;
  }
  if (input.primaryRuntimeOwned || input.secondaryRuntimeOwned) {
    return !input.run.processKilled && !input.run.cancelRequested;
  }
  return input.run.child != null;
}
