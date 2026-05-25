import { createPersistedLaunchSnapshot } from '../TeamLaunchStateEvaluator';

import type { PersistedTeamLaunchMemberState, PersistedTeamLaunchSnapshot } from '@shared/types';

export const OPENCODE_UNCOMMITTED_BOOTSTRAP_DIAGNOSTIC =
  'OpenCode bridge reported bootstrap confirmation, but no lane runtime evidence was committed.';

const OPEN_CODE_GENERIC_MEMBER_LAUNCH_FAILURE_REASON =
  'OpenCode bridge reported member launch failure';
const OPEN_CODE_SECRET_FLAG_PATTERN =
  /(--(?:api-key|token|password|secret|authorization|auth-token)(?:=|\s+))("[^"]*"|'[^']*'|\S+)/gi;
const OPEN_CODE_BEARER_TOKEN_PATTERN = /\bBearer\s+[A-Z0-9._~+/=-]+/gi;
const OPEN_CODE_SECRET_KEY_PATTERN = /\bsk-[A-Za-z0-9_-]{16,}\b/g;
const OPEN_CODE_APP_MANAGED_BRIEFING_MAX_CHARS = 12_000;

function nowIso(): string {
  return new Date().toISOString();
}

export function isPersistedOpenCodeSecondaryLaneMember(
  member: PersistedTeamLaunchMemberState | undefined | null
): boolean {
  return (
    member?.providerId === 'opencode' &&
    member.laneKind === 'secondary' &&
    member.laneOwnerProviderId === 'opencode' &&
    typeof member.laneId === 'string' &&
    member.laneId.trim().length > 0
  );
}

export function hasStaleOpenCodeSecondaryLaunchDiagnostic(
  member: PersistedTeamLaunchMemberState
): boolean {
  return hasStaleOpenCodeDiagnostics(getOpenCodeLaunchDiagnosticValues(member));
}

export function hasRealOpenCodeLaunchDiagnostic(member: PersistedTeamLaunchMemberState): boolean {
  const text = getOpenCodeLaunchDiagnosticValues(member)
    .filter((value): value is string => typeof value === 'string')
    .join('\n')
    .toLowerCase();
  return text.length > 0 && hasRealOpenCodeFailureDiagnostic(text);
}

export function getOpenCodeLaunchDiagnosticValues(
  member: PersistedTeamLaunchMemberState
): readonly unknown[] {
  return [member.hardFailureReason, member.runtimeDiagnostic, ...(member.diagnostics ?? [])];
}

export function hasStaleOpenCodeDiagnostics(values: readonly unknown[] | undefined): boolean {
  const text = (values ?? [])
    .filter((value): value is string => typeof value === 'string')
    .join('\n')
    .toLowerCase();
  if (!text) {
    return false;
  }
  if (hasRealOpenCodeFailureDiagnostic(text)) {
    return false;
  }
  return (
    text.includes('no lane runtime evidence') ||
    text.includes('no runtime evidence') ||
    text.includes('runtime evidence was not committed') ||
    text.includes('no lane runtime evidence was committed') ||
    text.includes('registered runtime metadata without live process') ||
    text.includes('member has persisted runtime metadata only') ||
    text.includes('opencode bridge reported member launch failure') ||
    text.includes('file lock timeout') ||
    text.includes(OPENCODE_UNCOMMITTED_BOOTSTRAP_DIAGNOSTIC.toLowerCase())
  );
}

export function isFileLockTimeoutError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.toLowerCase().includes('file lock timeout');
}

export function hasRealOpenCodeFailureDiagnostic(text: string): boolean {
  return (
    /\bauth(?:entication|orization)?\b/.test(text) ||
    text.includes('api key') ||
    text.includes('unauthorized') ||
    text.includes('forbidden') ||
    text.includes('invalid_request') ||
    text.includes('model not found') ||
    text.includes('not found in live opencode catalog') ||
    text.includes('provider unavailable') ||
    text.includes('quota') ||
    text.includes('credits') ||
    text.includes('max_tokens') ||
    text.includes('rate limit') ||
    text.includes('member removed') ||
    text.includes('session conflict') ||
    text.includes('run tombstoned') ||
    text.includes('stop requested') ||
    text.includes('relaunch started')
  );
}

export function normalizeOpenCodePersistedFailureReason(
  value: string | undefined
): string | undefined {
  const trimmed = value?.replace(/\s+/g, ' ').trim();
  if (!trimmed) {
    return undefined;
  }
  return trimmed
    .replace(OPEN_CODE_SECRET_FLAG_PATTERN, '$1[redacted]')
    .replace(OPEN_CODE_BEARER_TOKEN_PATTERN, 'Bearer [redacted]')
    .replace(OPEN_CODE_SECRET_KEY_PATTERN, '[redacted-api-key]');
}

export function redactOpenCodeAppManagedContextText(value: string): string {
  return value
    .replace(OPEN_CODE_SECRET_FLAG_PATTERN, '$1[redacted]')
    .replace(OPEN_CODE_BEARER_TOKEN_PATTERN, 'Bearer [redacted]')
    .replace(OPEN_CODE_SECRET_KEY_PATTERN, '[redacted-api-key]');
}

export function boundOpenCodeAppManagedBriefingText(value: string): string {
  const normalized = redactOpenCodeAppManagedContextText(value.replace(/\r\n/g, '\n')).trim();
  if (normalized.length <= OPEN_CODE_APP_MANAGED_BRIEFING_MAX_CHARS) {
    return normalized;
  }
  return `${normalized.slice(0, OPEN_CODE_APP_MANAGED_BRIEFING_MAX_CHARS)}\n[truncated app-managed briefing]`;
}

export function isGenericOpenCodePersistedFailureReason(value: string | undefined): boolean {
  const normalized = normalizeOpenCodePersistedFailureReason(value);
  return (
    normalized === OPEN_CODE_GENERIC_MEMBER_LAUNCH_FAILURE_REASON ||
    normalized?.startsWith(`${OPEN_CODE_GENERIC_MEMBER_LAUNCH_FAILURE_REASON}:`) === true ||
    normalized?.startsWith('OpenCode secondary lane timing:') === true ||
    normalized?.startsWith(
      'OpenCode bridge reported ready without all required durable checkpoints:'
    ) === true ||
    normalized?.startsWith(
      'OpenCode bridge reported ready before all expected members were confirmed:'
    ) === true ||
    normalized?.startsWith(
      'OpenCode bootstrap MCP did not complete required tools before assistant response:'
    ) === true ||
    normalized?.startsWith('info:opencode_launch_member_timing:') === true ||
    normalized?.startsWith('info:opencode_launch_total_timing:') === true
  );
}

export function selectOpenCodePersistedFailureReasonFromDiagnostics(
  member: PersistedTeamLaunchMemberState
): string | undefined {
  if (!isPersistedOpenCodeSecondaryLaneMember(member)) {
    return undefined;
  }
  if (member.launchState !== 'failed_to_start' || member.hardFailure !== true) {
    return undefined;
  }
  if (!isGenericOpenCodePersistedFailureReason(member.hardFailureReason)) {
    return undefined;
  }
  for (const value of member.diagnostics ?? []) {
    const normalized = normalizeOpenCodePersistedFailureReason(value);
    if (!normalized || isGenericOpenCodePersistedFailureReason(normalized)) {
      continue;
    }
    return normalized;
  }
  return undefined;
}

export function promoteOpenCodePersistedFailureReasonsFromDiagnostics(
  snapshot: PersistedTeamLaunchSnapshot | null
): PersistedTeamLaunchSnapshot | null {
  if (!snapshot) {
    return null;
  }
  let changed = false;
  const members: Record<string, PersistedTeamLaunchMemberState> = { ...snapshot.members };
  for (const [memberName, member] of Object.entries(snapshot.members)) {
    const promotedReason = selectOpenCodePersistedFailureReasonFromDiagnostics(member);
    if (!promotedReason || promotedReason === member.hardFailureReason) {
      continue;
    }
    members[memberName] = {
      ...member,
      hardFailureReason: promotedReason,
      runtimeDiagnostic:
        member.runtimeDiagnostic &&
        !isGenericOpenCodePersistedFailureReason(member.runtimeDiagnostic)
          ? member.runtimeDiagnostic
          : promotedReason,
      runtimeDiagnosticSeverity: member.runtimeDiagnosticSeverity ?? 'error',
    };
    changed = true;
  }
  if (!changed) {
    return snapshot;
  }
  return createPersistedLaunchSnapshot({
    teamName: snapshot.teamName,
    expectedMembers: snapshot.expectedMembers,
    bootstrapExpectedMembers: snapshot.bootstrapExpectedMembers,
    leadSessionId: snapshot.leadSessionId,
    launchPhase: snapshot.launchPhase,
    members,
    updatedAt: nowIso(),
  });
}

export function filterStaleOpenCodeOverlayDiagnostics(
  values: readonly string[] | undefined
): string[] {
  return (values ?? []).filter((value) => !hasStaleOpenCodeDiagnostics([value]));
}
