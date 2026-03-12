/**
 * Default color palette for team members.
 * Intentionally excludes purple-family tones for member UI.
 */
export const MEMBER_COLOR_PALETTE = [
  // ── Primary & classic ──
  'blue',
  'green',
  'yellow',
  'cyan',
  'red',
  'orange',
  'pink',

  // ── Red family ──
  'rose',
  'coral',
  'crimson',
  'scarlet',
  'tomato',
  'salmon',
  'brick',
  'ruby',

  // ── Orange / warm family ──
  'amber',
  'tangerine',
  'peach',
  'rust',
  'copper',
  'apricot',
  'bronze',
  'sienna',

  // ── Yellow / gold family ──
  'gold',
  'lemon',
  'mustard',
  'honey',
  'saffron',
  'marigold',
  'canary',
  'sunflower',

  // ── Green family ──
  'emerald',
  'lime',
  'mint',
  'forest',
  'olive',
  'jade',
  'sage',
  'chartreuse',

  // ── Cyan / teal family ──
  'teal',
  'aqua',
  'turquoise',
  'sky',
  'azure',
  'cerulean',
  'seafoam',
  'arctic',

  // ── Blue / indigo family ──
  'cobalt',
  'indigo',
  'sapphire',
  'periwinkle',
  'denim',
  'steel',
  'royal',
  'cornflower',
] as const;

export type MemberColorName = (typeof MEMBER_COLOR_PALETTE)[number];

const DISALLOWED_MEMBER_COLORS = new Set([
  'purple',
  'violet',
  'plum',
  'amethyst',
  'lavender',
  'orchid',
  'magenta',
  'fuchsia',
  'berry',
]);

export function getMemberColor(index: number): string {
  return MEMBER_COLOR_PALETTE[index % MEMBER_COLOR_PALETTE.length];
}

/**
 * Simple deterministic hash for a string → non-negative integer.
 * Uses djb2 algorithm for good distribution across the palette.
 */
function hashStringToIndex(str: string): number {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash + str.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
}

export function normalizeMemberColorName(colorName: string): string {
  const normalized = colorName.trim().toLowerCase();
  if (!normalized) return MEMBER_COLOR_PALETTE[0];
  if (!DISALLOWED_MEMBER_COLORS.has(normalized)) return normalized;
  return MEMBER_COLOR_PALETTE[hashStringToIndex(normalized) % MEMBER_COLOR_PALETTE.length];
}

/**
 * Get a stable color for a member name.
 * The color is deterministic — same name always maps to the same palette entry,
 * regardless of member order or team size.
 */
export function getMemberColorByName(name: string): string {
  return MEMBER_COLOR_PALETTE[hashStringToIndex(name) % MEMBER_COLOR_PALETTE.length];
}
