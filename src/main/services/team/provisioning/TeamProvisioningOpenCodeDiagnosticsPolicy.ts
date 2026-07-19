import {
  isOpenCodeWindowsAccessDeniedDiagnostic,
  normalizeOpenCodeWindowsAccessDeniedDiagnostic,
} from '@shared/utils/openCodeWindowsAccessDenied';

import { isOpenCodeBridgeNoOutputDiagnostic } from '../opencode/bridge/OpenCodeBridgeSupportDiagnostics';
import { isOpenCodeTerminalProbeTechnicalDiagnostic } from '../opencode/readiness/OpenCodeFailureDiagnostics';
import { selectRuntimeDiagnosticClassification } from '../runtime/RuntimeDiagnosticClassifier';
import { createPersistedLaunchSnapshot } from '../TeamLaunchStateEvaluator';

import type { TeamRuntimePrepareResult } from '../runtime';
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
const OPEN_CODE_HTTP_RATE_LIMIT_PATTERN =
  /^\s*(?:error\s*[:=-]?\s*)?429\b|\b(?:http(?:[\s_-]*status)?|status(?:[\s_-]*code)?|error(?:[\s_-]*code)?|code)["']?\s*(?::|=|is|of)?\s*["']?429\b|\b429\s+(?:too many requests|rate limit(?:ed)?|resource exhausted)\b/im;
export const OPENCODE_RUNTIME_BINARY_UNREACHABLE_DIAGNOSTIC =
  'OpenCode runtime binary is not installed or not reachable by launch preflight.';
export const OPENCODE_APP_MCP_UNREACHABLE_DIAGNOSTIC =
  'OpenCode app MCP is unreachable. Retry launch to refresh the app MCP bridge.';

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

export function selectOpenCodeLaunchFailureDiagnostic(
  values: readonly unknown[]
): string | undefined {
  const candidates = values.filter(
    (value): value is string => typeof value === 'string' && value.trim().length > 0
  );
  return selectRuntimeDiagnosticClassification(candidates)?.normalizedMessage ?? undefined;
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
  const normalized = text.toLowerCase();
  return (
    /\bauth(?:entication|orization)?\b/.test(normalized) ||
    normalized.includes('api key') ||
    normalized.includes('unauthorized') ||
    normalized.includes('forbidden') ||
    normalized.includes('invalid_request') ||
    normalized.includes('model not found') ||
    normalized.includes('not found in live opencode catalog') ||
    normalized.includes('provider unavailable') ||
    normalized.includes('quota') ||
    normalized.includes('usage limit') ||
    normalized.includes('freeusagelimit') ||
    normalized.includes('free_usage_limit') ||
    normalized.includes('free-usage-limit') ||
    normalized.includes('resource exhausted') ||
    normalized.includes('resource_exhausted') ||
    normalized.includes('resource-exhausted') ||
    normalized.includes('resourceexhausted') ||
    /\bgrpc[_\s-]*code["']?\s*(?::|=|is)\s*["']?8\b/.test(normalized) ||
    normalized.includes('credits') ||
    normalized.includes('max_tokens') ||
    normalized.includes('rate limit') ||
    normalized.includes('rate_limit') ||
    normalized.includes('rate-limit') ||
    normalized.includes('ratelimiterror') ||
    normalized.includes('too many requests') ||
    OPEN_CODE_HTTP_RATE_LIMIT_PATTERN.test(normalized) ||
    normalized.includes('member removed') ||
    normalized.includes('session conflict') ||
    normalized.includes('run tombstoned') ||
    normalized.includes('stop requested') ||
    normalized.includes('relaunch started')
  );
}

export function looksLikeOpenCodeProviderPrepareDiagnostic(value: string): boolean {
  const lower = value.trim().toLowerCase();
  return (
    isOpenCodeBridgeNoOutputDiagnostic(value) ||
    isOpenCodeWindowsAccessDeniedDiagnostic(value) ||
    lower.includes('opencode /experimental/tool') ||
    lower.includes('/experimental/tool') ||
    lower.includes('mcp_unavailable') ||
    lower.includes('runtime store') ||
    lower.includes('opencode cli') ||
    lower.includes('opencode runtime binary') ||
    lower.includes('unable to connect')
  );
}

export function normalizeOpenCodePrepareDiagnostic(value: string, reason?: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return trimmed;
  }

  if (isOpenCodeBridgeNoOutputDiagnostic(trimmed)) {
    return 'OpenCode runtime check returned no output.';
  }

  const accessDeniedDiagnostic = normalizeOpenCodeWindowsAccessDeniedDiagnostic(trimmed);
  if (accessDeniedDiagnostic) {
    return accessDeniedDiagnostic;
  }

  if (/opencode cli (?:not detected on path|not found)/i.test(trimmed)) {
    return OPENCODE_RUNTIME_BINARY_UNREACHABLE_DIAGNOSTIC;
  }

  const lower = trimmed.toLowerCase();
  if (
    lower.includes('unable to connect') &&
    (lower.includes('/experimental/tool') ||
      lower.includes('mcp_unavailable') ||
      reason === 'mcp_unavailable')
  ) {
    const detail = trimmed.includes(' - ') ? trimmed.split(' - ').pop()?.trim() : trimmed;
    return detail && detail !== trimmed
      ? `${OPENCODE_APP_MCP_UNREACHABLE_DIAGNOSTIC} Details: ${detail}`
      : OPENCODE_APP_MCP_UNREACHABLE_DIAGNOSTIC;
  }

  if (reason === 'mcp_unavailable' && lower.includes('mcp_unavailable')) {
    return 'OpenCode app MCP is unavailable. Retry launch to refresh the app MCP bridge.';
  }

  return trimmed;
}

export function isRetryableOpenCodePreflightBusyDiagnostic(
  value: string | null | undefined
): boolean {
  const lower = value?.trim().toLowerCase() ?? '';
  if (!lower) {
    return false;
  }
  // Fact: these diagnostics report OpenCode host/session occupancy, not that
  // the selected model is unavailable or rejected by the provider.
  return (
    lower.includes('opencode session status busy') ||
    lower.includes('session status busy') ||
    lower === 'provider busy' ||
    lower.includes('provider busy')
  );
}

export function isOpenCodeModelVerificationTimeoutDiagnostic(
  value: string | null | undefined
): boolean {
  const lower = value?.trim().toLowerCase() ?? '';
  return lower.includes('model verification timed out');
}

export function selectOpenCodePrepareProviderDiagnostic(
  prepare: Pick<TeamRuntimePrepareResult, 'diagnostics' | 'warnings'>
): string | undefined {
  return [...prepare.diagnostics, ...prepare.warnings].find((entry) =>
    looksLikeOpenCodeProviderPrepareDiagnostic(entry)
  );
}

export function selectOpenCodeModelPreparePrimaryReason(
  prepare: Extract<TeamRuntimePrepareResult, { ok: false }>
): string {
  const providerDiagnostic = selectOpenCodePrepareProviderDiagnostic(prepare);
  if (providerDiagnostic) {
    return providerDiagnostic;
  }

  const candidates = [...prepare.diagnostics, prepare.reason]
    .map((entry) => entry?.trim() ?? '')
    .filter(Boolean);
  const timeoutReason = candidates.find(isOpenCodeModelVerificationTimeoutDiagnostic);
  return timeoutReason ?? candidates[0] ?? prepare.reason;
}

export function isOpenCodeModelPrepareBusyDeferred(
  prepare: Extract<TeamRuntimePrepareResult, { ok: false }>,
  primaryReason: string
): boolean {
  const candidates = [primaryReason, prepare.reason, ...prepare.diagnostics, ...prepare.warnings];
  return (
    prepare.retryable &&
    !candidates.some(isOpenCodeModelVerificationTimeoutDiagnostic) &&
    candidates.some(isRetryableOpenCodePreflightBusyDiagnostic)
  );
}

export function buildOpenCodeProviderVerificationDeferredLine(reason: string): string {
  const normalizedReason = isRetryableOpenCodePreflightBusyDiagnostic(reason)
    ? 'OpenCode is currently busy with another session. Deep model verification will retry when OpenCode is idle.'
    : reason;
  return normalizedReason;
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
    normalized === 'model_unavailable' ||
    normalized === 'not_authenticated' ||
    normalized === 'mcp_unavailable' ||
    normalized === 'unknown_error' ||
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
    normalized?.startsWith('OpenCode command timed out after') === true ||
    normalized?.startsWith('CLI-authenticated providers missing from live host') === true ||
    normalized?.startsWith('OpenCode session status') === true ||
    isOpenCodeTerminalProbeTechnicalDiagnostic(normalized ?? '') ||
    (normalized?.startsWith('opencode_app_mcp_tool_proof_') === true &&
      normalized.includes('cache_hit')) ||
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
  const candidates = (member.diagnostics ?? [])
    .map(normalizeOpenCodePersistedFailureReason)
    .filter(
      (value): value is string => Boolean(value) && !isGenericOpenCodePersistedFailureReason(value)
    );
  return selectRuntimeDiagnosticClassification(candidates)?.normalizedMessage ?? undefined;
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
