/**
 * SettingsContent - Lazily loaded settings forms and configuration.
 * Provides UI for managing notifications, display settings, and advanced options.
 */

import { lazy, Suspense, useEffect, useRef, useState } from 'react';

import { ExternalAgentConnectionSettings } from '@features/external-agent-connection/renderer';
import { useAppTranslation } from '@features/localization/renderer';
import { api, isElectronMode } from '@renderer/api';
import { useStore } from '@renderer/store';
import { Loader2 } from 'lucide-react';

import { AppearanceSection } from './sections/AppearanceSection';
import { useSettingsConfig, useSettingsHandlers } from './hooks';
import {
  AdvancedSection,
  ConnectionSection,
  GeneralSection,
  NotificationsSection,
} from './sections';
import { SettingsLoadingSkeleton } from './SettingsLoadingSkeleton';

import type { SettingsSection } from './SettingsTabs';

const CliStatusBanner = lazy(() =>
  import('../dashboard/CliStatusBanner').then((module) => ({
    default: module.CliStatusBanner,
  }))
);

interface SettingsContentProps {
  isActive: boolean;
  activeSection: SettingsSection;
  pendingAnchor: string | null;
  onAnchorHandled: () => void;
}

export const SettingsContent = ({
  isActive,
  activeSection,
  pendingAnchor,
  onAnchorHandled,
}: SettingsContentProps): React.JSX.Element | null => {
  const { t } = useAppTranslation('settings');
  const { t: commonT } = useAppTranslation('common');
  const [hasVisitedProviders, setHasVisitedProviders] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);
  const connectionMode = useStore((s) => s.connectionMode);

  // Keep active OAuth and unsaved forms mounted across Settings section switches.
  // Only passive provider checks are gated by activeSection and isActive.
  useEffect(() => {
    if (activeSection === 'providers' && !hasVisitedProviders) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- preserve mounted provider operations
      setHasVisitedProviders(true);
    }
  }, [activeSection, hasVisitedProviders]);
  const {
    config,
    safeConfig,
    loading,
    saving,
    error,
    setError,
    setSaving,
    setConfig,
    setOptimisticConfig,
    updateConfig,
    ignoredRepositoryItems,
    excludedRepositoryIds,
    isSnoozed,
  } = useSettingsConfig();

  const handlers = useSettingsHandlers({
    config,
    setSaving,
    setError,
    setConfig,
    setOptimisticConfig,
    updateConfig,
  });

  // Wait for configuration and nested lazy sections before consuming deep links.
  useEffect(() => {
    const content = contentRef.current;
    if (loading || !config || !pendingAnchor || !content) return;
    const scrollToAnchor = (): boolean => {
      const anchor = document.getElementById(pendingAnchor);
      if (!anchor || !content.contains(anchor)) return false;
      anchor.scrollIntoView({ block: 'start' });
      onAnchorHandled();
      return true;
    };
    let observer: MutationObserver | undefined;
    const frameId = window.requestAnimationFrame(() => {
      if (scrollToAnchor()) return;
      observer = new MutationObserver(() => {
        if (scrollToAnchor()) observer?.disconnect();
      });
      observer.observe(content, { childList: true, subtree: true });
    });
    return () => {
      window.cancelAnimationFrame(frameId);
      observer?.disconnect();
    };
  }, [loading, config, pendingAnchor, activeSection, onAnchorHandled]);

  if (loading) {
    return <SettingsLoadingSkeleton label={t('view.loading')} activeSection={activeSection} />;
  }

  // Error state
  if (error && !config) {
    return (
      <div
        className="flex flex-1 items-center justify-center"
        style={{ backgroundColor: 'var(--color-surface)' }}
      >
        <div className="text-center">
          <p className="mb-4 text-red-400">{error}</p>
          <button
            onClick={() => window.location.reload()}
            className="rounded-md px-4 py-2 transition-colors"
            style={{
              backgroundColor: 'var(--color-surface-raised)',
              color: 'var(--color-text-secondary)',
            }}
          >
            {commonT('actions.retry')}
          </button>
        </div>
      </div>
    );
  }

  if (!config) return null;

  return (
    <div ref={contentRef} className="min-w-0 flex-1 overflow-auto">
      <div
        className={`mx-auto w-full px-6 py-8 transition-[max-width] duration-200 ${
          activeSection === 'notifications'
            ? 'max-w-7xl'
            : activeSection === 'providers'
              ? 'max-w-5xl'
              : 'max-w-2xl'
        }`}
      >
        {error && (
          <div className="mb-4 rounded-md border border-red-500/20 bg-red-500/10 px-3 py-2">
            <p className="text-sm text-red-400">{error}</p>
          </div>
        )}

        {/* Content */}
        <div className="mt-4">
          {activeSection === 'general' && (
            <GeneralSection
              safeConfig={safeConfig}
              saving={saving}
              onGeneralToggle={handlers.handleGeneralToggle}
              onLanguageChange={handlers.handleLanguageChange}
              onAppLocaleChange={handlers.handleAppLocaleChange}
            />
          )}

          {activeSection === 'appearance' && (
            <AppearanceSection
              safeConfig={safeConfig}
              saving={saving}
              onGeneralToggle={handlers.handleGeneralToggle}
              onNativeTitleBarChange={(value) =>
                updateConfig('general', { useNativeTitleBar: value })
              }
              onThemeChange={handlers.handleThemeChange}
            />
          )}

          {activeSection === 'connection' && <ConnectionSection />}

          {(hasVisitedProviders || activeSection === 'providers') && (
            <div
              data-testid="provider-settings-page"
              className={activeSection === 'providers' ? undefined : 'hidden'}
            >
              <Suspense
                fallback={
                  <div className="flex min-h-24 items-center justify-center">
                    <Loader2 className="size-5 animate-spin text-text-muted" />
                  </div>
                }
              >
                <CliStatusBanner isDashboardActive={isActive && activeSection === 'providers'} />
              </Suspense>
            </div>
          )}

          {activeSection === 'externalAgentConnection' && isElectronMode() && (
            <ExternalAgentConnectionSettings
              api={api.externalAgentConnection}
              local={connectionMode === 'local'}
              cdpEnabled={safeConfig.general.externalAgentCdpEnabled}
              saving={saving}
              onCdpEnabledChange={(enabled) =>
                handlers.handleGeneralToggle('externalAgentCdpEnabled', enabled)
              }
            />
          )}

          {activeSection === 'notifications' && (
            <NotificationsSection
              safeConfig={safeConfig}
              saving={saving}
              isSnoozed={isSnoozed}
              ignoredRepositoryItems={ignoredRepositoryItems}
              excludedRepositoryIds={excludedRepositoryIds}
              onNotificationToggle={handlers.handleNotificationToggle}
              onTeamRuntimeRecoveryUpdate={handlers.handleTeamRuntimeRecoveryUpdate}
              onSnooze={handlers.handleSnooze}
              onClearSnooze={handlers.handleClearSnooze}
              onAddIgnoredRepository={handlers.handleAddIgnoredRepository}
              onRemoveIgnoredRepository={handlers.handleRemoveIgnoredRepository}
              onAddTrigger={handlers.handleAddTrigger}
              onUpdateTrigger={handlers.handleUpdateTrigger}
              onRemoveTrigger={handlers.handleRemoveTrigger}
              onStatusChangeStatusesUpdate={handlers.handleStatusChangeStatusesUpdate}
            />
          )}

          {activeSection === 'advanced' && (
            <AdvancedSection
              saving={saving}
              onResetToDefaults={handlers.handleResetToDefaults}
              onExportConfig={handlers.handleExportConfig}
              onImportConfig={handlers.handleImportConfig}
              onOpenInEditor={handlers.handleOpenInEditor}
            />
          )}
        </div>
      </div>
    </div>
  );
};
