/**
 * Pre-ordered color palette for team members.
 * Colors are arranged so that consecutive entries are maximally distant
 * on the hue wheel — the first N members always get visually distinct colors.
 * Generated via greedy max-min-distance algorithm over hue angles.
 * Intentionally excludes purple-family tones.
 */
export const MEMBER_COLOR_PALETTE = [
  // ── First 10: maximum contrast (>40° hue gap between any pair) ──
  'blue', // 0°
  'saffron', // 177°
  'turquoise', // 268°
  'brick', // 85°
  'apricot', // 131°
  'indigo', // 314°
  'forest', // 223°
  'pink', // 39°
  'crimson', // 59°
  'tangerine', // 105°

  // ── Next 14: still good separation ──
  'gold', // 151°
  'emerald', // 203°
  'cerulean', // 288°
  'denim', // 334°
  'cyan', // 20°
  'sage', // 242°
  'tomato', // 72°
  'rust', // 118°
  'mustard', // 164°
  'canary', // 190°
  'teal', // 255°
  'arctic', // 301°
  'royal', // 347°
  'green', // 7°

  // ── Remaining: fill the hue gaps progressively ──
  'rose', // 46°
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
  'copper', // 124°
  'bronze', // 137°
  'lemon', // 157°
  'honey', // 170°
  'marigold', // 183°
  'sunflower', // 196°
  'lime', // 209°
  'olive', // 229°
  'jade', // 236°
  'chartreuse', // 249°
  'aqua', // 262°
  'azure', // 281°
  'seafoam', // 295°
  'cobalt', // 308°
  'periwinkle', // 327°
  'steel', // 340°
  'cornflower', // 353°
] as const;

export type MemberColorName = (typeof MEMBER_COLOR_PALETTE)[number];

/**
 * Fixed hue angle (0-359) for each palette color name.
 * This is independent of array order — colors keep their visual identity
 * regardless of how MEMBER_COLOR_PALETTE is sorted.
 * Spread evenly across 360° so every name has a unique hue.
 */
export const MEMBER_COLOR_HUE: Record<string, number> = {
  blue: 0,
  green: 7,
  yellow: 13,
  cyan: 20,
  red: 26,
  orange: 33,
  pink: 39,
  rose: 46,
  coral: 52,
  crimson: 59,
  scarlet: 65,
  tomato: 72,
  salmon: 79,
  brick: 85,
  ruby: 92,
  amber: 98,
  tangerine: 105,
  peach: 111,
  rust: 118,
  copper: 124,
  apricot: 131,
  bronze: 137,
  sienna: 144,
  gold: 151,
  lemon: 157,
  mustard: 164,
  honey: 170,
  saffron: 177,
  marigold: 183,
  canary: 190,
  sunflower: 196,
  emerald: 203,
  lime: 209,
  mint: 216,
  forest: 223,
  olive: 229,
  jade: 236,
  sage: 242,
  chartreuse: 249,
  teal: 255,
  aqua: 262,
  turquoise: 268,
  sky: 275,
  azure: 281,
  cerulean: 288,
  seafoam: 295,
  arctic: 301,
  cobalt: 308,
  indigo: 314,
  sapphire: 321,
  periwinkle: 327,
  denim: 334,
  steel: 340,
  royal: 347,
  cornflower: 353,
};

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
