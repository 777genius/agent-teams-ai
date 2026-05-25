import { isLeadMember } from '@shared/utils/leadDetection';
import { buildTeamMemberColorMap } from '@shared/utils/teamMemberColors';

import {
  getParticipantAvatarUrlByIndex,
  LEAD_PARTICIPANT_AVATAR_URL,
  PARTICIPANT_AVATAR_URLS,
} from './memberAvatarCatalog';
import { isHealthyOpenCodeAppMcpConnectivityAdvisory } from './openCodeAdvisoryHealth';

import type {
  LeadActivityState,
  MemberLaunchState,
  MemberRuntimeAdvisory,
  MemberSpawnLivenessSource,
  MemberSpawnStatus,
  MemberSpawnStatusEntry,
  MemberStatus,
  ResolvedTeamMember,
  TeamAgentRuntimeEntry,
  TeamProviderId,
  TeamReviewState,
  TeamTaskStatus,
} from '@shared/types';

/**
 * UI display name for a team member.
 * "team-lead" → "lead"; everything else passes through unchanged.
 * Data layer (store, IPC, backend) must keep the original name untouched.
 */
export function displayMemberName(name: string): string {
  return name === 'team-lead' ? 'lead' : name;
}

function hashStringToIndex(str: string): number {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash + str.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
}

export function agentAvatarUrl(name: string, size = 64): string {
  void size;
  const normalized = name.trim().toLowerCase();
  if (normalized === 'team-lead' || normalized === 'lead') {
    return LEAD_PARTICIPANT_AVATAR_URL;
  }

  // Temporarily disabled external avatar API.
  // return `https://robohash.org/${encodeURIComponent(name)}?size=${size}x${size}`;
  return getParticipantAvatarUrlByIndex(
    hashStringToIndex(normalized) % PARTICIPANT_AVATAR_URLS.length
  );
}

export const STATUS_DOT_COLORS: Record<MemberStatus, string> = {
  active: 'bg-emerald-400',
  idle: 'bg-zinc-400',
  terminated: 'bg-red-400',
  unknown: 'bg-zinc-600',
};

export function getMemberDotClass(
  member: ResolvedTeamMember,
  isTeamAlive?: boolean,
  isTeamProvisioning?: boolean,
  leadActivity?: LeadActivityState
): string {
  if (member.status === 'terminated') return STATUS_DOT_COLORS.terminated;
  if (member.removedAt) return STATUS_DOT_COLORS.terminated;
  // Lead activity check BEFORE provisioning fallback — when the lead process
  // is running (CLI logs present), show green even during provisioning.
  if (leadActivity && isLeadMember(member)) {
    return leadActivity === 'active'
      ? `${STATUS_DOT_COLORS.active} animate-pulse`
      : STATUS_DOT_COLORS.active;
  }
  if (isTeamProvisioning) return STATUS_DOT_COLORS.unknown;
  if (isTeamAlive === false) return STATUS_DOT_COLORS.terminated;
  // When team is alive, all non-terminated members are online
  if (isTeamAlive) {
    if (member.currentTaskId) return `${STATUS_DOT_COLORS.active} animate-pulse`;
    return STATUS_DOT_COLORS.active;
  }
  if (member.status === 'unknown') return STATUS_DOT_COLORS.unknown;
  if (member.currentTaskId) return STATUS_DOT_COLORS.active;
  return member.status === 'active' ? STATUS_DOT_COLORS.active : STATUS_DOT_COLORS.idle;
}

export function getPresenceLabel(
  member: ResolvedTeamMember,
  isTeamAlive?: boolean,
  isTeamProvisioning?: boolean,
  leadActivity?: LeadActivityState,
  leadContextPercent?: number
): string {
  if (member.status === 'terminated') return 'terminated';
  // Lead activity check before provisioning fallback (mirrors getMemberDotClass order).
  if (leadActivity && isLeadMember(member)) {
    if (leadActivity === 'active') {
      return leadContextPercent != null && leadContextPercent > 0
        ? `processing (${Math.round(leadContextPercent)}%)`
        : 'processing';
    }
    return 'ready';
  }
  if (isTeamProvisioning) return 'connecting';
  if (isTeamAlive === false) return 'offline';
  if (member.status === 'unknown') return 'idle';
  return member.currentTaskId ? 'working' : 'idle';
}

/* ------------------------------------------------------------------ */
/*  Spawn-status-aware helpers for progressive member card appearance  */
/* ------------------------------------------------------------------ */

export const SPAWN_DOT_COLORS: Record<MemberSpawnStatus, string> = {
  offline: 'bg-zinc-600',
  waiting: 'bg-zinc-400 animate-pulse',
  spawning: 'bg-amber-400',
  online: 'bg-emerald-400 animate-pulse',
  error: 'bg-red-400',
  skipped: 'bg-zinc-500',
};

export const SPAWN_PRESENCE_LABELS: Record<MemberSpawnStatus, string> = {
  offline: 'offline',
  waiting: 'starting',
  spawning: 'starting',
  online: 'ready',
  error: 'spawn failed',
  skipped: 'skipped',
};

const OPENCODE_RUNTIME_CANDIDATE_RELAUNCH_GRACE_MS = 5 * 60 * 1000;
export const MEMBER_STARTING_STALE_AFTER_MS = 2 * 60 * 1000;
const OPENCODE_BRIDGE_OUTCOME_UNKNOWN_AFTER_TIMEOUT_MESSAGE =
  'OpenCode bridge outcome unknown after timeout, retrying/observing.';

function isLaunchStillStarting(
  spawnStatus: MemberSpawnStatus | undefined,
  spawnLaunchState: MemberLaunchState | undefined,
  runtimeAlive: boolean | undefined,
  keepRuntimePendingInStarting = false
): boolean {
  if (spawnLaunchState === 'failed_to_start') {
    return false;
  }
  if (spawnLaunchState === 'skipped_for_launch') {
    return false;
  }
  if (spawnLaunchState === 'runtime_pending_permission') {
    return false;
  }
  if (spawnLaunchState === 'runtime_pending_bootstrap') {
    if (runtimeAlive !== true) {
      return true;
    }
    return keepRuntimePendingInStarting;
  }
  return spawnLaunchState === 'starting' || spawnStatus === 'waiting' || spawnStatus === 'spawning';
}

/**
 * Returns dot class for a member during provisioning, respecting spawn status.
 * Falls back to the existing `getMemberDotClass` when no spawn status is available.
 */
export function getSpawnAwareDotClass(
  member: ResolvedTeamMember,
  spawnStatus: MemberSpawnStatus | undefined,
  spawnLaunchState: MemberLaunchState | undefined,
  runtimeAlive: boolean | undefined,
  isLaunchSettling = false,
  isTeamAlive?: boolean,
  isTeamProvisioning?: boolean,
  leadActivity?: LeadActivityState
): string {
  const keepLaunchSettlingVisuals = isTeamProvisioning === true || isLaunchSettling;
  if (isTeamAlive === false && !isTeamProvisioning) {
    return STATUS_DOT_COLORS.terminated;
  }
  if (spawnLaunchState === 'failed_to_start' || spawnStatus === 'error') {
    return SPAWN_DOT_COLORS.error;
  }
  if (spawnLaunchState === 'skipped_for_launch' || spawnStatus === 'skipped') {
    return SPAWN_DOT_COLORS.skipped;
  }
  if (spawnLaunchState === 'runtime_pending_permission') {
    return 'bg-amber-400 animate-pulse';
  }
  if (
    isLaunchStillStarting(spawnStatus, spawnLaunchState, runtimeAlive, keepLaunchSettlingVisuals)
  ) {
    return spawnStatus === 'spawning' ? SPAWN_DOT_COLORS.spawning : SPAWN_DOT_COLORS.waiting;
  }
  if (spawnLaunchState === 'runtime_pending_bootstrap' && spawnStatus === 'online') {
    return SPAWN_DOT_COLORS.online;
  }
  if (spawnStatus === 'waiting') {
    return SPAWN_DOT_COLORS.waiting;
  }
  if (spawnStatus === 'online') {
    return SPAWN_DOT_COLORS.online;
  }
  if (spawnStatus === 'offline' && isTeamProvisioning) {
    return SPAWN_DOT_COLORS.offline;
  }
  if (spawnStatus === 'spawning' && isTeamProvisioning) {
    return SPAWN_DOT_COLORS.spawning;
  }
  return getMemberDotClass(member, isTeamAlive, isTeamProvisioning, leadActivity);
}

/**
 * Returns presence label for a member during provisioning, respecting spawn status.
 */
export function getSpawnAwarePresenceLabel(
  member: ResolvedTeamMember,
  spawnStatus: MemberSpawnStatus | undefined,
  spawnLaunchState: MemberLaunchState | undefined,
  livenessSource: MemberSpawnLivenessSource | undefined,
  runtimeAlive: boolean | undefined,
  isLaunchSettling = false,
  isTeamAlive?: boolean,
  isTeamProvisioning?: boolean,
  leadActivity?: LeadActivityState
): string {
  const keepLaunchSettlingVisuals = isTeamProvisioning === true || isLaunchSettling;
  if (isTeamAlive === false && !isTeamProvisioning) {
    return 'offline';
  }
  if (spawnLaunchState === 'failed_to_start' || spawnStatus === 'error') {
    return SPAWN_PRESENCE_LABELS.error;
  }
  if (spawnLaunchState === 'skipped_for_launch' || spawnStatus === 'skipped') {
    return SPAWN_PRESENCE_LABELS.skipped;
  }
  if (spawnLaunchState === 'runtime_pending_permission') {
    return 'connecting';
  }
  if (
    isLaunchStillStarting(spawnStatus, spawnLaunchState, runtimeAlive, keepLaunchSettlingVisuals)
  ) {
    return 'starting';
  }
  if (spawnStatus === 'online' && keepLaunchSettlingVisuals) {
    return SPAWN_PRESENCE_LABELS.online;
  }
  if (spawnStatus === 'online' && livenessSource === 'process') {
    return 'online';
  }
  if (spawnStatus && isTeamProvisioning) {
    return SPAWN_PRESENCE_LABELS[spawnStatus];
  }
  return getPresenceLabel(member, isTeamAlive, isTeamProvisioning, leadActivity);
}

/**
 * Card container CSS classes based on spawn status (opacity + animation).
 * Used by MemberCard wrapper for fade-in transitions.
 */
export function getSpawnCardClass(
  spawnStatus: MemberSpawnStatus | undefined,
  spawnLaunchState?: MemberLaunchState,
  runtimeAlive?: boolean,
  isLaunchSettling = false,
  isTeamAlive?: boolean,
  isTeamProvisioning?: boolean
): string {
  const keepLaunchSettlingVisuals = isTeamProvisioning === true || isLaunchSettling;
  if (isTeamAlive === false && !isTeamProvisioning) {
    return '';
  }
  if (
    isLaunchStillStarting(spawnStatus, spawnLaunchState, runtimeAlive, keepLaunchSettlingVisuals)
  ) {
    return 'member-waiting-shimmer';
  }
  if (spawnLaunchState === 'skipped_for_launch' || spawnStatus === 'skipped') {
    return 'opacity-70';
  }
  if (spawnLaunchState === 'runtime_pending_permission') {
    return 'member-waiting-shimmer';
  }
  switch (spawnStatus) {
    case 'offline':
      return spawnLaunchState === 'starting' ? 'member-waiting-shimmer opacity-75' : 'opacity-40';
    case 'waiting':
      return 'member-waiting-shimmer';
    case 'spawning':
      return 'member-waiting-shimmer';
    case 'online':
      return 'animate-[member-fade-in_0.4s_ease-out]';
    case 'error':
      return 'opacity-80';
    default:
      return '';
  }
}

function formatRetryCountdown(ms: number): string {
  const totalSeconds = Math.max(1, Math.ceil(ms / 1000));
  if (totalSeconds < 60) {
    return `${totalSeconds}s`;
  }
  const minutes = Math.floor(totalSeconds / 60);
  if (minutes >= 60) {
    const hours = Math.floor(minutes / 60);
    const remainingMinutes = minutes % 60;
    return remainingMinutes > 0 ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
  }
  const seconds = totalSeconds % 60;
  return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
}

function getRuntimeAdvisoryRetryRemainingMs(
  advisory: MemberRuntimeAdvisory,
  nowMs: number
): number | null {
  const retryUntilMs = advisory.retryUntil ? Date.parse(advisory.retryUntil) : Number.NaN;
  if (!Number.isFinite(retryUntilMs)) {
    return null;
  }
  const remainingMs = retryUntilMs - nowMs;
  return remainingMs > 0 ? remainingMs : null;
}

function isRetryTimedApiAdvisory(
  advisory: MemberRuntimeAdvisory,
  providerId: TeamProviderId | undefined
): boolean {
  return (
    advisory.kind === 'api_error' &&
    providerId === 'opencode' &&
    (advisory.reasonCode === 'quota_exhausted' || advisory.reasonCode === 'rate_limited')
  );
}

function formatRetryUntilUtc(value: string | undefined): string | null {
  const retryUntilMs = value ? Date.parse(value) : Number.NaN;
  if (!Number.isFinite(retryUntilMs)) {
    return null;
  }
  const date = new Date(retryUntilMs);
  const hours = String(date.getUTCHours()).padStart(2, '0');
  const minutes = String(date.getUTCMinutes()).padStart(2, '0');
  return `${hours}:${minutes} UTC`;
}

function appendRuntimeAdvisoryRetryHint(
  base: string,
  advisory: MemberRuntimeAdvisory,
  providerId: TeamProviderId | undefined
): string {
  if (!isRetryTimedApiAdvisory(advisory, providerId)) {
    return base;
  }
  const retryAt = formatRetryUntilUtc(advisory.retryUntil);
  if (!retryAt) {
    return base;
  }
  return `${base} Waiting for OpenCode retry or quota reset around ${retryAt}.`;
}

function getRuntimeAdvisoryProviderLabel(providerId: TeamProviderId | undefined): string | null {
  switch (providerId) {
    case 'anthropic':
      return 'Anthropic';
    case 'codex':
      return 'Codex';
    case 'gemini':
      return 'Gemini';
    case 'opencode':
      return 'OpenCode';
    default:
      return null;
  }
}

function appendRuntimeAdvisoryRawMessage(
  base: string,
  message: string | undefined,
  providerId?: TeamProviderId
): string {
  const trimmed = formatRuntimeAdvisoryDisplayMessage(message, providerId);
  if (trimmed === base) {
    return base;
  }
  return trimmed ? `${base}\n\n${trimmed}` : base;
}

const OPENCODE_SESSION_REFRESH_REASON_PATTERN =
  /\b(?:resolved_behavior_changed|opencode_app_mcp_transport_changed):[-a-z0-9._~/=]+->[-a-z0-9._~/=]+/i;
const OPENCODE_SESSION_REFRESH_FAILURE_PATTERN =
  // eslint-disable-next-line sonarjs/regex-complexity -- Keyword taxonomy is kept literal to preserve diagnostic behavior.
  /(?:^|[_\s:;.\/()-])(?:permission[_\s-]?denied|permission[_\s-]?blocked|access[_\s-]?denied|auth[_\s-]?unavailable|authentication[_\s-]?failed|unauthorized|forbidden|401|403|login[_\s-]?required|not\s+logged\s+in|missing\s+credentials?|invalid\s+credentials?|credentials?[_\s-]?required|credentials?[_\s-]?unavailable|no auth available|authorization|auth(?:entication)?(?:[_\s-]?(?:failed|unavailable))?|invalid api[_\s-]?key|api[_\s-]?key|does not have access|quota|rate[_\s-]?(?:limit|limited)|too many requests|429|model cooldown|cooling down|enospc|no space left|disk is full|capacity exceeded|quota exhausted|usage exceeded|free usage exceeded|key limit exceeded|total limit|insufficient credits|subscribe to go|error|failed|failure|timeout|timed\s+out|network|connection|unable\s+to\s+connect|connect\s+failed|econn[a-z_]*|enotfound|fetch[_\s-]?failed|connection[_\s-]?(?:refused|reset)|aborted|cancel(?:ed|led)|interrupted|service[_\s-]?unavailable|temporarily\s+unavailable|overloaded|visible[_\s-]?reply(?:[_\s-][a-z0-9]+)*|task[_\s-]?refs|relayofmessageid|relay[_\s-]?of[_\s-]?message[_\s-]?id|message[_\s-]?send|non[_\s-]?visible[_\s-]?tool(?:[_\s-][a-z0-9]+)*|protocol[_\s-]?proof)(?=$|[_\s:;.\/(),-])/i;
const OPENCODE_SESSION_REFRESH_ANY_REASON_PATTERN =
  /\b(?:resolved_behavior_changed|opencode_app_mcp_transport_changed):[-a-z0-9._~/=]+->[-a-z0-9._~/=]+/gi;
const OPENCODE_SESSION_REFRESH_SAFE_MARKER_STATE_PATTERN =
  /\b(?:not_observed|pending|prompt_not_indexed|responded_tool_call|responded_visible_message|responded_non_visible_tool|responded_plain_text|permission_blocked|tool_error|empty_assistant_turn|prompt_delivered_no_assistant_message|session_stale|session_error|reconcile_failed)\b/g;

function isRecoverableOpenCodeSessionRefreshMessage(message: string | undefined): boolean {
  const normalized = message?.trim().toLowerCase() ?? '';
  const refreshText = stripOpenCodeGenericApiErrorPrefix(normalized);
  const refreshMarkerText = refreshText.replace(/[.:\s-]+$/, '');
  if (
    refreshMarkerText === 'session_stale' ||
    refreshMarkerText === 'opencode session changed; refreshing the session before retry' ||
    refreshMarkerText === 'opencode session refresh scheduled after resolved behavior changed' ||
    refreshMarkerText === 'opencode_prompt_delivery_session_refresh_scheduled' ||
    refreshMarkerText === 'opencode_session_refresh_scheduled_after_resolved_behavior_changed'
  ) {
    return true;
  }
  if (!OPENCODE_SESSION_REFRESH_REASON_PATTERN.test(refreshText)) {
    return false;
  }
  const markerText = refreshText;
  if (hasOpenCodeSessionRefreshFailureConflict(markerText)) {
    return false;
  }
  const rawRemainder = markerText.replace(OPENCODE_SESSION_REFRESH_ANY_REASON_PATTERN, '');
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

function canTreatAdvisoryAsOpenCodeSessionRefresh(
  advisory: MemberRuntimeAdvisory | undefined
): boolean {
  return (
    Boolean(advisory) &&
    (advisory?.reasonCode == null ||
      advisory.reasonCode === 'backend_error' ||
      advisory.reasonCode === 'unknown') &&
    isRecoverableOpenCodeSessionRefreshMessage(advisory?.message)
  );
}

function isOpenCodeRuntimeDeliveryAdvisoryMessage(message: string | undefined): boolean {
  const displayMessage = formatRuntimeAdvisoryDisplayMessage(message, 'opencode');
  return (
    displayMessage.startsWith('OpenCode runtime delivery') ||
    displayMessage.startsWith('OpenCode returned an empty assistant turn') ||
    displayMessage.startsWith('OpenCode accepted the prompt') ||
    displayMessage.startsWith('OpenCode bridge outcome unknown after timeout') ||
    displayMessage.startsWith('OpenCode responded, but did not create') ||
    displayMessage.startsWith('OpenCode created a reply without') ||
    displayMessage.startsWith('OpenCode used tools, but did not create')
  );
}

function formatRuntimeAdvisoryDisplayMessage(
  message: string | undefined,
  providerId?: TeamProviderId
): string {
  const trimmed = message?.trim();
  if (!trimmed) {
    return '';
  }
  if (trimmed === 'empty_assistant_turn') {
    return 'OpenCode returned an empty assistant turn.';
  }
  if (trimmed === 'prompt_delivered_no_assistant_message') {
    return 'OpenCode accepted the prompt, but no assistant turn was recorded.';
  }
  if (trimmed === 'opencode_prompt_acceptance_unknown_after_bridge_timeout') {
    return OPENCODE_BRIDGE_OUTCOME_UNKNOWN_AFTER_TIMEOUT_MESSAGE;
  }
  if (providerId === 'opencode' && isRecoverableOpenCodeSessionRefreshMessage(trimmed)) {
    return 'OpenCode session changed; refreshing the session before retry.';
  }
  if (
    trimmed === 'visible_reply_still_required' ||
    trimmed === 'visible_reply_ack_only_still_requires_answer' ||
    trimmed === 'plain_text_ack_only_still_requires_answer'
  ) {
    return 'OpenCode responded, but did not create a visible message_send reply.';
  }
  if (
    trimmed === 'visible_reply_destination_not_found_yet' ||
    trimmed === 'visible_reply_missing_relayOfMessageId'
  ) {
    return 'OpenCode created a reply without the required relayOfMessageId correlation.';
  }
  if (trimmed === 'visible_reply_missing_task_refs') {
    return 'OpenCode created a reply without the required taskRefs metadata.';
  }
  if (trimmed === 'visible_reply_missing_task_refs_after_merge') {
    return 'OpenCode created a reply without the required taskRefs metadata.';
  }
  if (trimmed === 'visible_reply_task_refs_merge_failed') {
    return 'OpenCode created a reply without the required taskRefs metadata, and the app could not attach it automatically.';
  }
  if (trimmed === 'non_visible_tool_without_task_progress') {
    return 'OpenCode used tools, but did not create a visible reply or task progress proof.';
  }
  if (
    trimmed.startsWith(
      'OpenCode bootstrap MCP did not complete required tools before assistant response:'
    )
  ) {
    return 'OpenCode runtime delivery did not complete.';
  }
  return trimmed;
}

function formatRuntimeAdvisoryBaseLabel(
  advisory: MemberRuntimeAdvisory,
  providerId: TeamProviderId | undefined
): string {
  const providerLabel = getRuntimeAdvisoryProviderLabel(providerId);
  if (advisory.kind === 'api_error') {
    if (providerId === 'opencode' && canTreatAdvisoryAsOpenCodeSessionRefresh(advisory)) {
      return 'OpenCode session refresh';
    }
    switch (advisory.reasonCode) {
      case 'quota_exhausted':
        return providerLabel ? `${providerLabel} quota error` : 'Quota error';
      case 'rate_limited':
        return providerLabel ? `${providerLabel} rate limit` : 'Rate limit';
      case 'auth_error':
        return providerLabel ? `${providerLabel} auth error` : 'Auth error';
      case 'codex_native_timeout':
        return 'Codex native timeout';
      case 'network_error':
        return 'Network error';
      case 'filesystem_error':
        return 'Disk space error';
      case 'provider_overloaded':
        return providerLabel ? `${providerLabel} overload` : 'Provider overload';
      case 'protocol_proof_missing':
        return providerId === 'opencode' ? 'OpenCode proof missing' : 'Protocol proof missing';
      case 'backend_error':
      case 'unknown':
        if (
          providerId === 'opencode' &&
          isOpenCodeRuntimeDeliveryAdvisoryMessage(advisory.message)
        ) {
          return 'OpenCode delivery error';
        }
        return providerLabel ? `${providerLabel} API error` : 'API error';
      default:
        return 'API error';
    }
  }

  switch (advisory.reasonCode) {
    case 'quota_exhausted':
      return providerLabel ? `${providerLabel} quota retry` : 'Quota retry';
    case 'rate_limited':
      return providerLabel ? `${providerLabel} rate limit` : 'Rate limit retry';
    case 'auth_error':
      return providerLabel ? `${providerLabel} auth retry` : 'Auth retry';
    case 'codex_native_timeout':
      return 'Codex native retry';
    case 'network_error':
      return 'Network retry';
    case 'filesystem_error':
      return 'Disk space retry';
    case 'provider_overloaded':
      return providerLabel ? `${providerLabel} overload retry` : 'Provider overload retry';
    case 'protocol_proof_missing':
      return providerId === 'opencode' ? 'OpenCode proof missing' : 'Protocol proof missing';
    case 'backend_error':
    case 'unknown':
      return 'Provider retry';
    default:
      return 'retrying now';
  }
}

function formatRuntimeAdvisoryTitle(
  advisory: MemberRuntimeAdvisory,
  providerId: TeamProviderId | undefined
): string {
  const providerLabel = getRuntimeAdvisoryProviderLabel(providerId);
  if (advisory.kind === 'api_error') {
    if (providerId === 'opencode' && canTreatAdvisoryAsOpenCodeSessionRefresh(advisory)) {
      return appendRuntimeAdvisoryRawMessage(
        'OpenCode session changed; refreshing the session before retry.',
        advisory.message,
        providerId
      );
    }
    switch (advisory.reasonCode) {
      case 'quota_exhausted':
        return appendRuntimeAdvisoryRawMessage(
          appendRuntimeAdvisoryRetryHint(
            `${providerLabel ?? 'Provider'} quota exhausted.`,
            advisory,
            providerId
          ),
          advisory.message,
          providerId
        );
      case 'rate_limited':
        return appendRuntimeAdvisoryRawMessage(
          appendRuntimeAdvisoryRetryHint(
            `${providerLabel ?? 'Provider'} rate limited the request.`,
            advisory,
            providerId
          ),
          advisory.message,
          providerId
        );
      case 'auth_error':
        return appendRuntimeAdvisoryRawMessage(
          `${providerLabel ?? 'Provider'} authentication error.`,
          advisory.message,
          providerId
        );
      case 'codex_native_timeout':
        return appendRuntimeAdvisoryRawMessage(
          'Codex native mailbox turn timed out. The runtime stopped this turn after its watchdog limit; it was not an automatic SDK retry.',
          advisory.message,
          providerId
        );
      case 'network_error':
        return appendRuntimeAdvisoryRawMessage(
          'Network or connectivity error.',
          advisory.message,
          providerId
        );
      case 'filesystem_error':
        return appendRuntimeAdvisoryRawMessage(
          'Local disk is full or unavailable.',
          advisory.message,
          providerId
        );
      case 'provider_overloaded':
        return appendRuntimeAdvisoryRawMessage(
          'Provider is temporarily overloaded.',
          advisory.message,
          providerId
        );
      case 'protocol_proof_missing':
        return appendRuntimeAdvisoryRawMessage(
          providerId === 'opencode'
            ? 'OpenCode delivery completed without required visible/progress proof.'
            : 'Runtime delivery completed without required protocol proof.',
          advisory.message,
          providerId
        );
      case 'backend_error':
      case 'unknown':
        if (
          providerId === 'opencode' &&
          isOpenCodeRuntimeDeliveryAdvisoryMessage(advisory.message)
        ) {
          return appendRuntimeAdvisoryRawMessage(
            'OpenCode runtime delivery error.',
            advisory.message,
            providerId
          );
        }
        return appendRuntimeAdvisoryRawMessage(
          `${providerLabel ?? 'Provider'} API error.`,
          advisory.message,
          providerId
        );
      default:
        return advisory.message?.trim() || 'Provider API error.';
    }
  }

  switch (advisory.reasonCode) {
    case 'quota_exhausted':
      return appendRuntimeAdvisoryRawMessage(
        `${providerLabel ?? 'Provider'} quota exhausted. SDK is retrying automatically.`,
        advisory.message,
        providerId
      );
    case 'rate_limited':
      return appendRuntimeAdvisoryRawMessage(
        `${providerLabel ?? 'Provider'} rate limited the request. SDK is retrying automatically.`,
        advisory.message,
        providerId
      );
    case 'auth_error':
      return appendRuntimeAdvisoryRawMessage(
        `${providerLabel ?? 'Provider'} authentication issue. SDK is retrying automatically.`,
        advisory.message,
        providerId
      );
    case 'codex_native_timeout':
      return appendRuntimeAdvisoryRawMessage(
        'Codex native mailbox turn timed out. A retry window was reported by the runtime.',
        advisory.message,
        providerId
      );
    case 'network_error':
      return appendRuntimeAdvisoryRawMessage(
        'Network or connectivity issue. SDK is retrying automatically.',
        advisory.message,
        providerId
      );
    case 'filesystem_error':
      return appendRuntimeAdvisoryRawMessage(
        'Local disk is full or unavailable. SDK is retrying automatically.',
        advisory.message,
        providerId
      );
    case 'provider_overloaded':
      return appendRuntimeAdvisoryRawMessage(
        'Provider is temporarily overloaded. SDK is retrying automatically.',
        advisory.message,
        providerId
      );
    case 'protocol_proof_missing':
      return appendRuntimeAdvisoryRawMessage(
        providerId === 'opencode'
          ? 'OpenCode delivery is waiting for required visible/progress proof.'
          : 'Runtime delivery is waiting for required protocol proof.',
        advisory.message,
        providerId
      );
    case 'backend_error':
    case 'unknown':
      return appendRuntimeAdvisoryRawMessage(
        'The SDK is retrying this request after a provider or backend error.',
        advisory.message,
        providerId
      );
    default:
      return (
        advisory.message?.trim() ||
        'The SDK is retrying this request after a provider or backend error.'
      );
  }
}

export function getMemberRuntimeAdvisoryLabel(
  advisory: MemberRuntimeAdvisory | undefined,
  providerId?: TeamProviderId,
  nowMs = Date.now()
): string | null {
  if (!advisory) {
    return null;
  }
  const baseLabel = formatRuntimeAdvisoryBaseLabel(advisory, providerId);
  const remainingMs = getRuntimeAdvisoryRetryRemainingMs(advisory, nowMs);
  if (advisory.kind === 'api_error') {
    if (remainingMs && isRetryTimedApiAdvisory(advisory, providerId)) {
      return `${baseLabel} · retry ${formatRetryCountdown(remainingMs)}`;
    }
    return baseLabel;
  }
  if (advisory.kind !== 'sdk_retrying') {
    return null;
  }
  if (!remainingMs) {
    return baseLabel;
  }
  return `${baseLabel} · ${formatRetryCountdown(remainingMs)}`;
}

export function getMemberRuntimeAdvisoryTitle(
  advisory: MemberRuntimeAdvisory | undefined,
  providerId?: TeamProviderId
): string | undefined {
  if (!advisory || (advisory.kind !== 'sdk_retrying' && advisory.kind !== 'api_error')) {
    return undefined;
  }
  return formatRuntimeAdvisoryTitle(advisory, providerId);
}

export function getMemberRuntimeAdvisoryTone(
  advisory: MemberRuntimeAdvisory | undefined,
  providerId?: TeamProviderId
): 'error' | 'warning' | null {
  if (!advisory) {
    return null;
  }
  if (providerId === 'opencode' && canTreatAdvisoryAsOpenCodeSessionRefresh(advisory)) {
    return 'warning';
  }
  if (advisory.reasonCode === 'protocol_proof_missing') {
    return 'warning';
  }
  return advisory.kind === 'api_error' ? 'error' : 'warning';
}

export function getLaunchAwarePresenceLabel(
  member: ResolvedTeamMember,
  spawnStatus: MemberSpawnStatus | undefined,
  spawnLaunchState: MemberLaunchState | undefined,
  livenessSource: MemberSpawnLivenessSource | undefined,
  runtimeAlive: boolean | undefined,
  runtimeAdvisory: MemberRuntimeAdvisory | undefined,
  isLaunchSettling = false,
  isTeamAlive?: boolean,
  isTeamProvisioning?: boolean,
  leadActivity?: LeadActivityState
): string {
  const basePresenceLabel = getSpawnAwarePresenceLabel(
    member,
    spawnStatus,
    spawnLaunchState,
    livenessSource,
    runtimeAlive,
    isLaunchSettling,
    isTeamAlive,
    isTeamProvisioning,
    leadActivity
  );
  if (
    basePresenceLabel === 'starting' ||
    basePresenceLabel === 'connecting' ||
    basePresenceLabel === 'spawn failed' ||
    basePresenceLabel === 'skipped' ||
    basePresenceLabel === 'offline' ||
    basePresenceLabel === 'terminated'
  ) {
    return basePresenceLabel;
  }
  const advisoryLabel = getMemberRuntimeAdvisoryLabel(runtimeAdvisory, member.providerId);
  return advisoryLabel ?? basePresenceLabel;
}

export type MemberLaunchVisualState =
  | 'queued'
  | 'waiting'
  | 'spawning'
  | 'starting_stale'
  | 'permission_pending'
  | 'bootstrap_stalled'
  | 'runtime_pending'
  | 'shell_only'
  | 'runtime_candidate'
  | 'registered_only'
  | 'stale_runtime'
  | 'settling'
  | 'error'
  | 'skipped'
  | null;

export interface MemberLaunchPresentation {
  presenceLabel: string;
  dotClass: string;
  cardClass: string;
  runtimeAdvisoryLabel: string | null;
  runtimeAdvisoryTitle?: string;
  runtimeAdvisoryTone: 'error' | 'warning' | null;
  launchVisualState: MemberLaunchVisualState;
  launchStatusLabel: string | null;
  spawnBadgeLabel: string | null;
}

export function getMemberLaunchStatusLabel(visualState: MemberLaunchVisualState): string | null {
  switch (visualState) {
    case 'queued':
      return 'queued';
    case 'waiting':
      return 'waiting to start';
    case 'spawning':
      return 'starting';
    case 'starting_stale':
      return 'starting stale';
    case 'permission_pending':
      return 'awaiting permission';
    case 'bootstrap_stalled':
      return 'bootstrap stalled';
    case 'runtime_pending':
      return 'waiting for bootstrap';
    case 'shell_only':
      return 'shell only';
    case 'runtime_candidate':
      return 'bootstrap unconfirmed';
    case 'registered_only':
      return 'registered';
    case 'stale_runtime':
      return 'stale runtime';
    case 'settling':
      return 'joining team';
    case 'error':
      return 'failed';
    case 'skipped':
      return 'skipped';
    default:
      return null;
  }
}

function getLaunchVisualStateDotClass(visualState: MemberLaunchVisualState): string | null {
  switch (visualState) {
    case 'queued':
      return SPAWN_DOT_COLORS.waiting;
    case 'permission_pending':
    case 'bootstrap_stalled':
    case 'runtime_pending':
    case 'runtime_candidate':
      return 'bg-amber-400 animate-pulse';
    case 'starting_stale':
      return 'bg-amber-400';
    case 'registered_only':
      return STATUS_DOT_COLORS.terminated;
    case 'shell_only':
      return 'bg-amber-400';
    case 'stale_runtime':
      return STATUS_DOT_COLORS.terminated;
    default:
      return null;
  }
}

function getCurrentRuntimeOfflineVisualState(
  member: ResolvedTeamMember,
  runtimeEntry: TeamAgentRuntimeEntry | undefined,
  spawnStatus: MemberSpawnStatus | undefined,
  spawnLaunchState: MemberLaunchState | undefined,
  spawnRuntimeAlive: boolean | undefined,
  spawnBootstrapConfirmed: boolean | undefined,
  isTeamProvisioning: boolean | undefined
): MemberLaunchVisualState {
  if (runtimeEntry?.livenessKind === 'registered_only') {
    return 'registered_only';
  }
  if (
    runtimeEntry?.livenessKind === 'stale_metadata' ||
    runtimeEntry?.livenessKind === 'not_found'
  ) {
    return 'stale_runtime';
  }
  if (
    runtimeEntry?.alive === false &&
    (runtimeEntry.livenessKind == null ||
      runtimeEntry.livenessKind === 'runtime_process' ||
      runtimeEntry.livenessKind === 'confirmed_bootstrap')
  ) {
    return 'stale_runtime';
  }
  if (
    spawnRuntimeAlive === false &&
    (spawnStatus === 'online' || spawnLaunchState === 'confirmed_alive')
  ) {
    return 'stale_runtime';
  }
  if (
    shouldTreatCodexNativeRuntimeAsOffline({
      member,
      runtimeEntry,
      spawnStatus,
      spawnLaunchState,
      spawnRuntimeAlive,
      spawnBootstrapConfirmed,
      isTeamProvisioning,
    })
  ) {
    return 'stale_runtime';
  }
  return null;
}

function isCodexNativeProcessTeammate(member: ResolvedTeamMember): boolean {
  if (isLeadMember(member)) {
    return false;
  }
  return (
    member.providerId === 'codex' &&
    (member.providerBackendId == null || member.providerBackendId === 'codex-native')
  );
}

function hasLiveRuntimeProcessEvidence(runtimeEntry: TeamAgentRuntimeEntry | undefined): boolean {
  return runtimeEntry?.alive === true && runtimeEntry.livenessKind === 'runtime_process';
}

function hasSpawnRuntimeLiveClaim({
  spawnStatus,
  spawnLaunchState,
  spawnRuntimeAlive,
  spawnBootstrapConfirmed,
}: {
  spawnStatus?: MemberSpawnStatus;
  spawnLaunchState?: MemberLaunchState;
  spawnRuntimeAlive?: boolean;
  spawnBootstrapConfirmed?: boolean;
}): boolean {
  return (
    spawnStatus === 'online' ||
    spawnLaunchState === 'confirmed_alive' ||
    spawnRuntimeAlive === true ||
    spawnBootstrapConfirmed === true
  );
}

function shouldTreatCodexNativeRuntimeAsOffline({
  member,
  runtimeEntry,
  spawnStatus,
  spawnLaunchState,
  spawnRuntimeAlive,
  spawnBootstrapConfirmed,
  isTeamProvisioning,
}: {
  member: ResolvedTeamMember;
  runtimeEntry?: TeamAgentRuntimeEntry;
  spawnStatus?: MemberSpawnStatus;
  spawnLaunchState?: MemberLaunchState;
  spawnRuntimeAlive?: boolean;
  spawnBootstrapConfirmed?: boolean;
  isTeamProvisioning?: boolean;
}): boolean {
  if (!isCodexNativeProcessTeammate(member)) {
    return false;
  }
  if (
    spawnLaunchState === 'starting' ||
    spawnLaunchState === 'runtime_pending_bootstrap' ||
    spawnLaunchState === 'runtime_pending_permission'
  ) {
    return false;
  }
  if (hasLiveRuntimeProcessEvidence(runtimeEntry)) {
    return false;
  }
  if (
    isTeamProvisioning === true &&
    runtimeEntry == null &&
    !hasSpawnRuntimeLiveClaim({
      spawnStatus,
      spawnLaunchState,
      spawnRuntimeAlive,
      spawnBootstrapConfirmed,
    })
  ) {
    return false;
  }
  return (
    runtimeEntry != null ||
    hasSpawnRuntimeLiveClaim({
      spawnStatus,
      spawnLaunchState,
      spawnRuntimeAlive,
      spawnBootstrapConfirmed,
    }) ||
    spawnStatus == null
  );
}

export function shouldDisplayMemberCurrentTask({
  member,
  isTeamAlive,
  spawnStatus,
  spawnLaunchState,
  spawnRuntimeAlive,
  runtimeEntry,
}: {
  member: ResolvedTeamMember;
  isTeamAlive?: boolean;
  spawnStatus?: MemberSpawnStatus;
  spawnLaunchState?: MemberLaunchState;
  spawnRuntimeAlive?: boolean;
  runtimeEntry?: TeamAgentRuntimeEntry;
}): boolean {
  if (member.removedAt || member.status === 'terminated') {
    return false;
  }
  if (isTeamAlive === false) {
    return false;
  }
  if (spawnStatus === 'offline' || spawnStatus === 'error' || spawnStatus === 'skipped') {
    return false;
  }
  if (
    spawnLaunchState === 'failed_to_start' ||
    spawnLaunchState === 'skipped_for_launch' ||
    spawnLaunchState === 'runtime_pending_permission'
  ) {
    return false;
  }
  if (
    runtimeEntry?.livenessKind === 'shell_only' ||
    runtimeEntry?.livenessKind === 'registered_only' ||
    runtimeEntry?.livenessKind === 'stale_metadata' ||
    runtimeEntry?.livenessKind === 'not_found'
  ) {
    return false;
  }
  if (runtimeEntry?.alive === false) {
    return false;
  }
  if (spawnRuntimeAlive === false) {
    return false;
  }
  if (isCodexNativeProcessTeammate(member) && !hasLiveRuntimeProcessEvidence(runtimeEntry)) {
    return false;
  }
  return true;
}

function isQueuedOpenCodeLaunch(
  member: ResolvedTeamMember,
  spawnStatus: MemberSpawnStatus | undefined,
  spawnLaunchState: MemberLaunchState | undefined,
  runtimeEntry: TeamAgentRuntimeEntry | undefined,
  isLaunchSettling: boolean,
  isTeamProvisioning: boolean | undefined
): boolean {
  if (member.providerId !== 'opencode') {
    return false;
  }
  if (isTeamProvisioning !== true && !isLaunchSettling) {
    return false;
  }
  if (spawnStatus !== 'waiting' || spawnLaunchState !== 'starting') {
    return false;
  }

  // Only label lanes as queued before runtime evidence appears. Once the
  // backend has any liveness signal, show the exact runtime state instead.
  return runtimeEntry?.livenessKind == null;
}

function hasElapsedSinceIso(
  value: string | undefined,
  thresholdMs: number,
  nowMs: number
): boolean {
  if (!value) {
    return false;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && nowMs - parsed >= thresholdMs;
}

export function isMemberStartingStale({
  spawnStatus,
  spawnLaunchState,
  spawnFirstSpawnAcceptedAt,
  spawnUpdatedAt,
  nowMs = Date.now(),
}: {
  spawnStatus?: MemberSpawnStatus;
  spawnLaunchState?: MemberLaunchState;
  spawnFirstSpawnAcceptedAt?: string;
  spawnUpdatedAt?: string;
  nowMs?: number;
}): boolean {
  if (
    spawnLaunchState === 'failed_to_start' ||
    spawnLaunchState === 'confirmed_alive' ||
    spawnLaunchState === 'skipped_for_launch' ||
    spawnLaunchState === 'runtime_pending_permission' ||
    spawnStatus === 'error' ||
    spawnStatus === 'online' ||
    spawnStatus === 'skipped'
  ) {
    return false;
  }
  if (spawnLaunchState !== 'starting' && spawnStatus !== 'waiting' && spawnStatus !== 'spawning') {
    return false;
  }

  return hasElapsedSinceIso(
    spawnFirstSpawnAcceptedAt ?? spawnUpdatedAt,
    MEMBER_STARTING_STALE_AFTER_MS,
    nowMs
  );
}

function hasBootstrapStallDiagnostic(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase() ?? '';
  return (
    normalized.includes('no bootstrap check-in') ||
    normalized.includes('bootstrap is unconfirmed') ||
    normalized.includes('bootstrap unconfirmed')
  );
}

export function isOpenCodeRelaunchActionable({
  member,
  spawnEntry,
  runtimeEntry,
  nowMs = Date.now(),
}: {
  member: ResolvedTeamMember;
  spawnEntry?: MemberSpawnStatusEntry;
  runtimeEntry?: TeamAgentRuntimeEntry;
  nowMs?: number;
}): boolean {
  if (member.providerId !== 'opencode' || isLeadMember(member) || member.removedAt) {
    return false;
  }
  if (spawnEntry?.launchState === 'starting' || spawnEntry?.status === 'spawning') {
    return false;
  }
  if (spawnEntry?.launchState === 'runtime_pending_permission') {
    return false;
  }
  if (!spawnEntry) {
    const runtimeDiagnosticIsStuck = hasBootstrapStallDiagnostic(runtimeEntry?.runtimeDiagnostic);
    return (
      runtimeDiagnosticIsStuck ||
      runtimeEntry?.livenessKind === 'registered_only' ||
      runtimeEntry?.livenessKind === 'stale_metadata'
    );
  }
  if (
    spawnEntry?.launchState === 'failed_to_start' ||
    spawnEntry?.launchState === 'skipped_for_launch' ||
    spawnEntry?.status === 'error' ||
    spawnEntry?.status === 'skipped'
  ) {
    return true;
  }

  const livenessKind = runtimeEntry?.livenessKind ?? spawnEntry?.livenessKind;
  const acceptedSpawnGraceElapsed = hasElapsedSinceIso(
    spawnEntry?.firstSpawnAcceptedAt,
    OPENCODE_RUNTIME_CANDIDATE_RELAUNCH_GRACE_MS,
    nowMs
  );
  const hasExplicitBootstrapStall =
    spawnEntry?.bootstrapStalled === true ||
    hasBootstrapStallDiagnostic(spawnEntry?.runtimeDiagnostic) ||
    hasBootstrapStallDiagnostic(runtimeEntry?.runtimeDiagnostic);
  const launchIsNoLongerFresh =
    spawnEntry.launchState === 'confirmed_alive' ||
    spawnEntry.status === 'online' ||
    acceptedSpawnGraceElapsed ||
    hasExplicitBootstrapStall;

  if (
    livenessKind === 'registered_only' ||
    livenessKind === 'stale_metadata' ||
    livenessKind === 'not_found'
  ) {
    return launchIsNoLongerFresh;
  }
  if (livenessKind === 'runtime_process') {
    return hasExplicitBootstrapStall;
  }
  if (livenessKind !== 'runtime_process_candidate') {
    return false;
  }

  return acceptedSpawnGraceElapsed || hasExplicitBootstrapStall;
}

export function buildMemberLaunchPresentation({
  member,
  spawnStatus,
  spawnLaunchState,
  spawnLivenessSource,
  spawnRuntimeAlive,
  spawnBootstrapConfirmed,
  spawnBootstrapStalled,
  spawnAgentToolAccepted,
  spawnHardFailure,
  spawnLivenessKind,
  spawnFirstSpawnAcceptedAt,
  spawnUpdatedAt,
  runtimeAdvisory,
  runtimeEntry,
  isLaunchSettling = false,
  isTeamAlive,
  isTeamProvisioning,
  leadActivity,
  nowMs,
}: {
  member: ResolvedTeamMember;
  spawnStatus: MemberSpawnStatus | undefined;
  spawnLaunchState: MemberLaunchState | undefined;
  spawnLivenessSource: MemberSpawnLivenessSource | undefined;
  spawnRuntimeAlive: boolean | undefined;
  spawnBootstrapConfirmed?: boolean;
  spawnBootstrapStalled?: boolean;
  spawnAgentToolAccepted?: boolean;
  spawnHardFailure?: boolean;
  spawnLivenessKind?: TeamAgentRuntimeEntry['livenessKind'];
  spawnFirstSpawnAcceptedAt?: string;
  spawnUpdatedAt?: string;
  runtimeAdvisory: MemberRuntimeAdvisory | undefined;
  runtimeEntry?: TeamAgentRuntimeEntry;
  isLaunchSettling?: boolean;
  isTeamAlive?: boolean;
  isTeamProvisioning?: boolean;
  leadActivity?: LeadActivityState;
  nowMs?: number;
}): MemberLaunchPresentation {
  const currentRuntimeOfflineVisualState = getCurrentRuntimeOfflineVisualState(
    member,
    runtimeEntry,
    spawnStatus,
    spawnLaunchState,
    spawnRuntimeAlive,
    spawnBootstrapConfirmed,
    isTeamProvisioning
  );
  const hasConfirmedSpawnLaunch =
    spawnLaunchState === 'confirmed_alive' && spawnBootstrapConfirmed === true;
  const suppressOpenCodeAppMcpAdvisory = isHealthyOpenCodeAppMcpConnectivityAdvisory({
    providerId: member.providerId,
    runtimeAdvisory,
    spawnStatus,
    launchState: spawnLaunchState,
    runtimeAlive: spawnRuntimeAlive,
    bootstrapConfirmed: spawnBootstrapConfirmed,
    agentToolAccepted: spawnAgentToolAccepted,
    hardFailure: spawnHardFailure,
    livenessKind: spawnLivenessKind ?? runtimeEntry?.livenessKind,
    runtimeEntry,
  });
  const displayRuntimeAdvisory = suppressOpenCodeAppMcpAdvisory ? undefined : runtimeAdvisory;
  const effectiveSpawnStatus =
    hasConfirmedSpawnLaunch &&
    currentRuntimeOfflineVisualState == null &&
    (spawnStatus === 'waiting' || spawnStatus === 'spawning')
      ? 'online'
      : spawnStatus;
  const effectiveSpawnRuntimeAlive =
    currentRuntimeOfflineVisualState != null
      ? false
      : hasConfirmedSpawnLaunch
        ? true
        : spawnRuntimeAlive;
  const presenceLabel = getLaunchAwarePresenceLabel(
    member,
    effectiveSpawnStatus,
    spawnLaunchState,
    spawnLivenessSource,
    effectiveSpawnRuntimeAlive,
    displayRuntimeAdvisory,
    isLaunchSettling,
    isTeamAlive,
    isTeamProvisioning,
    leadActivity
  );
  const baseDotClass = getSpawnAwareDotClass(
    member,
    effectiveSpawnStatus,
    spawnLaunchState,
    effectiveSpawnRuntimeAlive,
    isLaunchSettling,
    isTeamAlive,
    isTeamProvisioning,
    leadActivity
  );
  const cardClass = getSpawnCardClass(
    effectiveSpawnStatus,
    spawnLaunchState,
    effectiveSpawnRuntimeAlive,
    isLaunchSettling,
    isTeamAlive,
    isTeamProvisioning
  );
  const runtimeAdvisoryLabel = getMemberRuntimeAdvisoryLabel(
    displayRuntimeAdvisory,
    member.providerId
  );
  const runtimeAdvisoryTitle = getMemberRuntimeAdvisoryTitle(
    displayRuntimeAdvisory,
    member.providerId
  );
  const runtimeAdvisoryTone = getMemberRuntimeAdvisoryTone(
    displayRuntimeAdvisory,
    member.providerId
  );
  const keepLaunchSettlingVisuals = isTeamProvisioning === true || isLaunchSettling;
  const startingIsStale =
    !hasConfirmedSpawnLaunch &&
    isMemberStartingStale({
      spawnStatus,
      spawnLaunchState,
      spawnFirstSpawnAcceptedAt,
      spawnUpdatedAt,
      nowMs,
    });

  let launchVisualState: MemberLaunchVisualState = null;
  if (isTeamAlive !== false || isTeamProvisioning) {
    if (spawnLaunchState === 'failed_to_start' || spawnStatus === 'error') {
      launchVisualState = 'error';
    } else if (spawnLaunchState === 'skipped_for_launch' || spawnStatus === 'skipped') {
      launchVisualState = 'skipped';
    } else if (spawnLaunchState === 'runtime_pending_permission') {
      launchVisualState = 'permission_pending';
    } else if (spawnBootstrapStalled === true) {
      launchVisualState = 'bootstrap_stalled';
    } else if (currentRuntimeOfflineVisualState != null) {
      launchVisualState = currentRuntimeOfflineVisualState;
    } else if (runtimeEntry?.livenessKind === 'shell_only') {
      launchVisualState = 'shell_only';
    } else if (runtimeEntry?.livenessKind === 'runtime_process_candidate') {
      launchVisualState = 'runtime_candidate';
    } else if (!hasConfirmedSpawnLaunch && startingIsStale) {
      launchVisualState = 'starting_stale';
    } else if (
      !hasConfirmedSpawnLaunch &&
      isQueuedOpenCodeLaunch(
        member,
        spawnStatus,
        spawnLaunchState,
        runtimeEntry,
        isLaunchSettling,
        isTeamProvisioning
      )
    ) {
      launchVisualState = 'queued';
    } else if (
      !hasConfirmedSpawnLaunch &&
      isLaunchStillStarting(
        spawnStatus,
        spawnLaunchState,
        spawnRuntimeAlive,
        keepLaunchSettlingVisuals
      )
    ) {
      launchVisualState = spawnStatus === 'spawning' ? 'spawning' : 'waiting';
    } else if (
      !hasConfirmedSpawnLaunch &&
      spawnLaunchState === 'runtime_pending_bootstrap' &&
      (runtimeEntry?.livenessKind === 'runtime_process' ||
        (spawnStatus === 'online' && spawnRuntimeAlive === true))
    ) {
      launchVisualState = 'runtime_pending';
    } else if (isLaunchSettling && spawnLaunchState === 'confirmed_alive') {
      launchVisualState = 'settling';
    }
  }

  const launchStatusLabel = getMemberLaunchStatusLabel(launchVisualState);
  const launchVisualStateDotClass = getLaunchVisualStateDotClass(launchVisualState);
  const shouldShowLaunchStatusAsPresence =
    launchVisualState === 'queued' ||
    launchVisualState === 'starting_stale' ||
    launchVisualState === 'permission_pending' ||
    launchVisualState === 'bootstrap_stalled' ||
    launchVisualState === 'runtime_pending' ||
    launchVisualState === 'shell_only' ||
    launchVisualState === 'runtime_candidate' ||
    launchVisualState === 'registered_only' ||
    launchVisualState === 'stale_runtime';
  const displayPresenceLabel =
    runtimeAdvisoryTone === 'error' && runtimeAdvisoryLabel
      ? runtimeAdvisoryLabel
      : shouldShowLaunchStatusAsPresence
        ? (launchStatusLabel ?? presenceLabel)
        : presenceLabel;
  const spawnBadgeLabel =
    spawnStatus && spawnStatus !== 'online'
      ? spawnStatus === 'waiting' || spawnStatus === 'spawning'
        ? startingIsStale
          ? 'starting stale'
          : 'starting'
        : spawnStatus
      : null;

  return {
    presenceLabel: displayPresenceLabel,
    dotClass:
      runtimeAdvisoryTone === 'error'
        ? STATUS_DOT_COLORS.terminated
        : (launchVisualStateDotClass ?? baseDotClass),
    cardClass: launchVisualState === 'starting_stale' ? 'opacity-90' : cardClass,
    runtimeAdvisoryLabel,
    runtimeAdvisoryTitle,
    runtimeAdvisoryTone,
    launchVisualState,
    launchStatusLabel,
    spawnBadgeLabel,
  };
}

export const TASK_STATUS_STYLES: Record<TeamTaskStatus, { bg: string; text: string }> = {
  pending: { bg: 'bg-zinc-500/15', text: 'text-zinc-400' },
  in_progress: { bg: 'bg-blue-500/15', text: 'text-blue-400' },
  completed: { bg: 'bg-emerald-500/15', text: 'text-emerald-400' },
  deleted: { bg: 'bg-red-500/15', text: 'text-red-400' },
};

export const TASK_STATUS_LABELS: Record<TeamTaskStatus, string> = {
  pending: 'Pending',
  in_progress: 'In Progress',
  completed: 'Completed',
  deleted: 'Deleted',
};

interface MemberColorInput {
  name: string;
  color?: string;
  removedAt?: number | string | null;
  agentType?: string;
  role?: string;
}

interface MemberAvatarInput {
  name: string;
  removedAt?: number | string | null;
  agentType?: string;
}

/**
 * Build a consistent name→colorName map for all members.
 * Active members receive colors sequentially from MEMBER_COLOR_PALETTE,
 * which is pre-ordered for maximum visual contrast between consecutive entries.
 * If a member has a stored color that hasn't been assigned yet, it is used instead.
 * Maps "user" to a reserved color.
 */
export function buildMemberColorMap(members: MemberColorInput[]): Map<string, string> {
  return buildTeamMemberColorMap(members, { preferProvidedColors: true });
}

export function buildMemberAvatarMap(members: readonly MemberAvatarInput[]): Map<string, string> {
  const map = new Map<string, string>();
  const activeMembers = members.filter((member) => !member.removedAt);
  const leadMembers = activeMembers.filter((member) => isLeadMember(member));
  const teammateMembers = activeMembers.filter((member) => !isLeadMember(member));

  for (const [index, member] of leadMembers.entries()) {
    map.set(member.name, index === 0 ? LEAD_PARTICIPANT_AVATAR_URL : agentAvatarUrl(member.name));
  }

  for (const [index, member] of teammateMembers.entries()) {
    map.set(
      member.name,
      getParticipantAvatarUrlByIndex(1 + (index % (PARTICIPANT_AVATAR_URLS.length - 1)))
    );
  }

  for (const member of members) {
    if (!map.has(member.name)) {
      map.set(
        member.name,
        isLeadMember(member) ? LEAD_PARTICIPANT_AVATAR_URL : agentAvatarUrl(member.name)
      );
    }
  }

  map.set('user', agentAvatarUrl('user'));
  map.set('system', agentAvatarUrl('system'));

  return map;
}

export function resolveMemberAvatarUrl(
  member: MemberAvatarInput,
  avatarMap?: ReadonlyMap<string, string>,
  size = 64
): string {
  return (
    avatarMap?.get(member.name) ??
    (isLeadMember(member) ? LEAD_PARTICIPANT_AVATAR_URL : agentAvatarUrl(member.name, size))
  );
}

export const KANBAN_COLUMN_DISPLAY: Record<
  'review' | 'approved',
  { label: string; bg: string; text: string }
> = {
  review: { label: 'In Review', bg: 'bg-amber-500/15', text: 'text-amber-400' },
  approved: { label: 'Approved', bg: 'bg-emerald-500/15', text: 'text-emerald-400' },
};

export const REVIEW_STATE_DISPLAY: Record<
  Exclude<TeamReviewState, 'none'>,
  { label: string; bg: string; text: string }
> = {
  review: { label: 'In Review', bg: 'bg-amber-500/15', text: 'text-amber-400' },
  needsFix: { label: 'Needs Fixes', bg: 'bg-rose-500/15', text: 'text-rose-400' },
  approved: { label: 'Approved', bg: 'bg-emerald-500/15', text: 'text-emerald-400' },
};
