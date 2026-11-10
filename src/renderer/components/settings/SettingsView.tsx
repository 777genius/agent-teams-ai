/** Settings shell stays interactive while forms and configuration load. */
import { lazy, Suspense, useCallback, useEffect, useState } from 'react';

import { useAppTranslation } from '@features/localization/renderer';
import { useStore } from '@renderer/store';
import { useShallow } from 'zustand/react/shallow';

import { SettingsLoadingSkeleton } from './SettingsLoadingSkeleton';
import { type SettingsSection, SettingsTabs } from './SettingsTabs';

const SettingsContent = lazy(() =>
  import('./SettingsContent').then((module) => ({ default: module.SettingsContent }))
);

interface SettingsViewProps {
  isActive?: boolean;
}

export const SettingsView = ({ isActive = true }: SettingsViewProps): React.JSX.Element => {
  const { t } = useAppTranslation('settings');
  const { pendingSettingsSection, clearPendingSettingsSection } = useStore(
    useShallow((s) => ({
      pendingSettingsSection: s.pendingSettingsSection,
      clearPendingSettingsSection: s.clearPendingSettingsSection,
    }))
  );
  const [activeSection, setActiveSection] = useState<SettingsSection>(() => {
    const section = pendingSettingsSection?.split('#')[0];
    return isSettingsSection(section) ? section : 'general';
  });
  const [pendingAnchor, setPendingAnchor] = useState<string | null>(null);
  const clearPendingAnchor = useCallback(() => setPendingAnchor(null), []);

  useEffect(() => {
    if (!pendingSettingsSection) return;
    const [section, anchor] = pendingSettingsSection.split('#');
    if (isSettingsSection(section)) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- consume requested settings navigation
      setActiveSection(section);
      setPendingAnchor(anchor || null);
    }
    clearPendingSettingsSection();
  }, [pendingSettingsSection, clearPendingSettingsSection]);

  const handleSectionChange = (section: SettingsSection): void => {
    setActiveSection(section);
    clearPendingAnchor();
  };

  return (
    <div
      className="flex min-h-0 min-w-0 flex-1"
      style={{ backgroundColor: 'var(--color-surface)' }}
    >
      <SettingsTabs activeSection={activeSection} onSectionChange={handleSectionChange} />
      <Suspense
        fallback={
          <SettingsLoadingSkeleton label={t('view.loading')} activeSection={activeSection} />
        }
      >
        <SettingsContent
          isActive={isActive}
          activeSection={activeSection}
          pendingAnchor={pendingAnchor}
          onAnchorHandled={clearPendingAnchor}
        />
      </Suspense>
    </div>
  );
};

function isSettingsSection(value: string | undefined): value is SettingsSection {
  return (
    value === 'general' ||
    value === 'appearance' ||
    value === 'connection' ||
    value === 'providers' ||
    value === 'externalAgentConnection' ||
    value === 'notifications' ||
    value === 'advanced'
  );
}
