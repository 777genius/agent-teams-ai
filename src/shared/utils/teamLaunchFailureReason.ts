import { isNativeBootstrapControlText } from '@shared/utils/teamInternalControlMessages';

import type {
  MemberLaunchState,
  MemberSpawnStatus,
  TeamAgentRuntimeDiagnosticSeverity,
  TeamAgentRuntimeLivenessKind,
} from '@shared/types';

export interface ProvisionedButNotAliveLaunchEntry {
  launchState?: MemberLaunchState;
  status?: MemberSpawnStatus;
  hardFailure?: boolean;
  hardFailureReason?: string;
  error?: string;
  runtimeDiagnostic?: string;
  runtimeDiagnosticSeverity?: TeamAgentRuntimeDiagnosticSeverity;
  bootstrapConfirmed?: boolean;
  livenessKind?: TeamAgentRuntimeLivenessKind;
}

/**
 * The launch grace verdict travels as a stable identifier rather than prose, so
 * every reader compares one token and the renderer can translate it once at the
 * display boundary. It lives here because both processes need it: the main
 * process writes it, the renderer maps it to text.
 */
export const MEMBER_LAUNCH_GRACE_TIMEOUT_REASON = 'member_launch_grace_timeout';

/**
 * The sentence the identifier replaced. Launch statuses are persisted, so a team
 * whose launch failed before the rename still carries this spelling on disk and
 * every launch-grace reader has to keep recognising it.
 */
export const LEGACY_MEMBER_LAUNCH_GRACE_TIMEOUT_REASON =
  'Teammate did not join within the launch grace window.';

export function isLaunchGraceWindowFailureReason(reason?: string): boolean {
  const text = reason?.trim();
  return (
    text === MEMBER_LAUNCH_GRACE_TIMEOUT_REASON ||
    text === LEGACY_MEMBER_LAUNCH_GRACE_TIMEOUT_REASON
  );
}

export function stripProcessTableUnavailableDiagnosticSuffix(reason: string): string | null {
  const match = /^(.*?);\s*process table (?:is )?unavailable$/i.exec(reason.trim());
  const baseReason = match?.[1]?.trim();
  return baseReason && baseReason.length > 0 ? baseReason : null;
}

export function isProvisionedButNotAliveFailureReason(reason?: string): boolean {
  return isCliProvisionedButNotAliveFailureReason(reason);
}

export function isCliProvisionedButNotAliveFailureReason(reason?: string): boolean {
  const text = reason?.trim();
  if (!text) {
    return false;
  }
  const normalizedText = stripProcessTableUnavailableDiagnosticSuffix(text) ?? text;
  return /^CLI process exited \(code (?:unknown|-?\d+|\?)\)\s+[-\u2013\u2014]\s+team provisioned but not alive$/i.test(
    normalizedText
  );
}

export function mentionsProcessTableUnavailable(value: string | undefined): boolean {
  return /\bprocess table\b.*\bunavailable\b/i.test(value ?? '');
}

export function hasBootstrapConfirmationProofForLaunchFailure(
  entry: ProvisionedButNotAliveLaunchEntry | undefined
): boolean {
  return (
    entry?.bootstrapConfirmed === true ||
    entry?.launchState === 'confirmed_alive' ||
    entry?.livenessKind === 'confirmed_bootstrap'
  );
}

export function isProvisionedButNotAliveLaunchFailure(
  entry: ProvisionedButNotAliveLaunchEntry | undefined
): boolean {
  if (!entry) {
    return false;
  }
  const hardFailureReason = entry.hardFailureReason?.trim();
  const failureReasonMatches = hardFailureReason
    ? isProvisionedButNotAliveFailureReason(hardFailureReason)
    : isProvisionedButNotAliveFailureReason(entry.error ?? entry.runtimeDiagnostic);
  if (!failureReasonMatches) {
    return false;
  }
  return (
    entry.launchState === 'failed_to_start' ||
    entry.status === 'error' ||
    entry.hardFailure === true
  );
}

export function isNativeBootstrapControlLaunchFailure(
  entry: ProvisionedButNotAliveLaunchEntry | undefined
): boolean {
  if (!entry) {
    return false;
  }
  const hardFailureReason = entry.hardFailureReason?.trim();
  const failureReasonMatches = hardFailureReason
    ? isNativeBootstrapControlText(hardFailureReason)
    : isNativeBootstrapControlText(entry.error ?? entry.runtimeDiagnostic);
  if (!failureReasonMatches) {
    return false;
  }
  return (
    entry.launchState === 'failed_to_start' ||
    entry.status === 'error' ||
    entry.hardFailure === true
  );
}

export function isBootstrapConfirmedProvisionedButNotAliveFailure(
  entry: ProvisionedButNotAliveLaunchEntry | undefined
): boolean {
  return (
    (isProvisionedButNotAliveLaunchFailure(entry) ||
      isNativeBootstrapControlLaunchFailure(entry)) &&
    hasBootstrapConfirmationProofForLaunchFailure(entry)
  );
}

export function hasUnsafeProvisionedButNotAliveRuntimeEvidence(
  entry: ProvisionedButNotAliveLaunchEntry | undefined
): boolean {
  if (!entry) {
    return false;
  }
  if (entry.runtimeDiagnosticSeverity === 'error') {
    return true;
  }
  if (
    entry.livenessKind === 'not_found' ||
    entry.livenessKind === 'shell_only' ||
    entry.livenessKind === 'permission_blocked' ||
    entry.livenessKind === 'runtime_process_candidate'
  ) {
    return true;
  }
  const hasProcessTableUnavailableMarker =
    mentionsProcessTableUnavailable(entry.runtimeDiagnostic) ||
    mentionsProcessTableUnavailable(entry.hardFailureReason) ||
    mentionsProcessTableUnavailable(entry.error);
  if (!entry.livenessKind) {
    return !hasProcessTableUnavailableMarker;
  }
  if (entry.livenessKind !== 'registered_only' && entry.livenessKind !== 'stale_metadata') {
    return false;
  }
  return !hasProcessTableUnavailableMarker;
}

export function hasUnsafeProvisionedButNotAliveRuntimeEvidenceWithSpawnContext(
  spawnEntry: ProvisionedButNotAliveLaunchEntry | undefined,
  runtimeEntry: ProvisionedButNotAliveLaunchEntry | undefined
): boolean {
  if (hasUnsafeProvisionedButNotAliveRuntimeEvidence(spawnEntry)) {
    return true;
  }
  if (!runtimeEntry) {
    return false;
  }

  const runtimeDiagnostic = runtimeEntry.runtimeDiagnostic?.trim();
  if (
    !runtimeDiagnostic &&
    (runtimeEntry.livenessKind == null ||
      runtimeEntry.livenessKind === 'registered_only' ||
      runtimeEntry.livenessKind === 'stale_metadata')
  ) {
    return hasUnsafeProvisionedButNotAliveRuntimeEvidence({
      runtimeDiagnostic: spawnEntry?.runtimeDiagnostic,
      hardFailureReason: spawnEntry?.hardFailureReason,
      error: spawnEntry?.error,
      runtimeDiagnosticSeverity: runtimeEntry.runtimeDiagnosticSeverity,
      livenessKind: runtimeEntry.livenessKind,
    });
  }

  return hasUnsafeProvisionedButNotAliveRuntimeEvidence(runtimeEntry);
}
