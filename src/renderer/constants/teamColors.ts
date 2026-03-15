/**
 * Team Color Constants
 *
 * Shared color definitions for team member visualization.
 * Used by TeammateMessageItem and SubagentItem when displaying team members.
 */

import { MEMBER_COLOR_HUE, MEMBER_COLOR_PALETTE } from '@shared/constants/memberColors';

export interface TeamColorSet {
  /** Border accent color */
  border: string;
  /** Border accent color for light theme */
  borderLight?: string;
  /** Badge background (semi-transparent) */
  badge: string;
  /** Badge background for light theme (more visible on white) */
  badgeLight?: string;
  /** Text color for labels (dark theme) */
  text: string;
  /** Text color for labels on light backgrounds (higher contrast) */
  textLight?: string;
}

const TEAMMATE_COLORS: Record<string, TeamColorSet> = {
  blue: {
    border: '#3b82f6',
    badge: 'rgba(59, 130, 246, 0.15)',
    badgeLight: 'rgba(59, 130, 246, 0.12)',
    text: '#60a5fa',
    textLight: '#2563eb',
  },
  green: {
    border: '#22c55e',
    badge: 'rgba(34, 197, 94, 0.15)',
    badgeLight: 'rgba(34, 197, 94, 0.12)',
    text: '#4ade80',
    textLight: '#16a34a',
  },
  red: {
    border: '#ef4444',
    badge: 'rgba(239, 68, 68, 0.15)',
    badgeLight: 'rgba(239, 68, 68, 0.12)',
    text: '#f87171',
    textLight: '#dc2626',
  },
  yellow: {
    border: '#eab308',
    badge: 'rgba(234, 179, 8, 0.15)',
    badgeLight: 'rgba(161, 98, 7, 0.12)',
    text: '#facc15',
    textLight: '#a16207',
  },
  purple: {
    border: '#a855f7',
    badge: 'rgba(168, 85, 247, 0.15)',
    badgeLight: 'rgba(168, 85, 247, 0.12)',
    text: '#c084fc',
    textLight: '#7c3aed',
  },
  cyan: {
    border: '#06b6d4',
    badge: 'rgba(6, 182, 212, 0.15)',
    badgeLight: 'rgba(6, 182, 212, 0.12)',
    text: '#22d3ee',
    textLight: '#0891b2',
  },
  orange: {
    border: '#f97316',
    badge: 'rgba(249, 115, 22, 0.15)',
    badgeLight: 'rgba(249, 115, 22, 0.12)',
    text: '#fb923c',
    textLight: '#c2410c',
  },
  pink: {
    border: '#ec4899',
    badge: 'rgba(236, 72, 153, 0.15)',
    badgeLight: 'rgba(236, 72, 153, 0.12)',
    text: '#f472b6',
    textLight: '#db2777',
  },
  magenta: {
    border: '#d946ef',
    badge: 'rgba(217, 70, 239, 0.15)',
    badgeLight: 'rgba(217, 70, 239, 0.12)',
    text: '#e879f9',
    textLight: '#a21caf',
  },
  /** Reserved for the human user — never assigned to team members. */
  user: {
    border: '#f5f5f4',
    borderLight: '#78716c',
    badge: 'rgba(245, 245, 244, 0.12)',
    badgeLight: 'rgba(87, 83, 78, 0.18)',
    text: '#d6d3d1',
    textLight: '#44403c',
  },
};

const DEFAULT_COLOR: TeamColorSet = TEAMMATE_COLORS.blue;

/**
 * Get a TeamColorSet from a color name or hex string.
 * Falls back to blue if unrecognized.
 */
const COLOR_NAMES = Object.keys(TEAMMATE_COLORS);

function hashString(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = (hash * 31 + str.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
}

export function getSubagentTypeColorSet(
  subagentType: string,
  agentConfigs?: Record<string, { name?: string; color?: string }>
): TeamColorSet {
  // Use color from agent config if available
  const configColor = agentConfigs?.[subagentType]?.color;
  if (configColor) {
    return getTeamColorSet(configColor);
  }
  // Fallback: deterministic hash-based color
  const index = hashString(subagentType) % COLOR_NAMES.length;
  return TEAMMATE_COLORS[COLOR_NAMES[index]];
}

/** Assignable visual colors (excludes reserved 'user'). */
const ASSIGNABLE_COLORS = COLOR_NAMES.filter((c) => c !== 'user');

function hsla(hue: number, saturation: number, lightness: number, alpha = 1): string {
  return `hsla(${hue}, ${saturation}%, ${lightness}%, ${alpha})`;
}

function buildGeneratedMemberColorSet(colorName: string): TeamColorSet | null {
  const hue = MEMBER_COLOR_HUE[colorName];
  if (hue === undefined) {
    // Also accept palette names not in the hue map (shouldn't happen, but safe fallback)
    const paletteIndex = MEMBER_COLOR_PALETTE.indexOf(
      colorName as (typeof MEMBER_COLOR_PALETTE)[number]
    );
    if (paletteIndex === -1) return null;
    // Fall back to index-based hue (legacy behavior)
    return buildColorSetFromHue(Math.round((paletteIndex / MEMBER_COLOR_PALETTE.length) * 360));
  }

  return buildColorSetFromHue(hue);
}

function buildColorSetFromHue(hue: number): TeamColorSet {
  const saturation = 72;

  return {
    border: hsla(hue, saturation, 50),
    borderLight: hsla(hue, saturation, 44),
    badge: hsla(hue, saturation, 50, 0.15),
    badgeLight: hsla(hue, saturation, 50, 0.12),
    text: hsla(hue, 78, 66),
    textLight: hsla(hue, 82, 36),
  };
}

export function getTeamColorSet(colorName: string): TeamColorSet {
  if (!colorName) return DEFAULT_COLOR;

  // Check named colors
  const named = TEAMMATE_COLORS[colorName.toLowerCase()];
  if (named) return named;

  const generatedMemberColor = buildGeneratedMemberColorSet(colorName.toLowerCase());
  if (generatedMemberColor) return generatedMemberColor;

  // If it's a hex color, generate a set from it
  if (colorName.startsWith('#')) {
    return {
      border: colorName,
      badge: `${colorName}26`,
      text: colorName,
    };
  }

  // Hash unknown palette names (e.g. "coral", "sapphire") to one of the
  // available visual colors instead of always falling back to blue.
  const index = hashString(colorName.toLowerCase()) % ASSIGNABLE_COLORS.length;
  return TEAMMATE_COLORS[ASSIGNABLE_COLORS[index]];
}

/**
 * Get the appropriate badge background for the current theme.
 * Uses badgeLight in light theme when available, falls back to badge.
 */
export function getThemedBadge(colorSet: TeamColorSet, isLight: boolean): string {
  return isLight && colorSet.badgeLight ? colorSet.badgeLight : colorSet.badge;
}

/**
 * Get the appropriate text color for the current theme.
 */
export function getThemedText(colorSet: TeamColorSet, isLight: boolean): string {
  return isLight && colorSet.textLight ? colorSet.textLight : colorSet.text;
}

/**
 * Get the appropriate border color for the current theme.
 */
export function getThemedBorder(colorSet: TeamColorSet, isLight: boolean): string {
  return isLight && colorSet.borderLight ? colorSet.borderLight : colorSet.border;
}
