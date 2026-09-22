export type TeamProcessFanoutMode = 'process-lite' | 'structural';

export interface TeamProcessFanoutInput {
  teamName: string;
  eventType: string;
  detail?: string;
  hasRunId: boolean;
  isStaleRuntimeEvent: boolean;
  isVisible: boolean;
  hasVisibleTeamData: boolean;
  hasActiveProvisioningRun: boolean;
  hasCurrentRuntimeRun: boolean;
}

export type TeamProcessFanoutDryRunInput = TeamProcessFanoutInput;

export type TeamProcessFanoutDecisionReason =
  | 'not-process-event'
  | 'stale-runtime-event'
  | 'hidden-team'
  | 'missing-visible-team-data'
  | 'no-active-runtime-context'
  | 'unsafe-process-detail'
  | 'processes-json-visible-runtime-context';

export interface TeamProcessFanoutDecision {
  mode: TeamProcessFanoutMode;
  reason: TeamProcessFanoutDecisionReason;
}

export interface TeamProcessFanoutDryRunDecision {
  wouldUseProcessLite: boolean;
  reason: TeamProcessFanoutDecisionReason;
}

export function decideProcessFanoutMode(input: TeamProcessFanoutInput): TeamProcessFanoutDecision {
  if (input.eventType !== 'process') {
    return { mode: 'structural', reason: 'not-process-event' };
  }
  if (input.isStaleRuntimeEvent) {
    return { mode: 'structural', reason: 'stale-runtime-event' };
  }
  if (!input.isVisible) {
    return { mode: 'structural', reason: 'hidden-team' };
  }
  if (!input.hasVisibleTeamData) {
    return { mode: 'structural', reason: 'missing-visible-team-data' };
  }
  if (!input.hasActiveProvisioningRun && !input.hasCurrentRuntimeRun) {
    return { mode: 'structural', reason: 'no-active-runtime-context' };
  }
  if (input.detail !== 'processes.json') {
    return { mode: 'structural', reason: 'unsafe-process-detail' };
  }

  return {
    mode: 'process-lite',
    reason: 'processes-json-visible-runtime-context',
  };
}

export function decideProcessFanoutDryRun(
  input: TeamProcessFanoutDryRunInput
): TeamProcessFanoutDryRunDecision {
  const decision = decideProcessFanoutMode(input);
  return {
    wouldUseProcessLite: decision.mode === 'process-lite',
    reason: decision.reason,
  };
}
