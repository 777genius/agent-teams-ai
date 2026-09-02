import { isLeadMember } from '@shared/utils/leadDetection';

import { selectOpenCodeLaunchFailureDiagnostic } from './TeamProvisioningOpenCodeDiagnosticsPolicy';
import {
  hasOpenCodeRuntimeHandle,
  hasRetainableOpenCodeRuntimeMember,
} from './TeamProvisioningOpenCodeRuntimeEvidencePolicy';

import type { TeamRuntimeLaunchResult } from '../runtime';
import type { MixedSecondaryRuntimeLaneState } from './TeamProvisioningSecondaryRuntimeRuns';

/**
 * THE LEAD IS A VETO, NOT A VOTE.
 *
 * `summarizeOpenCodeAggregateLaunchState` treats the primary lane as one voice
 * among many, and the retainability check only asked whether *some* lane still
 * held a usable member. Two healthy side lanes were therefore enough to promote
 * a team whose lead held no runtime session to `ready`, message "OpenCode team
 * is running with unavailable members" - and then hand that lead the launch
 * prompt. A team with no usable lead cannot function, so the lead's bootstrap
 * state overrides the aggregate vote in both directions.
 */
export type OpenCodePrimaryLeadBootstrapState = 'confirmed' | 'pending' | 'failed';

export function resolveOpenCodeAggregatePrimaryLeadName(
  members: readonly { name: string }[]
): string | null {
  return members.find((member) => isLeadMember(member))?.name?.trim() || null;
}

export function findOpenCodePrimaryLeadEvidence(
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

export function buildOpenCodePrimaryLeadBootstrapFailureReason(leadName: string): string {
  return `OpenCode team lead "${leadName}" has no committed runtime session on the primary lane`;
}

/**
 * A lead the bridge parked on a permission prompt holds no pid and no session
 * id yet, so `hasOpenCodeRuntimeHandle` alone reads it as a dead lead and tears
 * the whole team down. It is a lead WAITING, not a lead that failed: every other
 * retainability predicate in the codebase (`isRecoverableOpenCodeRuntimeEvidence`,
 * `isRecoverablePersistedOpenCodeRuntimeCandidate`) counts it as live, and the
 * user answering the prompt is what unblocks the lane.
 */
function isOpenCodePermissionBlockedLeadEvidence(
  evidence: TeamRuntimeLaunchResult['members'][string]
): boolean {
  return (
    (evidence.pendingPermissionRequestIds?.length ?? 0) > 0 ||
    evidence.launchState === 'runtime_pending_permission' ||
    evidence.livenessKind === 'permission_blocked'
  );
}

/**
 * `committedSessionEvidence` is the disk read the delivery path will repeat
 * shortly afterwards. It may only ever DOWNGRADE: `false` is proof, while `null`
 * (read failed, or no reader wired) must not defer a healthy launch's prompt on
 * an I/O hiccup.
 */
export function classifyOpenCodePrimaryLeadBootstrap(input: {
  leadName: string | null;
  primaryResult: TeamRuntimeLaunchResult | null;
  committedSessionEvidence?: boolean | null;
}): OpenCodePrimaryLeadBootstrapState {
  if (!input.leadName) {
    // No lead on the primary lane: there is nothing for this gate to veto.
    return 'confirmed';
  }
  const evidence = findOpenCodePrimaryLeadEvidence(input.primaryResult, input.leadName);
  if (!evidence) {
    // No entry for the lead at all is not this gate's failure shape:
    // `normalizeExpectedOpenCodeRuntimeLaunchMembers` turns a genuinely missing
    // expected member into `failed_to_start`, so an absent entry means the
    // result never went through normalization. Inventing a veto here would
    // fail launches whose primary lane simply reported a different member.
    return 'confirmed';
  }
  if (evidence.launchState === 'failed_to_start' || evidence.hardFailure === true) {
    return 'failed';
  }
  const claimsConfirmed =
    evidence.launchState === 'confirmed_alive' ||
    evidence.bootstrapConfirmed === true ||
    evidence.livenessKind === 'confirmed_bootstrap';
  if (claimsConfirmed && input.committedSessionEvidence !== false) {
    return 'confirmed';
  }
  // Materialized but uncommitted is the grace case: the commit may still land,
  // so the run stays active rather than failing the whole team.
  return hasOpenCodeRuntimeHandle(evidence) || isOpenCodePermissionBlockedLeadEvidence(evidence)
    ? 'pending'
    : 'failed';
}

export function resolveOpenCodeAggregateLaunchStateForLeadBootstrap(
  launchState: TeamRuntimeLaunchResult['teamLaunchState'],
  leadBootstrap: OpenCodePrimaryLeadBootstrapState
): TeamRuntimeLaunchResult['teamLaunchState'] {
  if (leadBootstrap === 'failed') {
    return 'partial_failure';
  }
  if (leadBootstrap === 'pending' && launchState === 'clean_success') {
    return 'partial_pending';
  }
  return launchState;
}

const PRIMARY_LANE_DIAGNOSTIC_PREFIX = 'primary:';

/**
 * Primary-lane diagnostics were excluded from the progress tail entirely, which
 * is why a primary lane could never contribute a launch-timing line to the
 * runtime view even in a healthy run.
 */
export function collectOpenCodeAggregateLaneDiagnostics(input: {
  primaryResult: TeamRuntimeLaunchResult | null;
  lanes: readonly MixedSecondaryRuntimeLaneState[];
}): string[] {
  return [
    ...(input.primaryResult?.diagnostics ?? []).map(
      (diagnostic) => `${PRIMARY_LANE_DIAGNOSTIC_PREFIX} ${diagnostic}`
    ),
    ...input.lanes.flatMap((lane) => lane.diagnostics),
  ];
}

export interface OpenCodeAggregateLaunchPromotion {
  failed: boolean;
  partialTeamCanContinue: boolean;
  terminalFailure: boolean;
  laneDiagnostics: string[];
  terminalFailureError: string | null;
}

export function summarizeOpenCodeAggregateLaunchPromotion(input: {
  launchState: TeamRuntimeLaunchResult['teamLaunchState'];
  leadBootstrap: OpenCodePrimaryLeadBootstrapState;
  leadName: string | null;
  primaryResult: TeamRuntimeLaunchResult | null;
  lanes: readonly MixedSecondaryRuntimeLaneState[];
}): OpenCodeAggregateLaunchPromotion {
  const failed = input.launchState === 'partial_failure' || input.leadBootstrap === 'failed';
  const retainableResults = [input.primaryResult, ...input.lanes.map((lane) => lane.result)].filter(
    (result): result is TeamRuntimeLaunchResult => result != null
  );
  const partialTeamCanContinue =
    failed &&
    input.leadBootstrap !== 'failed' &&
    retainableResults.some((result) => hasRetainableOpenCodeRuntimeMember(result));
  const laneDiagnostics = collectOpenCodeAggregateLaneDiagnostics({
    primaryResult: input.primaryResult,
    lanes: input.lanes,
  });
  const leadFailureReason =
    input.leadBootstrap === 'failed' && input.leadName
      ? buildOpenCodePrimaryLeadBootstrapFailureReason(input.leadName)
      : null;
  return {
    failed,
    partialTeamCanContinue,
    terminalFailure: failed && !partialTeamCanContinue,
    laneDiagnostics,
    // The lead reason LEADS - it is prepended, never substituted, so the
    // underlying diagnostic survives in the same failure artifact.
    terminalFailureError:
      [
        leadFailureReason,
        selectOpenCodeLaunchFailureDiagnostic([
          ...retainableResults.flatMap((launchResult) => [
            ...Object.values(launchResult.members).flatMap((member) => [
              member.hardFailureReason,
              member.runtimeDiagnostic,
              ...member.diagnostics,
            ]),
            ...launchResult.diagnostics,
          ]),
          ...laneDiagnostics,
        ]),
      ]
        .filter((part): part is string => Boolean(part))
        .join(': ') || null,
  };
}

export interface OpenCodeAggregatePrimaryLeadBootstrapPorts {
  /**
   * Fresh lane-storage read for the lead. Absent (or throwing) means "cannot
   * disprove"; only an explicit `false` downgrades the classification.
   */
  hasCommittedOpenCodePrimaryLeadSessionEvidence?(input: {
    teamName: string;
    runId: string;
    laneId: string;
    memberName: string;
  }): Promise<boolean>;
}

export interface OpenCodeAggregatePrimaryLeadBootstrapOutcome {
  state: OpenCodePrimaryLeadBootstrapState;
  leadName: string | null;
}

export async function resolveOpenCodeAggregatePrimaryLeadBootstrap(
  params: {
    teamName: string;
    runId: string;
    effectiveMembers: readonly { name: string }[];
    primaryResult: TeamRuntimeLaunchResult | null;
  },
  ports: OpenCodeAggregatePrimaryLeadBootstrapPorts
): Promise<OpenCodeAggregatePrimaryLeadBootstrapOutcome> {
  const leadName = resolveOpenCodeAggregatePrimaryLeadName(params.effectiveMembers);
  const committedSessionEvidence = leadName
    ? ((await ports
        .hasCommittedOpenCodePrimaryLeadSessionEvidence?.({
          teamName: params.teamName,
          runId: params.runId,
          laneId: 'primary',
          memberName: leadName,
        })
        .catch(() => null)) ?? null)
    : null;
  return {
    state: classifyOpenCodePrimaryLeadBootstrap({
      leadName,
      primaryResult: params.primaryResult,
      committedSessionEvidence,
    }),
    leadName,
  };
}
