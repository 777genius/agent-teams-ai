/**
 * Pre-ordered color palette for team members.
 * Colors are arranged so that consecutive entries are maximally distant
 * on the hue wheel — the first N members always get visually distinct colors.
 * Generated via greedy max-min-distance algorithm over hue angles.
 * Intentionally excludes purple-family tones.
 */
export const MEMBER_COLOR_PALETTE = [
  // ── First 12: intentionally distinct visual families for roster readability ──
  'blue',
  'saffron',
  'turquoise',
  'brick',
  'indigo',
  'forest',
  'apricot',
  'rose',
  'cerulean',
  'olive',
  'copper',
  'steel',

  // ── Next 12: secondary accents after the core distinct set ──
  'gold',
  'emerald',
  'cobalt',
  'crimson',
  'tangerine',
  'denim',
  'cyan',
  'sage',
  'tomato',
  'rust',
  'mustard',
  'canary',
  'teal',
  'arctic',
  'royal',

  // ── Remaining: fill the hue gaps progressively ──
  'green',
  'pink',
  'ruby', // 92°
  'sienna', // 144°
  'mint', // 216°
  'sky', // 275°
  'sapphire', // 321°
  'yellow', // 13°
  'red', // 26°
  'orange', // 33°
  'coral', // 52°
  'scarlet', // 65°
  'salmon', // 79°
  'amber', // 98°
  'peach', // 111°
  'bronze', // 137°
  'lemon', // 157°
  'honey', // 170°
  'marigold', // 183°
  'sunflower', // 196°
  'lime', // 209°
  'jade', // 236°
  'chartreuse', // 249°
  'aqua', // 262°
  'azure', // 281°
  'seafoam', // 295°
  'periwinkle', // 327°
  'cornflower', // 353°
] as const;

export type MemberColorName = (typeof MEMBER_COLOR_PALETTE)[number];

/**
 * Canonical runtime/member id for the team lead.
 * UI surfaces should use this exact key when deriving the lead color so
 * previews match the resolved team roster.
 */
export const TEAM_LEAD_MEMBER_COLOR_ID = 'team-lead' as const;

/**
 * Fixed hue angle (0-359) for each palette color name.
 * The first roster-assigned colors are intentionally spaced far apart so the
 * first 10-12 teammates in a team remain visually distinct.
 */
const MEMBER_COLOR_HUES_BY_ORDER = [
  240, 60, 180, 0, 120, 300, 30, 210, 330, 90, 150, 270, 15, 195, 105, 285, 45, 225, 135, 315, 75,
  255, 165, 345, 7.5, 187.5, 97.5, 277.5, 37.5, 217.5, 127.5, 307.5, 67.5, 247.5, 157.5, 337.5,
  22.5, 202.5, 112.5, 292.5, 52.5, 232.5, 142.5, 322.5, 82.5, 262.5, 172.5, 352.5, 11.25, 191.25,
  101.25, 281.25, 41.25, 221.25, 131.25,
] as const;

export const MEMBER_COLOR_HUE: Record<string, number> = Object.fromEntries(
  MEMBER_COLOR_PALETTE.map((colorName, index) => [colorName, MEMBER_COLOR_HUES_BY_ORDER[index]])
) as Record<string, number>;

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
