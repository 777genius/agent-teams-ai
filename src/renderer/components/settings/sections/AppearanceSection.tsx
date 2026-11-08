import { useAppTranslation } from '@features/localization/renderer';
import { isElectronMode } from '@renderer/api';
import { confirm } from '@renderer/components/common/ConfirmDialog';
import { cn } from '@renderer/lib/utils';

import { SettingRow, SettingsSectionHeader, SettingsToggle } from '../components';

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
  const themeOptions = THEME_OPTIONS.map((value) => ({
    value,
    label: t(`general.appearance.theme.options.${value}`),
  }));
  return (
    <div>
      <SettingsSectionHeader title={t('general.appearance.title')} />
      <SettingRow
        label={t('general.appearance.theme.label')}
        description={t('general.appearance.theme.description')}
      >
        <div className="inline-flex rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-0.5">
          {themeOptions.map((opt) => (
            <button
              key={opt.value}
              data-testid={`appearance-theme-${opt.value}`}
              type="button"
              disabled={saving}
              className={cn(
                'rounded-[3px] px-3 py-1 text-xs font-medium transition-colors disabled:opacity-50',
                safeConfig.general.theme === opt.value
                  ? 'bg-[var(--color-surface-raised)] text-[var(--color-text)] shadow-sm'
                  : 'text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]'
              )}
              onClick={() => onThemeChange(opt.value)}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </SettingRow>
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
    </div>
  );
};
