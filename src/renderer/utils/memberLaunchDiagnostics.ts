import { isHealthyOpenCodeAppMcpConnectivityAdvisory } from './openCodeAdvisoryHealth';

import type {
  MemberLaunchState,
  MemberRuntimeAdvisory,
  MemberSpawnLivenessSource,
  MemberSpawnStatus,
  MemberSpawnStatusEntry,
  TeamAgentRuntimeDiagnosticSeverity,
  TeamAgentRuntimeEntry,
  TeamAgentRuntimeLivenessKind,
  TeamAgentRuntimePidSource,
} from '@shared/types';

export interface MemberLaunchDiagnosticsPayload {
  teamName?: string;
  runId?: string;
  memberName: string;
  providerId?: string;
  providerBackendId?: string;
  model?: string;
  runtimeModel?: string;
  agentType?: string;
  laneId?: string;
  laneKind?: 'primary' | 'secondary';
  laneOwnerProviderId?: string;
  removedAt?: number;
  memberCardError?: string;
  launchState?: MemberLaunchState;
  spawnStatus?: MemberSpawnStatus;
  backendType?: string;
  alive?: boolean;
  restartable?: boolean;
  runtimeAlive?: boolean;
  bootstrapConfirmed?: boolean;
  agentToolAccepted?: boolean;
  hardFailure?: boolean;
  livenessKind?: TeamAgentRuntimeLivenessKind;
  livenessSource?: MemberSpawnLivenessSource;
  pid?: number;
  pidSource?: TeamAgentRuntimePidSource;
  paneId?: string;
  panePid?: number;
  paneCurrentCommand?: string;
  processCommand?: string;
  runtimePid?: number;
  runtimeSessionId?: string;
  runtimeLeaseExpiresAt?: string;
  runtimeLastSeenAt?: string;
  historicalBootstrapConfirmed?: boolean;
  cwd?: string;
  rssBytes?: number;
  runtimeDiagnostic?: string;
  runtimeDiagnosticSeverity?: TeamAgentRuntimeDiagnosticSeverity;
  runtimeAdvisoryKind?: MemberRuntimeAdvisory['kind'];
  runtimeAdvisoryReasonCode?: MemberRuntimeAdvisory['reasonCode'];
  runtimeAdvisoryObservedAt?: string;
  runtimeAdvisoryRetryUntil?: string;
  runtimeAdvisoryRetryDelayMs?: number;
  bootstrapStalled?: boolean;
  pendingPermissionRequestIds?: string[];
  firstSpawnAcceptedAt?: string;
  lastHeartbeatAt?: string;
  livenessLastCheckedAt?: string;
  probableCause?: string;
  diagnosticHints?: string[];
  diagnostics?: string[];
  spawnUpdatedAt?: string;
  runtimeUpdatedAt?: string;
  updatedAt?: string;
}

const MAX_DIAGNOSTIC_STRING_LENGTH = 500;
const MAX_DIAGNOSTIC_ITEMS = 20;
const MAX_PERMISSION_REQUEST_IDS = 10;
const SECRET_FLAG_PATTERN =
  /(--(?:api-key|token|password|secret|authorization|auth-token)(?:=|\s+))("[^"]*"|'[^']*'|\S+)/gi;
const SECRET_VALUE_PATTERNS: [RegExp, string][] = [
  [/\bsk-\S{12,}\b/gi, '[redacted]'],
  [/\b[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\b/g, '[redacted]'],
];
const SECRET_ENV_KEY_PARTS = [
  'API_KEY',
  'AUTH_TOKEN',
  'TOKEN',
  'SECRET',
  'PASSWORD',
  'AUTHORIZATION',
];
const OPENCODE_SESSION_REFRESH_REASON_MARKERS = [
  'resolved_behavior_changed',
  'opencode_app_mcp_transport_changed',
] as const;
const OPENCODE_SESSION_REFRESH_REASON_CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789._~/=->';
const OPENCODE_SESSION_REFRESH_FAILURE_PATTERN =
  // eslint-disable-next-line sonarjs/regex-complexity -- Keyword taxonomy is kept literal to preserve diagnostic behavior.
  /(?:^|[_\s:;.\/()-])(?:permission[_\s-]?denied|permission[_\s-]?blocked|access[_\s-]?denied|auth[_\s-]?unavailable|authentication[_\s-]?failed|unauthorized|forbidden|401|403|login[_\s-]?required|not\s+logged\s+in|missing\s+credentials?|invalid\s+credentials?|credentials?[_\s-]?required|credentials?[_\s-]?unavailable|no auth available|authorization|auth(?:entication)?(?:[_\s-]?(?:failed|unavailable))?|invalid api[_\s-]?key|api[_\s-]?key|does not have access|quota|rate[_\s-]?(?:limit|limited)|too many requests|429|model cooldown|cooling down|enospc|no space left|disk is full|capacity exceeded|quota exhausted|usage exceeded|free usage exceeded|key limit exceeded|total limit|insufficient credits|subscribe to go|error|failed|failure|timeout|timed\s+out|network|connection|unable\s+to\s+connect|connect\s+failed|econn[a-z_]*|enotfound|fetch[_\s-]?failed|connection[_\s-]?(?:refused|reset)|aborted|cancel(?:ed|led)|interrupted|service[_\s-]?unavailable|temporarily\s+unavailable|overloaded|visible[_\s-]?reply(?:[_\s-][a-z0-9]+)*|task[_\s-]?refs|relayofmessageid|relay[_\s-]?of[_\s-]?message[_\s-]?id|message[_\s-]?send|non[_\s-]?visible[_\s-]?tool(?:[_\s-][a-z0-9]+)*|protocol[_\s-]?proof)(?=$|[_\s:;.\/(),-])/i;
const OPENCODE_SESSION_REFRESH_SAFE_MARKER_STATE_PATTERN =
  /\b(?:not_observed|pending|prompt_not_indexed|responded_tool_call|responded_visible_message|responded_non_visible_tool|responded_plain_text|permission_blocked|tool_error|empty_assistant_turn|prompt_delivered_no_assistant_message|session_stale|session_error|reconcile_failed)\b/g;

type MemberSpawnStatusCollection =
  | Record<string, MemberSpawnStatusEntry>
  | Map<string, MemberSpawnStatusEntry>
  | undefined;

interface MemberDiagnosticsMemberLike {
  name: string;
  providerId?: string;
  providerBackendId?: string;
  model?: string;
  agentType?: string;
  laneId?: string;
  laneKind?: 'primary' | 'secondary';
  laneOwnerProviderId?: string;
  removedAt?: number;
}

function boundedString(
  value: string | undefined,
  maxLength = MAX_DIAGNOSTIC_STRING_LENGTH
): string | undefined {
  const trimmed = value?.replace(/\s+/g, ' ').trim();
  if (!trimmed) return undefined;
  const redacted = redactDiagnosticEnvAssignments(
    SECRET_VALUE_PATTERNS.reduce(
      (current, [pattern, replacement]) => current.replace(pattern, replacement),
      trimmed.replace(SECRET_FLAG_PATTERN, '$1[redacted]')
    )
  );
  return redacted.length > maxLength
    ? `${redacted.slice(0, Math.max(0, maxLength - 3))}...`
    : redacted;
}

function redactDiagnosticEnvAssignments(value: string): string {
  return value.replace(/\b[A-Z0-9_]+\s*=\s*("[^"]*"|'[^']*'|\S+)/gi, (assignment) => {
    const separatorIndex = assignment.indexOf('=');
    const key = assignment.slice(0, separatorIndex).trim().toUpperCase();
    return SECRET_ENV_KEY_PARTS.some((part) => key.includes(part)) ? '[redacted]' : assignment;
  });
}

function boundedNumber(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.trunc(value)
    : undefined;
}

function boundedStringArray(
  values: readonly string[] | undefined,
  limit = MAX_PERMISSION_REQUEST_IDS
): string[] | undefined {
  const result = values
    ?.map((value) => boundedString(value, 160))
    .filter((value): value is string => Boolean(value))
    .slice(0, limit);
  return result && result.length > 0 ? result : undefined;
}

function maybeString(value: string | undefined): string | undefined {
  return boundedString(value, 240);
}

function isRuntimeDiagnosticCardError(params: {
  runtimeDiagnostic?: string;
  runtimeDiagnosticSeverity?: TeamAgentRuntimeDiagnosticSeverity;
  launchState?: MemberLaunchState;
  spawnStatus?: MemberSpawnStatus;
  hardFailure?: boolean;
  providerId?: string;
}): boolean {
  if (!params.runtimeDiagnostic) {
    return false;
  }
  if (params.runtimeDiagnosticSeverity === 'info') {
    return false;
  }
  if (
    params.providerId === 'opencode' &&
    isRecoverableOpenCodeSessionRefreshText(params.runtimeDiagnostic)
  ) {
    return false;
  }
  return (
    params.runtimeDiagnosticSeverity === 'error' ||
    params.launchState === 'failed_to_start' ||
    params.spawnStatus === 'error' ||
    params.hardFailure === true
  );
}

function isRecoverableOpenCodeSessionRefreshText(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase() ?? '';
  const refreshText = stripOpenCodeGenericApiErrorPrefix(normalized);
  const refreshMarkerText = refreshText.replace(/[.:\s-]+$/, '');
  if (
    refreshMarkerText === 'session_stale' ||
    refreshMarkerText === 'opencode session refresh' ||
    refreshMarkerText === 'opencode session changed; refreshing the session before retry' ||
    refreshMarkerText === 'opencode session refresh scheduled after resolved behavior changed' ||
    refreshMarkerText === 'opencode_prompt_delivery_session_refresh_scheduled' ||
    refreshMarkerText === 'opencode_session_refresh_scheduled_after_resolved_behavior_changed'
  ) {
    return true;
  }
  const reasonRanges = findOpenCodeSessionRefreshReasonRanges(refreshText);
  if (reasonRanges.length === 0) {
    return false;
  }
  const markerText = refreshText;
  if (hasOpenCodeSessionRefreshFailureConflict(markerText)) {
    return false;
  }
  const rawRemainder = removeOpenCodeSessionRefreshReasonRanges(markerText, reasonRanges);
  const remainder = rawRemainder.replace(/[().,;:\s-]+/g, '');
  if (remainder.length === 0) {
    return true;
  }
  const staleLogProjectionContext =
    normalized.includes('session is stale') ||
    normalized.includes('stored session is stale') ||
    normalized.includes('session reconcile skipped');
  return staleLogProjectionContext && isBenignOpenCodeSessionRefreshRemainder(rawRemainder);
}

function stripOpenCodeGenericApiErrorPrefix(message: string): string {
  return message.replace(/^opencode api error(?:[.:\s-]+|$)/i, '');
}

function findOpenCodeSessionRefreshReasonRanges(text: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  for (const marker of OPENCODE_SESSION_REFRESH_REASON_MARKERS) {
    const prefix = `${marker}:`;
    let searchFrom = 0;
    while (searchFrom < text.length) {
      const markerStart = text.indexOf(prefix, searchFrom);
      if (markerStart < 0) {
        break;
      }
      const tokenStart = markerStart + prefix.length;
      const tokenEnd = findOpenCodeSessionRefreshReasonTokenEnd(text, tokenStart);
      if (tokenEnd !== null) {
        ranges.push([markerStart, tokenEnd]);
      }
      searchFrom = Math.max(tokenStart + 1, tokenEnd ?? tokenStart);
    }
  }
  return ranges.sort(([left], [right]) => left - right);
}

function findOpenCodeSessionRefreshReasonTokenEnd(text: string, start: number): number | null {
  let end = start;
  while (end < text.length && OPENCODE_SESSION_REFRESH_REASON_CHARS.includes(text[end] ?? '')) {
    end += 1;
  }

  const token = text.slice(start, end);
  const arrowIndex = token.indexOf('->');
  if (arrowIndex <= 0 || arrowIndex >= token.length - 2) {
    return null;
  }
  return end;
}

function removeOpenCodeSessionRefreshReasonRanges(
  text: string,
  ranges: ReadonlyArray<[number, number]>
): string {
  let result = text;
  for (const [start, end] of [...ranges].sort(([left], [right]) => right - left)) {
    result = `${result.slice(0, start)}${result.slice(end)}`;
  }
  return result;
}

function isBenignOpenCodeSessionRefreshRemainder(rawRemainder: string): boolean {
  if (OPENCODE_SESSION_REFRESH_FAILURE_PATTERN.test(rawRemainder)) {
    return false;
  }
  const normalized = rawRemainder.replace(/[().,;:\s-]+/g, ' ').trim();
  return (
    normalized === 'opencode session is stale' ||
    normalized ===
      'opencode session is stale reading historical messages for log projection only' ||
    normalized === 'opencode session reconcile skipped because the stored session is stale' ||
    normalized === 'stored session is stale'
  );
}

function hasOpenCodeSessionRefreshFailureConflict(value: string): boolean {
  return OPENCODE_SESSION_REFRESH_FAILURE_PATTERN.test(
    value.replace(OPENCODE_SESSION_REFRESH_SAFE_MARKER_STATE_PATTERN, 'state')
  );
}

function isGenericOpenCodeApiErrorText(value: string | undefined): boolean {
  const normalized =
    value
      ?.trim()
      .toLowerCase()
      .replace(/[.:\s-]+$/, '') ?? '';
  return normalized === 'opencode api error';
}

function isBenignOpenCodeRefreshContextText(value: string | undefined): boolean {
  const normalized =
    value
      ?.trim()
      .toLowerCase()
      .replace(/[.:\s-]+$/, '') ?? '';
  return (
    !normalized ||
    isRecoverableOpenCodeSessionRefreshText(normalized) ||
    isGenericOpenCodeApiErrorText(normalized) ||
    normalized === 'matched opencode runtime pid and process identity' ||
    normalized === 'bootstrap confirmed' ||
    normalized === 'opencode runtime process detected after bootstrap confirmation'
  );
}

function hasCleanRecoverableOpenCodeRefreshContext(
  values: readonly (string | undefined)[]
): boolean {
  const normalizedValues = values
    .map((value) => value?.trim())
    .filter((value): value is string => Boolean(value));
  return (
    normalizedValues.some(isRecoverableOpenCodeSessionRefreshText) &&
    normalizedValues.every(isBenignOpenCodeRefreshContextText)
  );
}

function isRuntimeAdvisoryCardError(
  runtimeAdvisory: MemberRuntimeAdvisory | undefined,
  providerId: string | undefined
): boolean {
  if (providerId === 'opencode' && isRecoverableOpenCodeSessionRefreshAdvisory(runtimeAdvisory)) {
    return false;
  }
  return (
    runtimeAdvisory?.kind === 'api_error' && runtimeAdvisory.reasonCode !== 'protocol_proof_missing'
  );
}

function isRecoverableOpenCodeSessionRefreshAdvisory(
  runtimeAdvisory: MemberRuntimeAdvisory | undefined
): boolean {
  return (
    Boolean(runtimeAdvisory) &&
    (runtimeAdvisory?.reasonCode == null ||
      runtimeAdvisory.reasonCode === 'backend_error' ||
      runtimeAdvisory.reasonCode === 'unknown') &&
    isRecoverableOpenCodeSessionRefreshText(runtimeAdvisory?.message)
  );
}

export function normalizeMemberLaunchFailureReason(value: string | undefined): string | null {
  const normalized = value
    ?.replace(/\s+/g, ' ')
    .trim()
    .replace(/^Latest assistant message\s+\S+\s+failed with APIError\s*[-:]\s*/i, '')
    .replace(/^APIError\s*[-:]\s*/i, '');
  return normalized && normalized.length > 0 ? normalized : null;
}

function firstMemberCardFailureReason(input: {
  candidates: (string | undefined)[];
  evidence?: readonly (string | undefined)[];
  providerId?: string;
}): string | undefined {
  const hasCleanRecoverableOpenCodeRefresh =
    input.providerId === 'opencode' &&
    hasCleanRecoverableOpenCodeRefreshContext([...input.candidates, ...(input.evidence ?? [])]);
  for (const value of input.candidates) {
    const normalized = normalizeMemberLaunchFailureReason(value);
    if (
      !normalized ||
      (hasCleanRecoverableOpenCodeRefresh &&
        input.providerId === 'opencode' &&
        isRecoverableOpenCodeSessionRefreshText(normalized)) ||
      (hasCleanRecoverableOpenCodeRefresh && isGenericOpenCodeApiErrorText(normalized))
    ) {
      continue;
    }
    return boundedString(normalized);
  }
  return undefined;
}

function uniqueDiagnostics(
  ...groups: (readonly (string | undefined)[] | undefined)[]
): string[] | undefined {
  const seen = new Set<string>();
  const diagnostics: string[] = [];
  for (const group of groups) {
    for (const item of group ?? []) {
      const normalized = boundedString(item);
      if (!normalized || seen.has(normalized)) continue;
      seen.add(normalized);
      diagnostics.push(normalized);
      if (diagnostics.length >= MAX_DIAGNOSTIC_ITEMS) {
        return diagnostics;
      }
    }
  }
  return diagnostics.length > 0 ? diagnostics : undefined;
}

function textIncludesAny(text: string, needles: readonly string[]): boolean {
  return needles.some((needle) => text.includes(needle));
}

function buildDiagnosticHints(input: {
  memberCardError?: string;
  runtimeDiagnostic?: string;
  diagnostics?: readonly string[];
  livenessKind?: TeamAgentRuntimeLivenessKind;
  launchState?: MemberLaunchState;
  spawnStatus?: MemberSpawnStatus;
  providerId?: string;
}): string[] | undefined {
  const text = [input.memberCardError, input.runtimeDiagnostic, ...(input.diagnostics ?? [])]
    .filter((item): item is string => Boolean(item))
    .join('\n')
    .toLowerCase();
  const openCodeRefreshEvidenceContext = [input.runtimeDiagnostic, ...(input.diagnostics ?? [])];
  const hasCleanRecoverableOpenCodeRefreshEvidence =
    input.providerId === 'opencode' &&
    hasCleanRecoverableOpenCodeRefreshContext(openCodeRefreshEvidenceContext);
  const hints: string[] = [];

  if (textIncludesAny(text, ['reason=query_active', 'queryguardstatus=running'])) {
    hints.push(
      'Bootstrap submit was rejected because the teammate REPL already had a running query.'
    );
  }
  if (textIncludesAny(text, ['queryguardstatus=dispatching'])) {
    hints.push(
      'Bootstrap submit collided with a queued prompt dispatch before the model turn started.'
    );
  }
  if (
    textIncludesAny(text, [
      'reason=command_queue_busy',
      'commandqueuemodes=prompt',
      'commandqueuemodes=bash',
    ])
  ) {
    hints.push(
      'Bootstrap submit was rejected because local prompt/bash command queue was not empty.'
    );
  }
  if (
    textIncludesAny(text, ['bootstrap_submit_rejected', 'submit rejected by local prompt handler'])
  ) {
    hints.push(
      'The teammate process observed bootstrap mail, but local prompt submission did not accept the bootstrap turn.'
    );
  }
  if (
    textIncludesAny(text, [
      'did not bootstrap-confirm',
      'bootstrap-confirm before timeout',
      'bootstrap was not confirmed',
      'last transport stage: bootstrap_submitted',
    ])
  ) {
    hints.push(
      'Bootstrap prompt was submitted, but teammate did not bootstrap-confirm before timeout.'
    );
  }
  if (
    textIncludesAny(text, [
      'did not submit bootstrap prompt',
      'timed out waiting for bootstrap_submitted',
    ])
  ) {
    hints.push('Parent process timed out waiting for durable bootstrap_submitted evidence.');
  }
  if (textIncludesAny(text, ['no stdin data received in 3s'])) {
    hints.push(
      'CLI read empty stdin before bootstrap submit; verify headless teammate runtime flag/env and startup input handling.'
    );
  }
  if (
    input.livenessKind === 'stale_metadata' ||
    textIncludesAny(text, ['persisted runtime pid is not alive'])
  ) {
    hints.push(
      'Persisted runtime pid is dead; this is post-failure liveness, not the original root cause.'
    );
  }
  if (
    (input.launchState === 'failed_to_start' || input.spawnStatus === 'error') &&
    !(hasCleanRecoverableOpenCodeRefreshEvidence && !input.memberCardError)
  ) {
    hints.push(
      'Launch state is terminal for this run; restart/relaunch is required after fixing the cause.'
    );
  }

  return hints.length > 0 ? [...new Set(hints)].slice(0, 8) : undefined;
}

function buildProbableCause(hints: readonly string[] | undefined): string | undefined {
  return hints?.[0];
}

export function buildMemberLaunchDiagnosticsPayload(params: {
  teamName?: string | null;
  runId?: string | null;
  memberName: string;
  member?: MemberDiagnosticsMemberLike;
  spawnStatus?: MemberSpawnStatus;
  launchState?: MemberLaunchState;
  livenessSource?: MemberSpawnLivenessSource;
  spawnEntry?: MemberSpawnStatusEntry;
  runtimeEntry?: TeamAgentRuntimeEntry;
  runtimeAdvisory?: MemberRuntimeAdvisory;
  runtimeAdvisoryLabel?: string | null;
  runtimeAdvisoryTitle?: string;
}): MemberLaunchDiagnosticsPayload {
  const spawnEntry = params.spawnEntry;
  const runtimeEntry = params.runtimeEntry;
  const runtimeAdvisory = params.runtimeAdvisory;
  const providerId = runtimeEntry?.providerId ?? params.member?.providerId;
  const providerBackendId = runtimeEntry?.providerBackendId ?? params.member?.providerBackendId;
  const laneId = runtimeEntry?.laneId ?? params.member?.laneId;
  const laneKind = runtimeEntry?.laneKind ?? params.member?.laneKind;
  const livenessKind = spawnEntry?.livenessKind ?? runtimeEntry?.livenessKind;
  const launchState = spawnEntry?.launchState ?? params.launchState;
  const spawnStatus = spawnEntry?.status ?? params.spawnStatus;
  const runtimeAdvisoryTitle = boundedString(params.runtimeAdvisoryTitle);
  const runtimeAdvisoryLabel = boundedString(params.runtimeAdvisoryLabel ?? undefined);
  const runtimeAdvisoryMessage = boundedString(runtimeAdvisory?.message);
  const suppressOpenCodeAppMcpAdvisory = isHealthyOpenCodeAppMcpConnectivityAdvisory({
    providerId,
    runtimeAdvisory,
    runtimeAdvisoryLabel,
    runtimeAdvisoryTitle,
    runtimeAdvisoryMessage,
    spawnStatus,
    launchState,
    runtimeAlive: spawnEntry?.runtimeAlive,
    bootstrapConfirmed: spawnEntry?.bootstrapConfirmed,
    agentToolAccepted: spawnEntry?.agentToolAccepted,
    hardFailure: spawnEntry?.hardFailure,
    livenessKind,
    runtimeEntry,
  });
  const runtimeAdvisoryCardError =
    !suppressOpenCodeAppMcpAdvisory && isRuntimeAdvisoryCardError(runtimeAdvisory, providerId)
      ? (runtimeAdvisoryTitle ?? runtimeAdvisoryLabel ?? runtimeAdvisoryMessage)
      : undefined;
  const runtimeDiagnosticSeverity =
    spawnEntry?.runtimeDiagnosticSeverity ?? runtimeEntry?.runtimeDiagnosticSeverity;
  const spawnRuntimeDiagnosticCardError = isRuntimeDiagnosticCardError({
    runtimeDiagnostic: spawnEntry?.runtimeDiagnostic,
    runtimeDiagnosticSeverity: spawnEntry?.runtimeDiagnosticSeverity,
    launchState: spawnEntry?.launchState,
    spawnStatus: spawnEntry?.status,
    hardFailure: spawnEntry?.hardFailure,
    providerId,
  })
    ? spawnEntry?.runtimeDiagnostic
    : undefined;
  const runtimeEntryDiagnosticCardError = isRuntimeDiagnosticCardError({
    runtimeDiagnostic: runtimeEntry?.runtimeDiagnostic,
    runtimeDiagnosticSeverity: runtimeEntry?.runtimeDiagnosticSeverity,
    providerId,
  })
    ? runtimeEntry?.runtimeDiagnostic
    : undefined;
  const runtimeDiagnostic =
    boundedString(spawnEntry?.runtimeDiagnostic) ??
    boundedString(runtimeEntry?.runtimeDiagnostic) ??
    boundedString(spawnEntry?.hardFailureReason) ??
    boundedString(spawnEntry?.error) ??
    runtimeAdvisoryMessage;
  const memberCardError = firstMemberCardFailureReason({
    candidates: [
      spawnEntry?.error,
      spawnEntry?.hardFailureReason,
      spawnRuntimeDiagnosticCardError,
      runtimeEntryDiagnosticCardError,
      runtimeAdvisoryCardError,
    ],
    evidence: [
      spawnEntry?.runtimeDiagnostic,
      runtimeEntry?.runtimeDiagnostic,
      runtimeAdvisoryTitle,
      runtimeAdvisoryLabel,
      runtimeAdvisoryMessage,
      ...(runtimeEntry?.diagnostics ?? []),
    ],
    providerId,
  });
  const diagnostics = uniqueDiagnostics(
    memberCardError ? [memberCardError] : undefined,
    runtimeDiagnostic ? [runtimeDiagnostic] : undefined,
    runtimeAdvisoryTitle ? [runtimeAdvisoryTitle] : undefined,
    runtimeAdvisoryLabel ? [runtimeAdvisoryLabel] : undefined,
    runtimeAdvisoryMessage ? [runtimeAdvisoryMessage] : undefined,
    spawnEntry?.hardFailureReason ? [spawnEntry.hardFailureReason] : undefined,
    spawnEntry?.error ? [spawnEntry.error] : undefined,
    runtimeEntry?.diagnostics
  );
  const runId = boundedString(params.runId ?? undefined);
  const runtimeUpdatedAt = maybeString(runtimeEntry?.updatedAt);
  const spawnUpdatedAt = maybeString(spawnEntry?.updatedAt);
  const diagnosticHints = buildDiagnosticHints({
    memberCardError,
    runtimeDiagnostic,
    diagnostics,
    livenessKind,
    launchState,
    spawnStatus,
    providerId,
  });
  const probableCause = buildProbableCause(diagnosticHints);

  return {
    ...(params.teamName ? { teamName: params.teamName } : {}),
    ...(runId ? { runId } : {}),
    memberName: params.memberName,
    ...(providerId ? { providerId } : {}),
    ...(providerBackendId ? { providerBackendId } : {}),
    ...(maybeString(params.member?.model) ? { model: maybeString(params.member?.model) } : {}),
    ...(maybeString(runtimeEntry?.runtimeModel ?? spawnEntry?.runtimeModel)
      ? { runtimeModel: maybeString(runtimeEntry?.runtimeModel ?? spawnEntry?.runtimeModel) }
      : {}),
    ...(maybeString(params.member?.agentType)
      ? { agentType: maybeString(params.member?.agentType) }
      : {}),
    ...(maybeString(laneId) ? { laneId: maybeString(laneId) } : {}),
    ...(laneKind ? { laneKind } : {}),
    ...(params.member?.laneOwnerProviderId
      ? { laneOwnerProviderId: params.member.laneOwnerProviderId }
      : {}),
    ...(boundedNumber(params.member?.removedAt)
      ? { removedAt: boundedNumber(params.member?.removedAt) }
      : {}),
    ...(memberCardError ? { memberCardError } : {}),
    ...(launchState ? { launchState } : {}),
    ...(spawnStatus ? { spawnStatus } : {}),
    ...(runtimeEntry?.backendType ? { backendType: runtimeEntry.backendType } : {}),
    ...(typeof runtimeEntry?.alive === 'boolean' ? { alive: runtimeEntry.alive } : {}),
    ...(typeof runtimeEntry?.restartable === 'boolean'
      ? { restartable: runtimeEntry.restartable }
      : {}),
    ...(typeof spawnEntry?.runtimeAlive === 'boolean'
      ? { runtimeAlive: spawnEntry.runtimeAlive }
      : {}),
    ...(typeof spawnEntry?.bootstrapConfirmed === 'boolean'
      ? { bootstrapConfirmed: spawnEntry.bootstrapConfirmed }
      : {}),
    ...(typeof spawnEntry?.agentToolAccepted === 'boolean'
      ? { agentToolAccepted: spawnEntry.agentToolAccepted }
      : {}),
    ...(typeof spawnEntry?.hardFailure === 'boolean'
      ? { hardFailure: spawnEntry.hardFailure }
      : {}),
    ...(livenessKind ? { livenessKind } : {}),
    ...((spawnEntry?.livenessSource ?? params.livenessSource)
      ? { livenessSource: spawnEntry?.livenessSource ?? params.livenessSource }
      : {}),
    ...(boundedNumber(runtimeEntry?.pid) ? { pid: boundedNumber(runtimeEntry?.pid) } : {}),
    ...(runtimeEntry?.pidSource ? { pidSource: runtimeEntry.pidSource } : {}),
    ...(boundedString(runtimeEntry?.paneId) ? { paneId: boundedString(runtimeEntry?.paneId) } : {}),
    ...(boundedNumber(runtimeEntry?.panePid)
      ? { panePid: boundedNumber(runtimeEntry?.panePid) }
      : {}),
    ...(boundedString(runtimeEntry?.paneCurrentCommand)
      ? { paneCurrentCommand: boundedString(runtimeEntry?.paneCurrentCommand) }
      : {}),
    ...(boundedString(runtimeEntry?.processCommand)
      ? { processCommand: boundedString(runtimeEntry?.processCommand) }
      : {}),
    ...(boundedNumber(runtimeEntry?.runtimePid)
      ? { runtimePid: boundedNumber(runtimeEntry?.runtimePid) }
      : {}),
    ...(boundedString(runtimeEntry?.runtimeSessionId)
      ? { runtimeSessionId: boundedString(runtimeEntry?.runtimeSessionId) }
      : {}),
    ...(maybeString(runtimeEntry?.runtimeLeaseExpiresAt)
      ? { runtimeLeaseExpiresAt: maybeString(runtimeEntry?.runtimeLeaseExpiresAt) }
      : {}),
    ...(maybeString(runtimeEntry?.runtimeLastSeenAt ?? spawnEntry?.lastHeartbeatAt)
      ? {
          runtimeLastSeenAt: maybeString(
            runtimeEntry?.runtimeLastSeenAt ?? spawnEntry?.lastHeartbeatAt
          ),
        }
      : {}),
    ...(typeof runtimeEntry?.historicalBootstrapConfirmed === 'boolean'
      ? { historicalBootstrapConfirmed: runtimeEntry.historicalBootstrapConfirmed }
      : {}),
    ...(maybeString(runtimeEntry?.cwd) ? { cwd: maybeString(runtimeEntry?.cwd) } : {}),
    ...(boundedNumber(runtimeEntry?.rssBytes)
      ? { rssBytes: boundedNumber(runtimeEntry?.rssBytes) }
      : {}),
    ...(runtimeDiagnostic ? { runtimeDiagnostic } : {}),
    ...(runtimeDiagnosticSeverity
      ? {
          runtimeDiagnosticSeverity,
        }
      : {}),
    ...(runtimeAdvisory?.kind ? { runtimeAdvisoryKind: runtimeAdvisory.kind } : {}),
    ...(runtimeAdvisory?.reasonCode
      ? { runtimeAdvisoryReasonCode: runtimeAdvisory.reasonCode }
      : {}),
    ...(maybeString(runtimeAdvisory?.observedAt)
      ? { runtimeAdvisoryObservedAt: maybeString(runtimeAdvisory?.observedAt) }
      : {}),
    ...(maybeString(runtimeAdvisory?.retryUntil)
      ? { runtimeAdvisoryRetryUntil: maybeString(runtimeAdvisory?.retryUntil) }
      : {}),
    ...(boundedNumber(runtimeAdvisory?.retryDelayMs)
      ? { runtimeAdvisoryRetryDelayMs: boundedNumber(runtimeAdvisory?.retryDelayMs) }
      : {}),
    ...(spawnEntry?.bootstrapStalled === true ? { bootstrapStalled: true } : {}),
    ...(boundedStringArray(spawnEntry?.pendingPermissionRequestIds)
      ? { pendingPermissionRequestIds: boundedStringArray(spawnEntry?.pendingPermissionRequestIds) }
      : {}),
    ...(maybeString(spawnEntry?.firstSpawnAcceptedAt)
      ? { firstSpawnAcceptedAt: maybeString(spawnEntry?.firstSpawnAcceptedAt) }
      : {}),
    ...(maybeString(spawnEntry?.lastHeartbeatAt)
      ? { lastHeartbeatAt: maybeString(spawnEntry?.lastHeartbeatAt) }
      : {}),
    ...(maybeString(spawnEntry?.livenessLastCheckedAt)
      ? { livenessLastCheckedAt: maybeString(spawnEntry?.livenessLastCheckedAt) }
      : {}),
    ...(probableCause ? { probableCause } : {}),
    ...(diagnosticHints ? { diagnosticHints } : {}),
    ...(diagnostics ? { diagnostics } : {}),
    ...(spawnUpdatedAt ? { spawnUpdatedAt } : {}),
    ...(runtimeUpdatedAt ? { runtimeUpdatedAt } : {}),
    ...(boundedString(spawnEntry?.updatedAt ?? runtimeEntry?.updatedAt)
      ? { updatedAt: boundedString(spawnEntry?.updatedAt ?? runtimeEntry?.updatedAt) }
      : {}),
  };
}

function parseStatusUpdatedAtMs(value: string | undefined): number | null {
  if (!value) {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function isFailedSpawnEntry(entry: MemberSpawnStatusEntry | undefined): boolean {
  return entry?.launchState === 'failed_to_start' || entry?.status === 'error';
}

function shouldPreferSnapshotEntryOverLive(params: {
  liveEntry: MemberSpawnStatusEntry | undefined;
  snapshotEntry: MemberSpawnStatusEntry | undefined;
  snapshotUpdatedAt?: string;
}): boolean {
  const { liveEntry, snapshotEntry, snapshotUpdatedAt } = params;
  if (!liveEntry || !snapshotEntry) {
    return false;
  }
  if (!isFailedSpawnEntry(liveEntry) || isFailedSpawnEntry(snapshotEntry)) {
    return false;
  }

  const liveUpdatedAtMs = parseStatusUpdatedAtMs(liveEntry.updatedAt);
  const snapshotUpdatedAtMs =
    parseStatusUpdatedAtMs(snapshotEntry.updatedAt) ?? parseStatusUpdatedAtMs(snapshotUpdatedAt);
  return (
    snapshotUpdatedAtMs != null &&
    (liveUpdatedAtMs == null || snapshotUpdatedAtMs >= liveUpdatedAtMs)
  );
}

function getPreferredSpawnEntry(params: {
  liveEntry: MemberSpawnStatusEntry | undefined;
  snapshotEntry: MemberSpawnStatusEntry | undefined;
  snapshotUpdatedAt?: string;
}): MemberSpawnStatusEntry | undefined {
  return shouldPreferSnapshotEntryOverLive(params)
    ? params.snapshotEntry
    : (params.liveEntry ?? params.snapshotEntry);
}

function getSpawnEntry(
  collection: MemberSpawnStatusCollection,
  name: string
): MemberSpawnStatusEntry | undefined {
  return collection instanceof Map ? collection.get(name) : collection?.[name];
}

export function buildTeamMemberLaunchDiagnosticsPayloads(params: {
  teamName?: string | null;
  runId?: string | null;
  members?: readonly MemberDiagnosticsMemberLike[];
  memberSpawnStatuses?: MemberSpawnStatusCollection;
  memberSpawnSnapshot?: {
    statuses?: Record<string, MemberSpawnStatusEntry>;
    updatedAt?: string;
  };
  runtimeEntries?: Record<string, TeamAgentRuntimeEntry> | null;
}): MemberLaunchDiagnosticsPayload[] {
  const membersByName = new Map(
    (params.members ?? [])
      .map((member) => [member.name.trim(), member] as const)
      .filter(([name]) => name.length > 0)
  );
  const names = new Set<string>(membersByName.keys());
  if (params.memberSpawnStatuses instanceof Map) {
    for (const name of params.memberSpawnStatuses.keys()) {
      names.add(name);
    }
  } else {
    for (const name of Object.keys(params.memberSpawnStatuses ?? {})) {
      names.add(name);
    }
  }
  for (const name of Object.keys(params.memberSpawnSnapshot?.statuses ?? {})) {
    names.add(name);
  }
  for (const name of Object.keys(params.runtimeEntries ?? {})) {
    names.add(name);
  }

  return [...names]
    .sort((left, right) => left.localeCompare(right))
    .map((name) => {
      const liveEntry = getSpawnEntry(params.memberSpawnStatuses, name);
      const snapshotEntry = params.memberSpawnSnapshot?.statuses?.[name];
      return buildMemberLaunchDiagnosticsPayload({
        teamName: params.teamName,
        runId: params.runId,
        memberName: name,
        member: membersByName.get(name),
        spawnEntry: getPreferredSpawnEntry({
          liveEntry,
          snapshotEntry,
          snapshotUpdatedAt: params.memberSpawnSnapshot?.updatedAt,
        }),
        runtimeEntry: params.runtimeEntries?.[name],
      });
    });
}

export function hasMemberLaunchDiagnosticsDetails(
  payload: MemberLaunchDiagnosticsPayload
): boolean {
  const weakLiveness =
    payload.livenessKind === 'runtime_process_candidate' ||
    payload.livenessKind === 'permission_blocked' ||
    payload.livenessKind === 'shell_only' ||
    payload.livenessKind === 'registered_only' ||
    payload.livenessKind === 'stale_metadata' ||
    payload.livenessKind === 'not_found';
  return Boolean(
    (payload.launchState && payload.launchState !== 'confirmed_alive') ||
    (payload.spawnStatus && payload.spawnStatus !== 'online') ||
    payload.memberCardError ||
    payload.bootstrapStalled === true ||
    weakLiveness ||
    payload.runtimeDiagnostic ||
    payload.diagnostics?.length
  );
}

export function hasMemberLaunchDiagnosticsError(payload: MemberLaunchDiagnosticsPayload): boolean {
  if (
    payload.providerId === 'opencode' &&
    !payload.memberCardError &&
    hasCleanRecoverableOpenCodeRefreshContext([
      payload.runtimeDiagnostic,
      ...(payload.diagnostics ?? []),
    ])
  ) {
    return false;
  }
  return Boolean(
    payload.memberCardError ||
    payload.spawnStatus === 'error' ||
    payload.launchState === 'failed_to_start' ||
    payload.runtimeDiagnosticSeverity === 'error'
  );
}

export function getMemberLaunchDiagnosticsErrorMessage(
  payload: MemberLaunchDiagnosticsPayload
): string | undefined {
  if (!hasMemberLaunchDiagnosticsError(payload)) {
    return undefined;
  }
  return (
    payload.memberCardError ??
    payload.runtimeDiagnostic ??
    payload.diagnostics?.[0] ??
    'Launch failed'
  );
}

export function formatMemberLaunchDiagnosticsPayload(
  payload: MemberLaunchDiagnosticsPayload
): string {
  return JSON.stringify(payload, null, 2);
}
