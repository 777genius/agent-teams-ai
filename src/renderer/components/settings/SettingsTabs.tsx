import { useMemo } from 'react';

import { useAppTranslation } from '@features/localization/renderer';
import { isElectronMode } from '@renderer/api';
import { Bell, Cable, Palette, Plug, Settings, Wrench } from 'lucide-react';

import type { LucideIcon } from 'lucide-react';

export type SettingsSection =
  | 'general'
  | 'appearance'
  | 'connection'
  | 'providers'
  | 'externalAgentConnection'
  | 'notifications'
  | 'advanced';

interface SettingsTabsProps {
  activeSection: SettingsSection;
  onSectionChange: (section: SettingsSection) => void;
}

interface SectionConfig {
  id: SettingsSection;
  labelKey:
    | 'general.appearance.title'
    | 'tabs.advanced.label'
    | 'runtimeProvider.tabs.providers'
    | 'tabs.general.label'
    | 'tabs.notifications.label'
    | 'general.externalAgentConnection.title';
  icon: LucideIcon;
  electronOnly?: boolean;
}

const sections: SectionConfig[] = [
  { id: 'general', labelKey: 'tabs.general.label', icon: Settings },
  { id: 'appearance', labelKey: 'general.appearance.title', icon: Palette },
  { id: 'notifications', labelKey: 'tabs.notifications.label', icon: Bell },
  { id: 'providers', labelKey: 'runtimeProvider.tabs.providers', icon: Plug, electronOnly: true },
  {
    id: 'externalAgentConnection',
    labelKey: 'general.externalAgentConnection.title',
    icon: Cable,
    electronOnly: true,
  },
  { id: 'advanced', labelKey: 'tabs.advanced.label', icon: Wrench },
];

export const SettingsTabs = ({
  activeSection,
  onSectionChange,
}: Readonly<SettingsTabsProps>): React.JSX.Element => {
  const { t } = useAppTranslation('settings');
  const isElectron = useMemo(() => isElectronMode(), []);

  return (
    <nav
      aria-label={t('view.title')}
      className="flex w-48 shrink-0 flex-col gap-1 border-e border-border p-3 max-sm:w-36 max-sm:p-2"
    >
      {sections
        .filter((section) => !section.electronOnly || isElectron)
        .map((section) => {
          const Icon = section.icon;
          const isActive = activeSection === section.id;
          return (
            <button
              key={section.id}
              type="button"
              aria-current={isActive ? 'page' : undefined}
              onClick={() => onSectionChange(section.id)}
              className={`flex w-full items-center gap-2 rounded-md px-3 py-2 text-start text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--color-border-emphasis)] ${
                isActive
                  ? 'bg-[var(--color-surface-raised)] text-[var(--color-text)]'
                  : 'text-[var(--color-text-muted)] hover:bg-[var(--color-surface-raised)] hover:text-[var(--color-text)]'
              }`}
            >
              <Icon className="size-4 shrink-0" aria-hidden="true" />
              <span className="min-w-0 break-words">{t(section.labelKey)}</span>
            </button>
          );
        })}
    </nav>
  );
};
