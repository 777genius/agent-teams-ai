import { useMemo } from 'react';

import { useAppTranslation } from '@features/localization/renderer';
import { isElectronMode } from '@renderer/api';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@renderer/components/ui/tooltip';
import { Bell, Info, Settings, Wrench } from 'lucide-react';

import type { LucideIcon } from 'lucide-react';

export type SettingsSection = 'general' | 'connection' | 'notifications' | 'advanced';

interface SettingsTabsProps {
  activeSection: SettingsSection;
  onSectionChange: (section: SettingsSection) => void;
}

type TabLabelKey = 'tabs.advanced.label' | 'tabs.general.label' | 'tabs.notifications.label';

type TabDescriptionKey =
  | 'tabs.advanced.description'
  | 'tabs.general.description'
  | 'tabs.notifications.description';

interface TabConfig {
  id: SettingsSection;
  labelKey: TabLabelKey;
  icon: LucideIcon;
  descriptionKey: TabDescriptionKey;
  electronOnly?: boolean;
}

const tabs: TabConfig[] = [
  {
    id: 'general',
    labelKey: 'tabs.general.label',
    icon: Settings,
    descriptionKey: 'tabs.general.description',
  },
  // { id: 'connection', label: 'Connection', icon: Server, description: 'Manage CLI connection and authentication settings.', electronOnly: true },
  {
    id: 'notifications',
    labelKey: 'tabs.notifications.label',
    icon: Bell,
    descriptionKey: 'tabs.notifications.description',
  },
  {
    id: 'advanced',
    labelKey: 'tabs.advanced.label',
    icon: Wrench,
    descriptionKey: 'tabs.advanced.description',
  },
] satisfies TabConfig[];

export const SettingsTabs = ({
  activeSection,
  onSectionChange,
}: Readonly<SettingsTabsProps>): React.JSX.Element => {
  const { t } = useAppTranslation('settings');
  const isElectron = useMemo(() => isElectronMode(), []);
  const visibleTabs = useMemo(
    () => tabs.filter((tab) => !tab.electronOnly || isElectron),
    [isElectron]
  );

  return (
    <TooltipProvider>
      <div className="border-b border-border pb-0">
        <div className="inline-flex h-9 items-center gap-1 rounded-t-lg bg-[var(--color-surface-raised)] p-1 text-[var(--color-text-muted)]">
          {visibleTabs.map((tab) => {
            const Icon = tab.icon;
            const isActive = activeSection === tab.id;
            const label = t(tab.labelKey);

            return (
              <button
                key={tab.id}
                onClick={() => onSectionChange(tab.id)}
                className={`relative inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-md px-3 py-1 pr-7 text-sm font-medium transition-all ${
                  isActive
                    ? 'bg-[var(--color-surface)] text-[var(--color-text)] shadow-sm'
                    : 'text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]'
                }`}
              >
                <Icon className="size-3.5" />
                {label}

                <Tooltip>
                  <TooltipTrigger asChild>
                    <span
                      role="button"
                      tabIndex={0}
                      aria-label={t('tabs.infoAriaLabel', { label })}
                      onClick={(event) => event.stopPropagation()}
                      onMouseDown={(event) => event.stopPropagation()}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' || event.key === ' ') {
                          event.stopPropagation();
                        }
                      }}
                      className="size-4.5 absolute right-1.5 top-0.5 z-10 inline-flex items-center justify-center rounded-full text-text-muted transition-colors hover:bg-[var(--color-surface-raised)] hover:text-text"
                    >
                      <Info className="size-3" />
                    </span>
                  </TooltipTrigger>
                  <TooltipContent className="max-w-64 text-pretty text-xs leading-relaxed">
                    {t(tab.descriptionKey)}
                  </TooltipContent>
                </Tooltip>
              </button>
            );
          })}
        </div>
      </div>
    </TooltipProvider>
  );
};
