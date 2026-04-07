import {
  getMemberColorByName,
  MEMBER_COLOR_PALETTE,
  normalizeMemberColorName,
} from '@shared/constants/memberColors';
import { isLeadMember } from '@shared/utils/leadDetection';

import type {
  LeadActivityState,
  MemberLaunchState,
  MemberRuntimeAdvisory,
  MemberSpawnLivenessSource,
  MemberSpawnStatus,
  MemberStatus,
  ResolvedTeamMember,
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

export function agentAvatarUrl(name: string, size = 64): string {
  return `https://robohash.org/${encodeURIComponent(name)}?size=${size}x${size}`;
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

/**
 * Returns dot class for a member during provisioning, respecting spawn status.
 * Falls back to the existing `getMemberDotClass` when no spawn status is available.
 */
export function getSpawnAwareDotClass(
  member: ResolvedTeamMember,
  spawnStatus: MemberSpawnStatus | undefined,
  spawnLaunchState: MemberLaunchState | undefined,
  isTeamAlive?: boolean,
  isTeamProvisioning?: boolean,
  leadActivity?: LeadActivityState
): string {
  if (spawnLaunchState === 'failed_to_start' || spawnStatus === 'error') {
    return SPAWN_DOT_COLORS.error;
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
  isTeamAlive?: boolean,
  isTeamProvisioning?: boolean,
  leadActivity?: LeadActivityState
): string {
  if (spawnLaunchState === 'failed_to_start' || spawnStatus === 'error') {
    return SPAWN_PRESENCE_LABELS.error;
  }
  if (spawnStatus === 'offline' && isTeamProvisioning) {
    return 'waiting for Agent';
  }
  if (spawnLaunchState === 'runtime_pending_bootstrap' && runtimeAlive) {
    return 'online';
  }
  if (spawnStatus === 'waiting') {
    return SPAWN_PRESENCE_LABELS.waiting;
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
export function getSpawnCardClass(spawnStatus: MemberSpawnStatus | undefined): string {
  switch (spawnStatus) {
    case 'offline':
      return 'opacity-40';
    case 'waiting':
      return 'member-waiting-shimmer';
    case 'spawning':
      return '';
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

export function getMemberRuntimeAdvisoryLabel(
  advisory: MemberRuntimeAdvisory | undefined,
  nowMs = Date.now()
): string | null {
  if (!advisory || advisory.kind !== 'sdk_retrying') {
    return null;
  }
  const retryUntilMs = Date.parse(advisory.retryUntil);
  if (!Number.isFinite(retryUntilMs)) {
    return 'retrying now';
  }
  const remainingMs = retryUntilMs - nowMs;
  if (remainingMs <= 0) {
    return 'retrying now';
  }
  return `retrying now · ${formatRetryCountdown(remainingMs)}`;
}

export function getMemberRuntimeAdvisoryTitle(
  advisory: MemberRuntimeAdvisory | undefined
): string | undefined {
  if (!advisory || advisory.kind !== 'sdk_retrying') {
    return undefined;
  }
  return (
    advisory.message?.trim() ||
    'The SDK is retrying this request after a provider or backend error.'
  );
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

/**
 * Build a consistent name→colorName map for all members.
 * Active members receive colors sequentially from MEMBER_COLOR_PALETTE,
 * which is pre-ordered for maximum visual contrast between consecutive entries.
 * If a member has a stored color that hasn't been assigned yet, it is used instead.
 * Maps "user" to a reserved color.
 */
export function buildMemberColorMap(members: MemberColorInput[]): Map<string, string> {
  const map = new Map<string, string>();
  const active = members.filter((m) => !m.removedAt);
  const removed = members.filter((m) => m.removedAt);
  const usedColors = new Set<string>();
  let nextPaletteIdx = 0;

  for (const member of active) {
    let color = member.color ? normalizeMemberColorName(member.color) : undefined;
    if (!color || usedColors.has(color)) {
      // Assign the next unused color from the pre-ordered palette.
      while (
        nextPaletteIdx < MEMBER_COLOR_PALETTE.length &&
        usedColors.has(MEMBER_COLOR_PALETTE[nextPaletteIdx])
      ) {
        nextPaletteIdx++;
      }
      color =
        nextPaletteIdx < MEMBER_COLOR_PALETTE.length
          ? MEMBER_COLOR_PALETTE[nextPaletteIdx]
          : MEMBER_COLOR_PALETTE[active.indexOf(member) % MEMBER_COLOR_PALETTE.length];
      nextPaletteIdx++;
    }
    map.set(member.name, color);
    usedColors.add(color);
  }

  for (const member of removed) {
    const color = member.color
      ? normalizeMemberColorName(member.color)
      : getMemberColorByName(member.name);
    map.set(member.name, color);
  }

  map.set('user', 'user');

  return map;
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
