import { useState } from 'react';

import { useAppTranslation } from '@features/localization/renderer';
import { isElectronMode } from '@renderer/api';
import { confirm } from '@renderer/components/common/ConfirmDialog';
import { useAppearancePreferences } from '@renderer/hooks/useAppearance';
import { cn } from '@renderer/lib/utils';
import {
  setActiveCustomTheme,
  setAppearanceZoom,
  setCustomThemes,
  ZOOM_PRESETS,
} from '@renderer/utils/appearancePreferences';

import { SettingRow, SettingsSectionHeader, SettingsToggle } from '../components';
import { ThemeJsonEditorDialog } from './ThemeJsonEditorDialog';

import type { SafeConfig } from '../hooks/useSettingsConfig';
import type { AppConfig } from '@shared/types/notifications';

const THEME_OPTIONS = ['dark', 'light', 'system'] as const;

interface AppearanceSectionProps {
  safeConfig: SafeConfig;
  saving: boolean;
  onGeneralToggle: (key: keyof AppConfig['general'], value: boolean) => void;
  onNativeTitleBarChange: (value: boolean) => Promise<void>;
  onThemeChange: (value: 'dark' | 'light' | 'system') => void;
}

export const AppearanceSection = ({
  safeConfig,
  saving,
  onGeneralToggle,
  onNativeTitleBarChange,
  onThemeChange,
}: AppearanceSectionProps): React.JSX.Element => {
  const { t } = useAppTranslation('settings');
  const isElectron = isElectronMode();
  const { activeCustomThemeId, themes, zoomPercent } = useAppearancePreferences();
  const [editorOpen, setEditorOpen] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const themeOptions = THEME_OPTIONS.map((value) => ({
    value,
    label: t(`general.appearance.theme.options.${value}`),
  }));
  const zoomOptions = [...new Set<number>([...ZOOM_PRESETS, zoomPercent])].sort((a, b) => a - b);

  const changeLocalPreference = (change: () => void): void => {
    try {
      change();
      setLocalError(null);
    } catch (cause) {
      setLocalError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  return (
    <div>
      <SettingsSectionHeader title={t('general.appearance.title')} />
      <SettingRow
        label={t('general.appearance.theme.label')}
        description={t('general.appearance.theme.description')}
      >
        <div className="inline-flex flex-wrap rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-0.5">
          {themeOptions.map((opt) => (
            <button
              key={opt.value}
              data-testid={`appearance-theme-${opt.value}`}
              type="button"
              aria-pressed={activeCustomThemeId === null && safeConfig.general.theme === opt.value}
              disabled={saving}
              className={cn(
                'rounded-[3px] px-3 py-1 text-xs font-medium transition-colors disabled:opacity-50',
                activeCustomThemeId === null && safeConfig.general.theme === opt.value
                  ? 'bg-[var(--color-surface-raised)] text-[var(--color-text)] shadow-sm'
                  : 'text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]'
              )}
              onClick={() =>
                changeLocalPreference(() => {
                  setActiveCustomTheme(null);
                  onThemeChange(opt.value);
                })
              }
            >
              {opt.label}
            </button>
          ))}
        </div>
      </SettingRow>
      <SettingRow
        label={t('general.appearance.customThemes.label')}
        description={t('general.appearance.customThemes.description')}
      >
        <div className="flex flex-wrap items-center justify-end gap-2">
          <select
            data-testid="appearance-custom-theme-select"
            value={activeCustomThemeId ?? ''}
            aria-label={t('general.appearance.customThemes.label')}
            className="max-w-44 rounded border border-border bg-surface-raised px-2 py-1.5 text-xs text-text"
            onChange={(event) =>
              changeLocalPreference(() => setActiveCustomTheme(event.target.value || null))
            }
          >
            <option value="">{t('general.appearance.customThemes.none')}</option>
            {themes.map((theme) => (
              <option key={theme.id} value={theme.id}>{theme.name}</option>
            ))}
          </select>
          <button
            type="button"
            data-testid="appearance-edit-custom-themes"
            onClick={() => setEditorOpen(true)}
            className="rounded border border-border-emphasis bg-surface-raised px-2.5 py-1.5 text-xs font-medium text-text"
          >
            {t('general.appearance.customThemes.edit')}
          </button>
        </div>
      </SettingRow>
      <SettingRow
        label={t('general.appearance.uiScale.label')}
        description={t('general.appearance.uiScale.description')}
      >
        <div className="flex items-center gap-2">
          <select
            data-testid="appearance-ui-scale"
            value={zoomPercent}
            aria-label={t('general.appearance.uiScale.label')}
            className="rounded border border-border bg-surface-raised px-2 py-1.5 text-xs text-text"
            onChange={(event) =>
              changeLocalPreference(() => setAppearanceZoom(Number(event.target.value)))
            }
          >
            {zoomOptions.map((value) => (
              <option key={value} value={value}>{value}%</option>
            ))}
          </select>
          <button
            type="button"
            disabled={zoomPercent === 100}
            onClick={() => changeLocalPreference(() => setAppearanceZoom(100))}
            className="rounded border border-border px-2.5 py-1.5 text-xs text-text-secondary disabled:opacity-50"
          >
            {t('general.appearance.uiScale.reset')}
          </button>
        </div>
      </SettingRow>
      {localError && (
        <p role="alert" className="my-2 text-xs text-red-400">{localError}</p>
      )}
      <p className="py-2 text-xs text-text-muted">
        {t('general.appearance.customThemes.localOnly')}
      </p>
      <SettingRow
        label={t('general.appearance.autoExpandAIGroups.label')}
        description={t('general.appearance.autoExpandAIGroups.description')}
      >
        <SettingsToggle
          enabled={safeConfig.general.autoExpandAIGroups ?? false}
          onChange={(v) => onGeneralToggle('autoExpandAIGroups', v)}
          disabled={saving}
        />
      </SettingRow>
      {isElectron && !window.navigator.userAgent.includes('Macintosh') && (
        <SettingRow
          label={t('general.appearance.nativeTitleBar.label')}
          description={t('general.appearance.nativeTitleBar.description')}
        >
          <SettingsToggle
            enabled={safeConfig.general.useNativeTitleBar}
            onChange={async (v) => {
              const shouldRelaunch = await confirm({
                title: t('general.appearance.nativeTitleBar.restartConfirm.title'),
                message: t('general.appearance.nativeTitleBar.restartConfirm.message'),
                confirmLabel: t('general.appearance.nativeTitleBar.restartConfirm.confirmLabel'),
              });
              if (shouldRelaunch) {
                try {
                  await onNativeTitleBarChange(v);
                  void window.electronAPI?.windowControls?.relaunch();
                } catch {
                  // The settings hook displays the save error; never relaunch on failure.
                }
              }
            }}
            disabled={saving}
          />
        </SettingRow>
      )}
      <ThemeJsonEditorDialog
        open={editorOpen}
        onClose={() => setEditorOpen(false)}
        themes={themes}
        onSave={(next) => setCustomThemes(next)}
      />
    </div>
  );
};
