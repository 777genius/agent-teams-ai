/** Browser-local persistence and CSS projection for Appearance. */
import {
  CUSTOM_THEME_COLOR_KEYS,
  DEFAULT_APPEARANCE,
  MAX_JSON_LENGTH,
  MAX_ZOOM,
  MIN_ZOOM,
  parseAppearance,
  validateCustomThemes,
} from '../../core/domain/appearancePreferences';

import type { AppearancePreferences, CustomTheme, ThemeColorKey } from '../../core/domain/appearancePreferences';

export const APPEARANCE_STORAGE_KEY = 'agent-teams-appearance-v1';

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
// Preserve real native zoom if the settings store is temporarily not writable.
let unpersistedNativeZoomPercent: number | null = null;
const listeners = new Set<() => void>();

function getStorage(): Storage {
  return window.localStorage;
}

/**
 * Read the latest persisted record for read-modify-write operations.
 * Invalid persisted data must never silently become an empty palette when
 * another tab changes scale or themes. Startup reads can still fall back.
 */
export function getLatestAppearance(): AppearancePreferences {
  const raw = getStorage().getItem(APPEARANCE_STORAGE_KEY);
  if (raw === null) return unpersistedNativeZoomPercent === null
    ? DEFAULT_APPEARANCE
    : { ...DEFAULT_APPEARANCE, zoomPercent: unpersistedNativeZoomPercent };
  if (raw.length > MAX_JSON_LENGTH) throw new Error('Invalid saved appearance preferences');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new Error('Invalid saved appearance preferences');
  }
  const current = parseAppearance(parsed);
  if (current === DEFAULT_APPEARANCE) throw new Error('Invalid saved appearance preferences');
  return unpersistedNativeZoomPercent === null
    ? current
    : { ...current, zoomPercent: unpersistedNativeZoomPercent };
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

export function saveAppearance(next: AppearancePreferences, storage: Pick<Storage, 'setItem'> = getStorage()): void {
  const safe = parseAppearance(next);
  if (safe === DEFAULT_APPEARANCE && next !== DEFAULT_APPEARANCE) {
    throw new Error('Invalid appearance preferences');
  }
  // Write first: failed storage must not change the visible theme/zoom.
  storage.setItem(APPEARANCE_STORAGE_KEY, JSON.stringify(safe));
  unpersistedNativeZoomPercent = null;
  announceChange(safe);
}

export function setAppearanceZoom(zoomPercent: number): void {
  const next = Math.round(zoomPercent);
  if (!Number.isFinite(next) || next < MIN_ZOOM || next > MAX_ZOOM) {
    throw new Error('UI scale must be between 70% and 200%');
  }
  const current = getLatestAppearance();
  if (current.zoomPercent === next && getAppearanceSnapshot().zoomPercent === next) return;
  saveAppearance({ ...current, zoomPercent: next });
}

export function setActiveCustomTheme(id: string | null): void {
  let current: AppearancePreferences;
  try {
    current = getLatestAppearance();
  } catch (error) {
    // A damaged/denied local record must not prevent switching back to Dark/Light/System.
    // Only clear the visible selection; leave the unreadable persisted data untouched.
    if (id !== null) throw error;
    const cached = getAppearanceSnapshot();
    if (cached.activeCustomThemeId !== null) {
      announceChange({ ...cached, activeCustomThemeId: null });
    }
    return;
  }
  if (id !== null && !current.themes.some((theme) => theme.id === id)) {
    throw new Error('Unknown custom theme');
  }
  if (current.activeCustomThemeId === id) return;
  saveAppearance({ ...current, activeCustomThemeId: id });
}

export function setCustomThemes(themes: CustomTheme[]): void {
  const current = getLatestAppearance();
  const validated = validateCustomThemes(themes);
  const activeCustomThemeId = validated.some((theme) => theme.id === current.activeCustomThemeId)
    ? current.activeCustomThemeId
    : null;
  saveAppearance({ ...current, themes: validated, activeCustomThemeId });
}

/** Reflect a native shortcut when persistence is unavailable; UI must not lie. */
export function reflectNativeAppearanceZoom(zoomPercent: number): void {
  const bounded = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, Math.round(zoomPercent)));
  unpersistedNativeZoomPercent = bounded;
  if (getAppearanceSnapshot().zoomPercent !== bounded) {
    announceChange({ ...getAppearanceSnapshot(), zoomPercent: bounded });
  }
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
      // A theme-only change in another tab must not erase a native zoom that
      // could not be saved. An explicit zoom change from that tab takes priority.
      if (event.key === null) {
        unpersistedNativeZoomPercent = null;
      } else if (unpersistedNativeZoomPercent !== null) {
        const previous = readAppearance({ getItem: () => event.oldValue });
        const incoming = readAppearance({ getItem: () => event.newValue });
        if (previous.zoomPercent !== incoming.zoomPercent) {
          unpersistedNativeZoomPercent = null;
        }
      }
      const current = readAppearance(getStorage());
      announceChange(unpersistedNativeZoomPercent === null
        ? current
        : { ...current, zoomPercent: unpersistedNativeZoomPercent });
    }
  });
}
