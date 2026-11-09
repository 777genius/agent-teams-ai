/** Pure Appearance palette and zoom policy; no browser or runtime dependencies. */

export const CUSTOM_THEME_COLOR_KEYS = [
  'surface',
  'surfaceRaised',
  'surfaceOverlay',
  'surfaceSidebar',
  'border',
  'borderSubtle',
  'borderEmphasis',
  'text',
  'textSecondary',
  'textMuted',
  'accent',
] as const;

export type ThemeColorKey = (typeof CUSTOM_THEME_COLOR_KEYS)[number];
export type ThemePalette = Record<ThemeColorKey, string>;

export interface CustomTheme {
  id: string;
  name: string;
  base: 'dark' | 'light';
  colors: ThemePalette;
}

export interface AppearancePreferences {
  version: 1;
  zoomPercent: number;
  fontFamily: string | null;
  fontSizePercent: number;
  activeCustomThemeId: string | null;
  themes: CustomTheme[];
}

export const ZOOM_PRESETS = [80, 90, 100, 110, 125, 150, 175, 200] as const;
export const FONT_SIZE_PRESETS = [80, 90, 100, 110, 125, 150] as const;
export const MIN_FONT_SIZE_PERCENT = 80;
export const MAX_FONT_SIZE_PERCENT = 150;
const MAX_FONT_FAMILY_LENGTH = 80;
// Reject CSS syntax and control characters; a family is one name, never a CSS expression.
const UNSAFE_FONT_FAMILY = /[\u0000-\u001f\u007f;{}<>"\\]/u;

export function normalizeFontFamily(value: string | null): string | null {
  if (value === null) return null;
  const family = value.trim();
  if (!family || family.length > MAX_FONT_FAMILY_LENGTH || UNSAFE_FONT_FAMILY.test(family)) {
    throw new Error('Font family must be a valid name of at most 80 characters');
  }
  return family;
}
const MAX_THEME_COUNT = 8;
export const MAX_JSON_LENGTH = 16_384;
export const MIN_ZOOM = 70;
export const MAX_ZOOM = 200;
const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;
const THEME_ID = /^[a-z0-9][a-z0-9-]{0,30}$/;

const BASE_COLORS: ThemePalette = {
  surface: '#12131a',
  surfaceRaised: '#1c1d26',
  surfaceOverlay: '#1c1d26',
  surfaceSidebar: '#0c0d13',
  border: '#343747',
  borderSubtle: '#282b38',
  borderEmphasis: '#54596b',
  text: '#f1f5f9',
  textSecondary: '#b5bfce',
  textMuted: '#94a3b8',
  accent: '#6366f1',
};

export const EXAMPLE_THEME: CustomTheme = {
  id: 'my-theme',
  name: 'My theme',
  base: 'dark',
  colors: BASE_COLORS,
};

export const DEFAULT_APPEARANCE: AppearancePreferences = {
  version: 1,
  zoomPercent: 100,
  fontFamily: null,
  fontSizePercent: 100,
  activeCustomThemeId: null,
  themes: [],
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function checkKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  context: string
): void {
  const unexpected = Object.keys(value).find((key) => !allowed.includes(key));
  if (unexpected !== undefined) throw new Error(`${context}: unknown field "${unexpected}"`);
}

function hexLuminance(hex: string): number {
  const channels = [1, 3, 5].map((offset) => {
    const normalized = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return normalized <= 0.04045
      ? normalized / 12.92
      : ((normalized + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

export function contrastRatio(foreground: string, background: string): number {
  const a = hexLuminance(foreground);
  const b = hexLuminance(background);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

export function validateCustomThemes(value: unknown): CustomTheme[] {
  if (!Array.isArray(value) || value.length > MAX_THEME_COUNT) {
    throw new Error(`themes must be an array containing at most ${MAX_THEME_COUNT} themes`);
  }
  const ids = new Set<string>();
  return value.map((item: unknown, index): CustomTheme => {
    const label = `themes[${index}]`;
    if (!isRecord(item)) throw new Error(`${label}: expected a theme object`);
    checkKeys(item, ['id', 'name', 'base', 'colors'], label);
    const { id, name, base, colors } = item;
    if (typeof id !== 'string' || !THEME_ID.test(id)) {
      throw new Error(`${label}.id: use 1–31 lowercase letters, numbers or hyphens`);
    }
    if (ids.has(id)) throw new Error(`${label}.id: duplicate "${id}"`);
    ids.add(id);
    if (typeof name !== 'string' || name.trim().length === 0 || name.length > 40) {
      throw new Error(`${label}.name: use a name with 1–40 characters`);
    }
    if (base !== 'dark' && base !== 'light') {
      throw new Error(`${label}.base: expected "dark" or "light"`);
    }
    if (!isRecord(colors)) throw new Error(`${label}.colors: expected a palette object`);
    checkKeys(colors, CUSTOM_THEME_COLOR_KEYS, `${label}.colors`);
    for (const key of CUSTOM_THEME_COLOR_KEYS) {
      if (typeof colors[key] !== 'string' || !HEX_COLOR.test(colors[key])) {
        throw new Error(`${label}.colors.${key}: expected a six-digit #RRGGBB color`);
      }
    }
    const palette = colors as ThemePalette;
    for (const surface of ['surface', 'surfaceRaised', 'surfaceOverlay', 'surfaceSidebar'] as const) {
      for (const foreground of ['text', 'textSecondary'] as const) {
        if (contrastRatio(palette[foreground], palette[surface]) < 4.5) {
          throw new Error(`${label}: ${foreground} needs 4.5:1 contrast against ${surface}`);
        }
      }
      for (const foreground of ['textMuted', 'accent'] as const) {
        if (contrastRatio(palette[foreground], palette[surface]) < 3) {
          throw new Error(`${label}: ${foreground} needs 3:1 contrast against ${surface}`);
        }
      }
    }
    for (const surface of ['surface', 'surfaceRaised', 'surfaceOverlay', 'surfaceSidebar'] as const) {
      for (const border of ['border', 'borderSubtle', 'borderEmphasis'] as const) {
        if (contrastRatio(palette[border], palette[surface]) < 1.15) {
          throw new Error(`${label}: ${border} must be visible against ${surface}`);
        }
      }
    }
    if (contrastRatio('#ffffff', palette.accent) < 3) {
      throw new Error(`${label}: accent must provide contrast with light control icons`);
    }
    return { id, name: name.trim(), base, colors: { ...palette } };
  });
}

/** Import format is shared by the JSON editor and the local persistence adapter. */
export function parseCustomThemesJson(text: string): CustomTheme[] {
  if (text.length > MAX_JSON_LENGTH) throw new Error('Theme JSON is too large');
  const parsed: unknown = JSON.parse(text);
  if (!isRecord(parsed)) throw new Error('Expected an object with a themes array');
  checkKeys(parsed, ['themes'], 'Theme JSON');
  return validateCustomThemes(parsed.themes);
}

export function formatCustomThemesJson(themes: readonly CustomTheme[]): string {
  return JSON.stringify({ themes: themes.length ? themes : [EXAMPLE_THEME] }, null, 2);
}

export function parseAppearance(value: unknown): AppearancePreferences {
  if (!isRecord(value) || value.version !== 1) return DEFAULT_APPEARANCE;
  const themes = validateCustomThemes(value.themes);
  const zoomPercent = value.zoomPercent;
  if (
    typeof zoomPercent !== 'number' ||
    !Number.isInteger(zoomPercent) ||
    zoomPercent < MIN_ZOOM ||
    zoomPercent > MAX_ZOOM
  ) {
    return DEFAULT_APPEARANCE;
  }
  const activeCustomThemeId =
    typeof value.activeCustomThemeId === 'string' &&
    themes.some((theme) => theme.id === value.activeCustomThemeId)
      ? value.activeCustomThemeId
      : null;
  // Existing v1 records predate typography. Keep their themes and zoom unchanged.
  let fontFamily: string | null = null;
  try {
    fontFamily = normalizeFontFamily(value.fontFamily === undefined ? null : value.fontFamily as string | null);
  } catch {
    // A malicious/malformed persisted family is never projected into CSS.
  }
  const size = value.fontSizePercent;
  const fontSizePercent = typeof size === 'number' && Number.isInteger(size) &&
    size >= MIN_FONT_SIZE_PERCENT && size <= MAX_FONT_SIZE_PERCENT ? size : 100;
  return { version: 1, zoomPercent, fontFamily, fontSizePercent, activeCustomThemeId, themes };
}

