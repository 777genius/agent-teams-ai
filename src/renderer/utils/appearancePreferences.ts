/**
 * Portable Appearance preferences live on this browser/device only.
 * Keep the existing backend AppConfig.general.theme untouched.
 */
export const APPEARANCE_STORAGE_KEY = 'agent-teams-appearance-v1';

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
  activeCustomThemeId: string | null;
  themes: CustomTheme[];
}

export const ZOOM_PRESETS = [80, 90, 100, 110, 125, 150, 175, 200] as const;
const MAX_THEME_COUNT = 8;
const MAX_JSON_LENGTH = 16_384;
const MIN_ZOOM = 70;
const MAX_ZOOM = 200;
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
  accent: '#818cf8',
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
  activeCustomThemeId: null,
  themes: [],
};

const CSS_THEME_TOKENS: Record<ThemeColorKey, string> = {
  surface: '--color-surface',
  surfaceRaised: '--color-surface-raised',
  surfaceOverlay: '--color-surface-overlay',
  surfaceSidebar: '--color-surface-sidebar',
  border: '--color-border',
  borderSubtle: '--color-border-subtle',
  borderEmphasis: '--color-border-emphasis',
  text: '--color-text',
  textSecondary: '--color-text-secondary',
  textMuted: '--color-text-muted',
  accent: '--color-accent',
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
  if (unexpected) throw new Error(`${context}: unknown field "${unexpected}"`);
}

function hexLuminance(hex: string): number {
  const channels = [1, 3, 5].map((offset) => {
    const normalized = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return normalized <= 0.04045
      ? normalized / 12.92
      : ((normalized + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * channels[0]! + 0.7152 * channels[1]! + 0.0722 * channels[2]!;
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
    if (contrastRatio(palette.text, palette.surface) < 4.5) {
      throw new Error(`${label}: text must contrast at least 4.5:1 with surface`);
    }
    if (contrastRatio(palette.textSecondary, palette.surface) < 4.5) {
      throw new Error(`${label}: secondary text must contrast at least 4.5:1 with surface`);
    }
    if (contrastRatio(palette.accent, palette.surface) < 3) {
      throw new Error(`${label}: accent must contrast at least 3:1 with surface`);
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

function parseAppearance(value: unknown): AppearancePreferences {
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
  return { version: 1, zoomPercent, activeCustomThemeId, themes };
}

export function readAppearance(storage: Pick<Storage, 'getItem'>): AppearancePreferences {
  try {
    const raw = storage.getItem(APPEARANCE_STORAGE_KEY);
    if (!raw || raw.length > MAX_JSON_LENGTH) return DEFAULT_APPEARANCE;
    return parseAppearance(JSON.parse(raw) as unknown);
  } catch {
    return DEFAULT_APPEARANCE;
  }
}

let snapshot: AppearancePreferences | null = null;
const listeners = new Set<() => void>();

function getStorage(): Storage {
  return window.localStorage;
}

export function getAppearanceSnapshot(): AppearancePreferences {
  if (snapshot === null) {
    try {
      snapshot = readAppearance(getStorage());
    } catch {
      snapshot = DEFAULT_APPEARANCE;
    }
  }
  return snapshot;
}

export function subscribeAppearance(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function announceChange(next: AppearancePreferences): void {
  snapshot = next;
  for (const listener of listeners) listener();
}

export function saveAppearance(next: AppearancePreferences): void {
  const safe = parseAppearance(next);
  if (safe === DEFAULT_APPEARANCE && next !== DEFAULT_APPEARANCE) {
    throw new Error('Invalid appearance preferences');
  }
  // Write first: failed storage must not change the visible theme/zoom.
  getStorage().setItem(APPEARANCE_STORAGE_KEY, JSON.stringify(safe));
  announceChange(safe);
}

export function setAppearanceZoom(zoomPercent: number): void {
  const next = Math.round(zoomPercent);
  if (!Number.isFinite(next) || next < MIN_ZOOM || next > MAX_ZOOM) {
    throw new Error('UI scale must be between 70% and 200%');
  }
  if (getAppearanceSnapshot().zoomPercent === next) return;
  saveAppearance({ ...getAppearanceSnapshot(), zoomPercent: next });
}

export function setActiveCustomTheme(id: string | null): void {
  const current = getAppearanceSnapshot();
  if (id !== null && !current.themes.some((theme) => theme.id === id)) {
    throw new Error('Unknown custom theme');
  }
  if (current.activeCustomThemeId === id) return;
  saveAppearance({ ...current, activeCustomThemeId: id });
}

export function setCustomThemes(themes: CustomTheme[]): void {
  const current = getAppearanceSnapshot();
  const validated = validateCustomThemes(themes);
  const activeCustomThemeId = validated.some((theme) => theme.id === current.activeCustomThemeId)
    ? current.activeCustomThemeId
    : null;
  saveAppearance({ ...current, themes: validated, activeCustomThemeId });
}

export function applyCustomThemeToRoot(root: HTMLElement, theme: CustomTheme | null): void {
  root.classList.toggle('custom-theme', theme !== null);
  for (const key of CUSTOM_THEME_COLOR_KEYS) {
    const token = CSS_THEME_TOKENS[key];
    if (theme) root.style.setProperty(token, theme.colors[key]);
    else root.style.removeProperty(token);
  }
}

// Cross-tab sync: local preferences never leak into the backend-wide config.
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event: StorageEvent) => {
    if (event.key === APPEARANCE_STORAGE_KEY || event.key === null) {
      try {
        announceChange(readAppearance(getStorage()));
      } catch {
        announceChange(DEFAULT_APPEARANCE);
      }
    }
  });
}
