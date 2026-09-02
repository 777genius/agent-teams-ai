import { isRecoverableOpenCodeRuntimeEvidence } from './TeamProvisioningOpenCodeRuntimeEvidencePolicy';

import type { TeamRuntimeLaunchResult } from '../runtime';

/**
 * A blocked OpenCode primary lane used to be completely silent: the adapter logs
 * nothing, the persistence layer only logged a FAILED teardown, and the lane's
 * refusal to hand over the launch prompt never reached the progress tail. The
 * team was then promoted to "running with unavailable members" and the prompt
 * was handed to a lead that had no session.
 *
 * Everything here BUILDS A STRING. Nothing in this module writes, persists,
 * promotes or decides a launch outcome, so adding a report can never change what
 * a launch does - only what it says.
 */

export function describeBlockedOpenCodePrimaryLaneLaunch(input: {
  teamName: string;
  runId: string;
  result: TeamRuntimeLaunchResult;
}): string {
  const failedMembers = Object.values(input.result.members).filter(
    (member) => member.launchState === 'failed_to_start' || member.hardFailure === true
  );
  const reason =
    failedMembers.find((member) => member.hardFailureReason?.trim())?.hardFailureReason?.trim() ??
    input.result.preLaunchGate?.reason ??
    'unknown';
  const gate = input.result.preLaunchGate;
  // preLaunchGate proves the block happened before the runtime launch, i.e.
  // the lane never reached session bootstrap and holds no runtime evidence.
  const gateSummary = gate ? `${gate.reason}/retryable=${gate.retryable}` : 'none';
  return [
    `[${input.teamName}] opencode_primary_lane_launch_blocked`,
    `run=${input.runId}`,
    `preLaunchGate=${gateSummary}`,
    `reason=${reason}`,
    `members=${failedMembers.map((member) => member.memberName).join('/') || 'none'}`,
    `diagnostics=${input.result.diagnostics.join('; ') || 'none'}`,
  ].join(' ');
}

export type UncommittableOpenCodeSessionReason =
  | 'missing_runtime_session_id'
  | 'app_managed_candidate_mismatch';

/**
 * A member that claims bootstrap confirmation but cannot have its session record
 * committed. The commit loop used to skip it with a bare `continue`, which is why
 * no line existed between "launch prompt queued" and the first relay failure.
 */
export function buildUncommittableOpenCodeSessionDiagnostic(input: {
  memberName: string;
  reason: UncommittableOpenCodeSessionReason;
}): string {
  return `opencode_bootstrap_session_not_committed:${input.memberName}:${input.reason}`;
}

export function describeClearedOpenCodePrimaryLaneStorage(input: {
  teamName: string;
  runId: string;
}): string {
  return (
    `[${input.teamName}] opencode_primary_lane_storage_cleared run=${input.runId} ` +
    'reason=unretainable_launch detail=lane_has_no_session_record'
  );
}

export type OpenCodeLeadLaunchEvidenceState = 'retainable' | 'unretainable' | 'unknown';

/**
 * `unknown` means the primary lane result carries no entry for the lead at all,
 * which is not the failure shape this guard is for. Only a lead the primary lane
 * explicitly reports as failed is blocked from receiving the launch prompt.
 */
export function classifyOpenCodeLeadLaunchEvidence(
  result: TeamRuntimeLaunchResult | null,
  leadName: string
): OpenCodeLeadLaunchEvidenceState {
  const leadEvidence = findOpenCodeLeadEvidence(result, leadName);
  if (!leadEvidence) {
    return 'unknown';
  }
  return leadEvidence.launchState !== 'failed_to_start' &&
    leadEvidence.hardFailure !== true &&
    isRecoverableOpenCodeRuntimeEvidence(leadEvidence)
    ? 'retainable'
    : 'unretainable';
}

function findOpenCodeLeadEvidence(
  result: TeamRuntimeLaunchResult | null,
  leadName: string
): TeamRuntimeLaunchResult['members'][string] | undefined {
  if (!result) {
    return undefined;
  }
  const normalizedLeadName = leadName.trim().toLowerCase();
  return Object.entries(result.members).find(
    ([name, evidence]) =>
      (evidence.memberName?.trim() || name.trim()).toLowerCase() === normalizedLeadName
  )?.[1];
}

/**
 * Queueing the launch prompt for a lead with no retainable runtime evidence
 * burns it on a session that does not exist: the bridge answers "No stored
 * OpenCode session record" until the delivery ledger goes terminal.
 *
 * Returns the diagnostic when the prompt must not be queued, and `null` when
 * there is nothing to report. The caller decides what to do with it; this
 * function never touches the launch.
 */
export function describeUnavailableOpenCodeLaunchPromptLead(input: {
  teamName: string;
  leadName: string;
  primaryResult: TeamRuntimeLaunchResult | null;
}): string | null {
  if (classifyOpenCodeLeadLaunchEvidence(input.primaryResult, input.leadName) !== 'unretainable') {
    return null;
  }
  const leadEvidence = findOpenCodeLeadEvidence(input.primaryResult, input.leadName);
  const reason =
    leadEvidence?.hardFailureReason?.trim() ||
    leadEvidence?.runtimeDiagnostic?.trim() ||
    input.primaryResult?.diagnostics.find((diagnostic) => diagnostic.trim()) ||
    input.primaryResult?.preLaunchGate?.reason ||
    'primary_lane_produced_no_runtime_evidence';
  return (
    `[${input.teamName}] opencode_launch_prompt_lead_unavailable ` +
    `lead=${input.leadName} reason=${reason}`
  );
}

export const OPENCODE_LAUNCH_PROMPT_DEFERRED_DIAGNOSTIC =
  'opencode_launch_prompt_deferred_until_lead_bootstrap';

/**
 * The prompt IS queued while the lead bootstrap is pending - only the bridge
 * dispatch waits for evidence to commit. Naming the wait is what makes the
 * progress tail explain a team that looks idle.
 */
export function describeDeferredOpenCodeLaunchPrompt(input: {
  teamName: string;
  leadName: string;
}): string {
  return `[${input.teamName}] ${OPENCODE_LAUNCH_PROMPT_DEFERRED_DIAGNOSTIC} lead=${input.leadName}`;
}
