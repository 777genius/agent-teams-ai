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
    border: '#a8a29e',
    borderLight: '#57534e',
    badge: 'rgba(168, 162, 158, 0.18)',
    badgeLight: 'rgba(68, 64, 60, 0.14)',
    text: '#d6d3d1',
    textLight: '#292524',
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

function normalizeHexColor(color: string): string | null {
  const trimmed = color.trim();
  const shortHexMatch = /^#([\da-f]{3,4})$/i.exec(trimmed);
  if (shortHexMatch) {
    const expanded = shortHexMatch[1]
      .slice(0, 3)
      .split('')
      .map((char) => char + char)
      .join('');
    return `#${expanded.toLowerCase()}`;
  }

  const longHexMatch = /^#([\da-f]{6})([\da-f]{2})?$/i.exec(trimmed);
  if (longHexMatch) {
    return `#${longHexMatch[1].toLowerCase()}`;
  }

  return null;
}

function hexToRgb(color: string): { r: number; g: number; b: number } | null {
  const normalized = normalizeHexColor(color);
  if (!normalized) return null;

  return {
    r: parseInt(normalized.slice(1, 3), 16),
    g: parseInt(normalized.slice(3, 5), 16),
    b: parseInt(normalized.slice(5, 7), 16),
  };
}

function rgbToHsl(r: number, g: number, b: number): { h: number; s: number; l: number } {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const delta = max - min;
  const lightness = (max + min) / 2;

  if (delta === 0) {
    return { h: 0, s: 0, l: lightness * 100 };
  }

  let hue = 0;
  if (max === rn) {
    hue = ((gn - bn) / delta) % 6;
  } else if (max === gn) {
    hue = (bn - rn) / delta + 2;
  } else {
    hue = (rn - gn) / delta + 4;
  }

  hue = Math.round(hue * 60);
  if (hue < 0) hue += 360;

  const saturation = delta / (1 - Math.abs(2 * lightness - 1));
  return {
    h: hue,
    s: saturation * 100,
    l: lightness * 100,
  };
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

function buildColorSetFromHex(color: string): TeamColorSet {
  const normalized = normalizeHexColor(color);
  const rgb = normalized ? hexToRgb(normalized) : null;
  if (!normalized || !rgb) {
    return {
      border: color,
      badge: `${color}26`,
      text: color,
    };
  }

  const { h } = rgbToHsl(rgb.r, rgb.g, rgb.b);
  const derived = buildColorSetFromHue(h);

  return {
    ...derived,
    border: normalized,
    badge: `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.15)`,
    badgeLight: `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.12)`,
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
    return buildColorSetFromHex(colorName);
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

export function scaleColorAlpha(color: string, factor: number): string {
  const safeFactor = Math.max(0, factor);
  const rgbaMatch = /^rgba\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*([0-9]*\.?[0-9]+)\s*\)$/i.exec(
    color
  );
  if (rgbaMatch) {
    const [, r, g, b, alpha] = rgbaMatch;
    return `rgba(${r}, ${g}, ${b}, ${Number(alpha) * safeFactor})`;
  }

  const hslaMatch =
    /^hsla\(\s*([^,]+)\s*,\s*([^,]+)\s*,\s*([^,]+)\s*,\s*([0-9]*\.?[0-9]+)\s*\)$/i.exec(color);
  if (hslaMatch) {
    const [, hue, saturation, lightness, alpha] = hslaMatch;
    return `hsla(${hue}, ${saturation}, ${lightness}, ${Number(alpha) * safeFactor})`;
  }

  const hexAlphaMatch = /^#([\da-f]{6})([\da-f]{2})$/i.exec(color);
  if (hexAlphaMatch) {
    const [, hex, alphaHex] = hexAlphaMatch;
    const alpha = parseInt(alphaHex, 16) / 255;
    const scaledAlpha = Math.max(0, Math.min(255, Math.round(alpha * safeFactor * 255)));
    return `#${hex}${scaledAlpha.toString(16).padStart(2, '0')}`;
  }

  return color;
}
