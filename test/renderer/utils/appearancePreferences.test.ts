import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  APPEARANCE_STORAGE_KEY,
  applyCustomThemeToRoot,
  DEFAULT_APPEARANCE,
  EXAMPLE_THEME,
  formatCustomThemesJson,
  getAppearanceSnapshot,
  parseCustomThemesJson,
  readAppearance,
  saveAppearance,
  setActiveCustomTheme,
  setAppearanceZoom,
  setCustomThemes,
  subscribeAppearance,
  validateCustomThemes,
} from '@renderer/utils/appearancePreferences';

import type { CustomTheme } from '@renderer/utils/appearancePreferences';

const example = (): CustomTheme => ({
  ...EXAMPLE_THEME,
  colors: { ...EXAMPLE_THEME.colors },
});

beforeEach(() => {
  localStorage.clear();
  saveAppearance(DEFAULT_APPEARANCE);
  document.documentElement.classList.remove('custom-theme');
  document.documentElement.style.removeProperty('--color-surface');
});

describe('user color theme JSON', () => {
  it('offers an editable named theme template and accepts a valid palette', () => {
    const themes = parseCustomThemesJson(formatCustomThemesJson([]));
    expect(themes).toEqual([EXAMPLE_THEME]);
  });

  it('rejects untrusted CSS, arbitrary keys and malformed JSON without applying them', () => {
    const safe = example();
    expect(() =>
      parseCustomThemesJson(JSON.stringify({ themes: [{ ...safe, colors: { ...safe.colors, surface: 'url(https://example.org/evil)' } }] }))
    ).toThrow(/surface/);
    expect(() =>
      parseCustomThemesJson(JSON.stringify({ themes: [{ ...safe, css: 'body { display: none }' }] }))
    ).toThrow(/unknown field/);
    expect(() => parseCustomThemesJson('{"themes":')).toThrow();
    expect(getAppearanceSnapshot().themes).toEqual([]);
  });

  it('rejects duplicate ids and excessive theme counts', () => {
    expect(() => validateCustomThemes([example(), example()])).toThrow(/duplicate/);
    expect(() => validateCustomThemes(Array.from({ length: 9 }, (_, i) => ({
      ...example(), id: `my-theme-${i}`,
    })))).toThrow(/at most 8/);
  });

  it('enforces contrast against raised, overlay and sidebar surfaces', () => {
    for (const surface of ['surface', 'surfaceRaised', 'surfaceOverlay', 'surfaceSidebar'] as const) {
      const bad = example();
      bad.colors[surface] = bad.colors.text;
      expect(() => validateCustomThemes([bad])).toThrow(new RegExp(surface));
    }
  });

  it('keeps separate built-in configuration and clears active theme on deletion', () => {
    setCustomThemes([example()]);
    setActiveCustomTheme('my-theme');
    expect(getAppearanceSnapshot().activeCustomThemeId).toBe('my-theme');
    setCustomThemes([]);
    expect(getAppearanceSnapshot().activeCustomThemeId).toBeNull();
    expect(getAppearanceSnapshot().themes).toEqual([]);
  });

  it('switches only eleven allowlisted CSS tokens and removes them on reset', () => {
    const root = document.documentElement;
    applyCustomThemeToRoot(root, example());
    expect(root.classList.contains('custom-theme')).toBe(true);
    expect(root.style.getPropertyValue('--color-surface')).toBe(EXAMPLE_THEME.colors.surface);
    expect(root.style.getPropertyValue('--color-accent')).toBe(EXAMPLE_THEME.colors.accent);

    applyCustomThemeToRoot(root, null);
    expect(root.classList.contains('custom-theme')).toBe(false);
    expect(root.style.getPropertyValue('--color-surface')).toBe('');
    expect(root.style.getPropertyValue('--color-accent')).toBe('');
  });
});

describe('portable Appearance persistence', () => {
  it('persists scale and named themes under a versioned local key', () => {
    setCustomThemes([example()]);
    setAppearanceZoom(125);
    const current = getAppearanceSnapshot();
    expect(current.zoomPercent).toBe(125);
    expect(readAppearance(localStorage)).toEqual(current);
    expect(JSON.parse(localStorage.getItem(APPEARANCE_STORAGE_KEY)!).version).toBe(1);
  });

  it('rejects out-of-range zoom and preserves the previous setting', () => {
    setAppearanceZoom(90);
    expect(() => setAppearanceZoom(210)).toThrow(/between/);
    expect(() => setAppearanceZoom(Number.NaN)).toThrow(/between/);
    expect(getAppearanceSnapshot().zoomPercent).toBe(90);
  });

  it('does not change the visible setting when storage rejects writes', () => {
    const old = getAppearanceSnapshot();
    const original = Storage.prototype.setItem;
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });
    try {
      expect(() => setAppearanceZoom(150)).toThrow(/QuotaExceeded/);
      expect(getAppearanceSnapshot()).toBe(old);
    } finally {
      spy.mockRestore();
      expect(Storage.prototype.setItem).toBe(original);
    }
  });

  it('recovers from invalid values and denied storage reads', () => {
    localStorage.setItem(APPEARANCE_STORAGE_KEY, '{"version":2}');
    expect(readAppearance(localStorage)).toEqual(DEFAULT_APPEARANCE);
    expect(readAppearance({ getItem: () => { throw new Error('denied'); } })).toEqual(DEFAULT_APPEARANCE);
  });

  it('notifies subscribers for local theme and zoom selections', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeAppearance(listener);
    setCustomThemes([example()]);
    setActiveCustomTheme('my-theme');
    setAppearanceZoom(150);
    expect(listener).toHaveBeenCalledTimes(3);
    unsubscribe();
    setAppearanceZoom(100);
    expect(listener).toHaveBeenCalledTimes(3);
  });
});
