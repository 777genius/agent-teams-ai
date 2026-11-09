import { useMemo, useState } from 'react';

import {
  FONT_SIZE_PRESETS,
  listLocalFontFamilies,
  setAppearanceFontFamily,
  setAppearanceFontSize,
  useAppearancePreferences,
  uniqueFontFamilies,
} from '@features/appearance/renderer';
import { useAppTranslation } from '@features/localization/renderer';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@renderer/components/ui/select';

import { SettingRow } from '../components';

const SYSTEM_FONT = '__system_font__';
const MAX_VISIBLE_FONT_CHOICES = 100;
const FONT_SUGGESTIONS = [
  'Arial', 'Consolas', 'Georgia', 'Inter', 'Menlo', 'Noto Sans',
  'Roboto', 'Segoe UI', 'Tahoma', 'Times New Roman', 'Verdana',
] as const;

/** Per-device UI typography. Editors and terminals manage their own monospace font. */
export const TypographyControls = (): React.JSX.Element => {
  const { t } = useAppTranslation('settings');
  const { fontFamily, fontSizePercent } = useAppearancePreferences();
  const [installedFonts, setInstalledFonts] = useState<string[]>([]);
  const [fontQuery, setFontQuery] = useState('');
  const [discovery, setDiscovery] = useState<'idle' | 'loading' | 'loaded' | 'empty' | 'unavailable'>('idle');
  const [customOpen, setCustomOpen] = useState(false);
  const [customFont, setCustomFont] = useState('');
  const [error, setError] = useState<string | null>(null);

  // Avoid rendering thousands of Radix options on every Appearance interaction.
  const allFonts = useMemo(
    () => uniqueFontFamilies([...FONT_SUGGESTIONS, ...installedFonts], fontFamily),
    [installedFonts, fontFamily]
  );
  const fonts = useMemo(() => {
    const query = fontQuery.trim().toLocaleLowerCase();
    const matches = query
      ? allFonts.filter((family) => family.toLocaleLowerCase().includes(query))
      : allFonts;
    return uniqueFontFamilies(matches.slice(0, MAX_VISIBLE_FONT_CHOICES), fontFamily);
  }, [allFonts, fontQuery, fontFamily]);

  const save = (action: () => void): boolean => {
    try {
      action();
      setError(null);
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      return false;
    }
  };

  const discover = (): void => {
    setDiscovery('loading');
    setFontQuery('');
    // Trigger permission only after explicit user interaction (never on mount).
    void listLocalFontFamilies().then((families) => {
      if (families === null) {
        setInstalledFonts([]);
        setDiscovery('unavailable');
        return;
      }
      setInstalledFonts(families);
      setDiscovery(families.length === 0 ? 'empty' : 'loaded');
    }).catch(() => {
      setInstalledFonts([]);
      setDiscovery('unavailable');
    });
  };

  return (
    <>
      <SettingRow
        wrapControls
        label={t('general.appearance.fontFamily.label')}
        description={t('general.appearance.fontFamily.description')}
      >
        <div className="flex min-w-0 max-w-full flex-col items-end gap-2">
          {allFonts.length > MAX_VISIBLE_FONT_CHOICES && (
            <input
              type="search"
              data-testid="appearance-font-filter"
              aria-label={t('general.appearance.fontFamily.placeholder')}
              placeholder={t('general.appearance.fontFamily.placeholder')}
              value={fontQuery}
              onChange={(event) => setFontQuery(event.target.value)}
              className="h-8 w-44 max-w-full rounded border border-border bg-surface-raised px-2 text-xs text-text"
            />
          )}
          <div className="flex max-w-full flex-wrap items-center justify-end gap-2">
            <Select
              value={fontFamily === null ? SYSTEM_FONT : `family:${fontFamily}`}
              onValueChange={(value) => {
                if (save(() => setAppearanceFontFamily(
                  value === SYSTEM_FONT ? null : value.slice('family:'.length)
                ))) {
                  setCustomOpen(false);
                }
              }}
            >
              <SelectTrigger
                data-testid="appearance-font-select"
                aria-label={t('general.appearance.fontFamily.label')}
                className="h-8 w-44 max-w-full bg-surface-raised text-xs text-text"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={SYSTEM_FONT} data-testid="appearance-font-option-system">
                  {t('general.appearance.fontFamily.system')}
                </SelectItem>
                {fonts.map((family) => (
                  <SelectItem
                    key={family}
                    value={`family:${family}`}
                    data-testid={`appearance-font-option-${family}`}
                  >
                    {family}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <button
              type="button"
              data-testid="appearance-font-other"
              onClick={() => {
                setCustomFont(fontFamily ?? '');
                setCustomOpen((open) => !open);
              }}
              aria-expanded={customOpen}
              className="rounded border border-border px-2.5 py-1.5 text-xs text-text-secondary"
            >
              {t('general.appearance.fontFamily.other')}
            </button>
            <button
              type="button"
              data-testid="appearance-font-discover"
              disabled={discovery === 'loading'}
              onClick={discover}
              className="rounded border border-border px-2.5 py-1.5 text-xs text-text-secondary disabled:opacity-50"
            >
              {t('general.appearance.fontFamily.discover')}
            </button>
          </div>
          {customOpen && (
            <form
              className="flex max-w-full flex-wrap items-center justify-end gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                if (save(() => setAppearanceFontFamily(customFont))) setCustomOpen(false);
              }}
            >
              <input
                data-testid="appearance-font-custom-input"
                aria-label={t('general.appearance.fontFamily.other')}
                type="text"
                maxLength={80}
                value={customFont}
                onChange={(event) => setCustomFont(event.target.value)}
                placeholder={t('general.appearance.fontFamily.placeholder')}
                className="h-8 w-44 max-w-full min-w-0 rounded border border-border bg-surface-raised px-2 text-xs text-text"
              />
              <button
                type="submit"
                data-testid="appearance-font-custom-apply"
                className="rounded border border-border-emphasis px-2.5 py-1.5 text-xs text-text"
              >
                {t('general.appearance.fontFamily.apply')}
              </button>
            </form>
          )}
          {discovery === 'unavailable' && (
            <p role="status" className="max-w-72 text-right text-xs text-text-muted">
              {t('general.appearance.fontFamily.unavailable')}
            </p>
          )}
          {discovery === 'loaded' && (
            <p role="status" className="max-w-72 text-right text-xs text-text-muted">
              {t('general.appearance.fontFamily.loaded')}
            </p>
          )}
          {discovery === 'empty' && (
            <p role="status" className="max-w-72 text-right text-xs text-text-muted">
              {t('general.appearance.fontFamily.empty')}
            </p>
          )}
        </div>
      </SettingRow>
      <SettingRow
        wrapControls
        label={t('general.appearance.textSize.label')}
        description={t('general.appearance.textSize.description')}
      >
        <div className="flex max-w-full flex-wrap items-center gap-2">
          <Select
            value={String(fontSizePercent)}
            onValueChange={(value) => { save(() => setAppearanceFontSize(Number(value))); }}
          >
            <SelectTrigger
              data-testid="appearance-text-size"
              aria-label={t('general.appearance.textSize.label')}
              className="h-8 w-24 bg-surface-raised text-xs text-text"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {FONT_SIZE_PRESETS.map((value) => (
                <SelectItem
                  key={value}
                  value={String(value)}
                  data-testid={`appearance-text-size-option-${value}`}
                >
                  {value}%
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <button
            type="button"
            disabled={fontSizePercent === 100}
            onClick={() => { save(() => setAppearanceFontSize(100)); }}
            className="rounded border border-border px-2.5 py-1.5 text-xs text-text-secondary disabled:opacity-50"
          >
            {t('general.appearance.textSize.reset')}
          </button>
        </div>
      </SettingRow>
      {error && <p role="alert" className="my-2 text-xs text-red-400">{error}</p>}
    </>
  );
};
