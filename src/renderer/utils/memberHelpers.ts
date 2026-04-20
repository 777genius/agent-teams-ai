import { buildTeamMemberColorMap } from '@shared/utils/teamMemberColors';
import { isLeadMember } from '@shared/utils/leadDetection';

import {
  getParticipantAvatarUrlByIndex,
  LEAD_PARTICIPANT_AVATAR_URL,
  PARTICIPANT_AVATAR_URLS,
} from './memberAvatarCatalog';

import type {
  LeadActivityState,
  MemberLaunchState,
  MemberRuntimeAdvisory,
  MemberSpawnLivenessSource,
  MemberSpawnStatus,
  MemberStatus,
  ResolvedTeamMember,
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
  online: 'bg-emerald-400 animate-[dot-online-jelly_0.45s_ease-out]',
  error: 'bg-red-400',
};

export const SPAWN_PRESENCE_LABELS: Record<MemberSpawnStatus, string> = {
  offline: 'offline',
  waiting: 'starting',
  spawning: 'starting',
  online: 'ready',
  error: 'spawn failed',
};

function isLaunchStillStarting(
  spawnStatus: MemberSpawnStatus | undefined,
  spawnLaunchState: MemberLaunchState | undefined,
  runtimeAlive: boolean | undefined,
  keepRuntimePendingInStarting = false
): boolean {
  if (spawnLaunchState === 'failed_to_start') {
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
  const seconds = totalSeconds % 60;
  return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
}

function getRuntimeAdvisoryProviderLabel(providerId: TeamProviderId | undefined): string | null {
  switch (providerId) {
    case 'anthropic':
      return 'Anthropic';
    case 'codex':
      return 'Codex';
    case 'gemini':
      return 'Gemini';
    default:
      return null;
  }
}

function appendRuntimeAdvisoryRawMessage(base: string, message: string | undefined): string {
  const trimmed = message?.trim();
  return trimmed ? `${base}\n\n${trimmed}` : base;
}

function formatRuntimeAdvisoryBaseLabel(
  advisory: MemberRuntimeAdvisory,
  providerId: TeamProviderId | undefined
): string {
  const providerLabel = getRuntimeAdvisoryProviderLabel(providerId);
  switch (advisory.reasonCode) {
    case 'quota_exhausted':
      return providerLabel ? `${providerLabel} quota retry` : 'Quota retry';
    case 'rate_limited':
      return providerLabel ? `${providerLabel} rate limit` : 'Rate limit retry';
    case 'auth_error':
      return providerLabel ? `${providerLabel} auth retry` : 'Auth retry';
    case 'network_error':
      return 'Network retry';
    case 'provider_overloaded':
      return providerLabel ? `${providerLabel} overload retry` : 'Provider overload retry';
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
  switch (advisory.reasonCode) {
    case 'quota_exhausted':
      return appendRuntimeAdvisoryRawMessage(
        `${providerLabel ?? 'Provider'} quota exhausted. SDK is retrying automatically.`,
        advisory.message
      );
    case 'rate_limited':
      return appendRuntimeAdvisoryRawMessage(
        `${providerLabel ?? 'Provider'} rate limited the request. SDK is retrying automatically.`,
        advisory.message
      );
    case 'auth_error':
      return appendRuntimeAdvisoryRawMessage(
        `${providerLabel ?? 'Provider'} authentication issue. SDK is retrying automatically.`,
        advisory.message
      );
    case 'network_error':
      return appendRuntimeAdvisoryRawMessage(
        'Network or connectivity issue. SDK is retrying automatically.',
        advisory.message
      );
    case 'provider_overloaded':
      return appendRuntimeAdvisoryRawMessage(
        'Provider is temporarily overloaded. SDK is retrying automatically.',
        advisory.message
      );
    case 'backend_error':
    case 'unknown':
      return appendRuntimeAdvisoryRawMessage(
        'The SDK is retrying this request after a provider or backend error.',
        advisory.message
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
  if (advisory?.kind !== 'sdk_retrying') {
    return null;
  }
  const baseLabel = formatRuntimeAdvisoryBaseLabel(advisory, providerId);
  const retryUntilMs = Date.parse(advisory.retryUntil);
  if (!Number.isFinite(retryUntilMs)) {
    return baseLabel;
  }
  const remainingMs = retryUntilMs - nowMs;
  if (remainingMs <= 0) {
    return baseLabel;
  }
  return `${baseLabel} · ${formatRetryCountdown(remainingMs)}`;
}

export function getMemberRuntimeAdvisoryTitle(
  advisory: MemberRuntimeAdvisory | undefined,
  providerId?: TeamProviderId
): string | undefined {
  if (advisory?.kind !== 'sdk_retrying') {
    return undefined;
  }
  return formatRuntimeAdvisoryTitle(advisory, providerId);
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
    basePresenceLabel === 'offline' ||
    basePresenceLabel === 'terminated'
  ) {
    return basePresenceLabel;
  }
  const advisoryLabel = getMemberRuntimeAdvisoryLabel(runtimeAdvisory, member.providerId);
  return advisoryLabel ?? basePresenceLabel;
}

export type MemberLaunchVisualState =
  | 'waiting'
  | 'spawning'
  | 'runtime_pending'
  | 'settling'
  | 'error'
  | null;

export interface MemberLaunchPresentation {
  presenceLabel: string;
  dotClass: string;
  cardClass: string;
  runtimeAdvisoryLabel: string | null;
  runtimeAdvisoryTitle?: string;
  launchVisualState: MemberLaunchVisualState;
  launchStatusLabel: string | null;
  spawnBadgeLabel: string | null;
}

export function getMemberLaunchStatusLabel(visualState: MemberLaunchVisualState): string | null {
  switch (visualState) {
    case 'waiting':
      return 'waiting to start';
    case 'spawning':
      return 'starting';
    case 'runtime_pending':
      return 'connecting';
    case 'settling':
      return 'joining team';
    case 'error':
      return 'failed';
    default:
      return null;
  }
}

export function buildMemberLaunchPresentation({
  member,
  spawnStatus,
  spawnLaunchState,
  spawnLivenessSource,
  spawnRuntimeAlive,
  runtimeAdvisory,
  isLaunchSettling = false,
  isTeamAlive,
  isTeamProvisioning,
  leadActivity,
}: {
  member: ResolvedTeamMember;
  spawnStatus: MemberSpawnStatus | undefined;
  spawnLaunchState: MemberLaunchState | undefined;
  spawnLivenessSource: MemberSpawnLivenessSource | undefined;
  spawnRuntimeAlive: boolean | undefined;
  runtimeAdvisory: MemberRuntimeAdvisory | undefined;
  isLaunchSettling?: boolean;
  isTeamAlive?: boolean;
  isTeamProvisioning?: boolean;
  leadActivity?: LeadActivityState;
}): MemberLaunchPresentation {
  const presenceLabel = getLaunchAwarePresenceLabel(
    member,
    spawnStatus,
    spawnLaunchState,
    spawnLivenessSource,
    spawnRuntimeAlive,
    runtimeAdvisory,
    isLaunchSettling,
    isTeamAlive,
    isTeamProvisioning,
    leadActivity
  );
  const dotClass = getSpawnAwareDotClass(
    member,
    spawnStatus,
    spawnLaunchState,
    spawnRuntimeAlive,
    isLaunchSettling,
    isTeamAlive,
    isTeamProvisioning,
    leadActivity
  );
  const cardClass = getSpawnCardClass(
    spawnStatus,
    spawnLaunchState,
    spawnRuntimeAlive,
    isLaunchSettling,
    isTeamAlive,
    isTeamProvisioning
  );
  const runtimeAdvisoryLabel = getMemberRuntimeAdvisoryLabel(runtimeAdvisory, member.providerId);
  const runtimeAdvisoryTitle = getMemberRuntimeAdvisoryTitle(runtimeAdvisory, member.providerId);
  const keepLaunchSettlingVisuals = isTeamProvisioning === true || isLaunchSettling;

  let launchVisualState: MemberLaunchVisualState = null;
  if (isTeamAlive !== false || isTeamProvisioning) {
    if (spawnLaunchState === 'failed_to_start' || spawnStatus === 'error') {
      launchVisualState = 'error';
    } else if (
      spawnLaunchState === 'runtime_pending_bootstrap' &&
      spawnStatus === 'online' &&
      spawnRuntimeAlive === true
    ) {
      launchVisualState = 'runtime_pending';
    } else if (
      isLaunchStillStarting(
        spawnStatus,
        spawnLaunchState,
        spawnRuntimeAlive,
        keepLaunchSettlingVisuals
      )
    ) {
      launchVisualState = spawnStatus === 'spawning' ? 'spawning' : 'waiting';
    } else if (
      isLaunchSettling &&
      spawnStatus === 'online' &&
      spawnLaunchState === 'confirmed_alive'
    ) {
      launchVisualState = 'settling';
    }
  }

  const launchStatusLabel = getMemberLaunchStatusLabel(launchVisualState);
  const spawnBadgeLabel =
    spawnStatus && spawnStatus !== 'online'
      ? spawnStatus === 'waiting' || spawnStatus === 'spawning'
        ? 'starting'
        : spawnStatus
      : null;

  return {
    presenceLabel,
    dotClass,
    cardClass,
    runtimeAdvisoryLabel,
    runtimeAdvisoryTitle,
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
