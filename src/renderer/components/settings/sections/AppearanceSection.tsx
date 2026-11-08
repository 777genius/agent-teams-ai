import { useRef, useState } from 'react';

import { useAppTranslation } from '@features/localization/renderer';
import { isElectronMode } from '@renderer/api';
import { confirm } from '@renderer/components/common/ConfirmDialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@renderer/components/ui/select';
import { useAppearancePreferences } from '@renderer/hooks/useAppearance';
import { cn } from '@renderer/lib/utils';
import {
  getLatestAppearance,
  setActiveCustomTheme,
  setAppearanceZoom,
  setCustomThemes,
  ZOOM_PRESETS,
} from '@renderer/utils/appearancePreferences';

import { SettingRow, SettingsSectionHeader, SettingsToggle } from '../components';
import { ThemeJsonEditorDialog } from './ThemeJsonEditorDialog';

import type { CustomTheme } from '@renderer/utils/appearancePreferences';
import type { AppConfig } from '@shared/types/notifications';
import type { SafeConfig } from '../hooks/useSettingsConfig';

const THEME_OPTIONS = ['dark', 'light', 'system'] as const;
const BUILTIN_THEME_OPTION = '__builtin__';

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
  const [editingThemes, setEditingThemes] = useState<readonly CustomTheme[]>([]);
  const editorTriggerRef = useRef<HTMLButtonElement>(null);
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
          <Select
            value={activeCustomThemeId ?? BUILTIN_THEME_OPTION}
            onValueChange={(value) =>
              changeLocalPreference(() => setActiveCustomTheme(value === BUILTIN_THEME_OPTION ? null : value))
            }
          >
            <SelectTrigger
              data-testid="appearance-custom-theme-select"
              aria-label={t('general.appearance.customThemes.label')}
              className="h-8 w-44 bg-surface-raised text-xs text-text"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={BUILTIN_THEME_OPTION}>
                {t('general.appearance.customThemes.none')}
              </SelectItem>
              {themes.map((theme) => (
                <SelectItem
                  key={theme.id}
                  value={theme.id}
                  data-testid={`appearance-custom-theme-option-${theme.id}`}
                >
                  {theme.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <button
            type="button"
            data-testid="appearance-edit-custom-themes"
            ref={editorTriggerRef}
            onClick={() => {
              setEditingThemes(themes);
              setEditorOpen(true);
            }}
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
          <Select
            value={String(zoomPercent)}
            onValueChange={(value) =>
              changeLocalPreference(() => setAppearanceZoom(Number(value)))
            }
          >
            <SelectTrigger
              data-testid="appearance-ui-scale"
              aria-label={t('general.appearance.uiScale.label')}
              className="h-8 w-24 bg-surface-raised text-xs text-text"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {zoomOptions.map((value) => (
                <SelectItem
                  key={value}
                  value={String(value)}
                  data-testid={`appearance-ui-scale-option-${value}`}
                >
                  {value}%
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
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
        themes={editingThemes}
        focusReturnRef={editorTriggerRef}
        onSave={(next, forceOverwrite) => {
          if (!forceOverwrite && JSON.stringify(getLatestAppearance().themes) !== JSON.stringify(editingThemes)) {
            throw new Error(t('general.appearance.customThemes.editor.conflict'));
          }
          setCustomThemes(next);
        }}
      />
    </div>
  );
};
