import { getMemberColorByName, MEMBER_COLOR_PALETTE } from '@shared/constants/memberColors';

import type {
  LeadActivityState,
  MemberSpawnStatus,
  MemberStatus,
  ResolvedTeamMember,
  TeamReviewState,
  TeamTaskStatus,
} from '@shared/types';

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
  if (isTeamProvisioning) return STATUS_DOT_COLORS.unknown;
  if (isTeamAlive === false) return STATUS_DOT_COLORS.terminated;
  if (leadActivity && member.agentType === 'team-lead') {
    return leadActivity === 'active'
      ? `${STATUS_DOT_COLORS.active} animate-pulse`
      : STATUS_DOT_COLORS.active;
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
  if (isTeamProvisioning) return 'connecting';
  if (isTeamAlive === false) return 'offline';
  if (leadActivity && member.agentType === 'team-lead') {
    if (leadActivity === 'active') {
      return leadContextPercent != null && leadContextPercent > 0
        ? `processing (${Math.round(leadContextPercent)}%)`
        : 'processing';
    }
    return 'ready';
  }
  if (member.status === 'unknown') return 'idle';
  return member.currentTaskId ? 'working' : 'idle';
}

/* ------------------------------------------------------------------ */
/*  Spawn-status-aware helpers for progressive member card appearance  */
/* ------------------------------------------------------------------ */

export const SPAWN_DOT_COLORS: Record<MemberSpawnStatus, string> = {
  offline: 'bg-zinc-600',
  spawning: 'bg-amber-400 animate-pulse',
  online: 'bg-emerald-400',
  error: 'bg-red-400',
};

export const SPAWN_PRESENCE_LABELS: Record<MemberSpawnStatus, string> = {
  offline: 'offline',
  spawning: 'spawning',
  online: 'online',
  error: 'spawn failed',
};

/**
 * Returns dot class for a member during provisioning, respecting spawn status.
 * Falls back to the existing `getMemberDotClass` when no spawn status is available.
 */
export function getSpawnAwareDotClass(
  member: ResolvedTeamMember,
  spawnStatus: MemberSpawnStatus | undefined,
  isTeamAlive?: boolean,
  isTeamProvisioning?: boolean,
  leadActivity?: LeadActivityState
): string {
  if (spawnStatus && isTeamProvisioning) {
    return SPAWN_DOT_COLORS[spawnStatus];
  }
  return getMemberDotClass(member, isTeamAlive, isTeamProvisioning, leadActivity);
}

/**
 * Returns presence label for a member during provisioning, respecting spawn status.
 */
export function getSpawnAwarePresenceLabel(
  member: ResolvedTeamMember,
  spawnStatus: MemberSpawnStatus | undefined,
  isTeamAlive?: boolean,
  isTeamProvisioning?: boolean,
  leadActivity?: LeadActivityState
): string {
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
    case 'spawning':
      return 'opacity-70 animate-[member-spawn-pulse_2s_ease-in-out_infinite]';
    case 'online':
      return 'animate-[member-fade-in_0.4s_ease-out]';
    case 'error':
      return 'opacity-80';
    default:
      return '';
  }
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
 * Deduplicates colors: first member (alphabetically) keeps its stored color,
 * subsequent collisions get the next unused palette color.
 * Also maps "user" to a reserved color.
 */
export function buildMemberColorMap(members: MemberColorInput[]): Map<string, string> {
  const map = new Map<string, string>();
  const active = members.filter((m) => !m.removedAt);
  const removed = members.filter((m) => m.removedAt);
  const usedColors = new Set<string>();

  const paletteSize = MEMBER_COLOR_PALETTE.length;
  for (const member of active) {
    let color = member.color;
    if (!color || usedColors.has(color)) {
      // Deterministic fallback: hash the member name to a palette color.
      // If that color is already taken, linear-probe for the next free one.
      color = getMemberColorByName(member.name);
      if (usedColors.has(color)) {
        const startIdx = MEMBER_COLOR_PALETTE.indexOf(
          color as (typeof MEMBER_COLOR_PALETTE)[number]
        );
        for (let offset = 1; offset < paletteSize; offset++) {
          const candidate = MEMBER_COLOR_PALETTE[(startIdx + offset) % paletteSize];
          if (!usedColors.has(candidate)) {
            color = candidate;
            break;
          }
        }
      }
    }
    map.set(member.name, color);
    usedColors.add(color);
  }

  for (let i = 0; i < removed.length; i++) {
    map.set(removed[i].name, removed[i].color ?? getMemberColorByName(removed[i].name));
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
