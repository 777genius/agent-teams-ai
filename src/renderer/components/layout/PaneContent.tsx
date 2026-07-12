/**
 * PaneContent - Renders tab content for a single pane.
 * Uses CSS display-toggle to keep all tabs mounted (preserving state).
 */

import { lazy, Suspense, useEffect, useState } from 'react';

import { useAppTranslation } from '@features/localization/renderer';
import { getTeamColorSet } from '@renderer/constants/teamColors';
import { TabUIProvider } from '@renderer/contexts/TabUIContext';
import { useTheme } from '@renderer/hooks/useTheme';
import { useStore } from '@renderer/store';
import { nameColorSet } from '@renderer/utils/projectColor';
import { useShallow } from 'zustand/react/shallow';

import { DashboardView } from '../dashboard/DashboardView';
import { TeamLoadingSkeleton } from '../team/TeamLoadingSkeleton';

import type { Pane } from '@renderer/types/panes';
import type { Tab } from '@renderer/types/tabs';

const ExtensionStoreView = lazy(() =>
  import('../extensions/ExtensionStoreView').then((module) => ({
    default: module.ExtensionStoreView,
  }))
);
const NotificationsView = lazy(() =>
  import('../notifications/NotificationsView').then((module) => ({
    default: module.NotificationsView,
  }))
);
const SessionReportTab = lazy(() =>
  import('../report/SessionReportTab').then((module) => ({
    default: module.SessionReportTab,
  }))
);
const SchedulesView = lazy(() =>
  import('../schedules/SchedulesView').then((module) => ({
    default: module.SchedulesView,
  }))
);
const SettingsView = lazy(() =>
  import('../settings/SettingsView').then((module) => ({
    default: module.SettingsView,
  }))
);
const TeamDetailView = lazy(() =>
  import('../team/TeamDetailView').then((module) => ({
    default: module.TeamDetailView,
  }))
);
const TeamListView = lazy(() =>
  import('../team/TeamListView').then((module) => ({
    default: module.TeamListView,
  }))
);
const SessionTabContent = lazy(() =>
  import('./SessionTabContent').then((module) => ({
    default: module.SessionTabContent,
  }))
);
const TeamGraphTab = lazy(() =>
  import('@features/agent-graph/renderer').then((module) => ({
    default: module.TeamGraphTab,
  }))
);
const OrganizationMapTab = lazy(() =>
  import('@features/organizations/renderer').then((module) => ({
    default: module.OrganizationMapTab,
  }))
);
const TokenUsageDashboard = lazy(() =>
  import('@features/token-usage/renderer').then((module) => ({
    default: module.TokenUsageDashboard,
  }))
);

interface PaneContentProps {
  pane: Pane;
  isPaneFocused: boolean;
}

interface PaneTabSlotProps {
  tab: Tab;
  isActive: boolean;
  isPaneFocused: boolean;
}

const PaneLazyFallback = (): React.JSX.Element => {
  const { t } = useAppTranslation('common');

  return (
    <div className="flex flex-1 items-center justify-center bg-surface">
      <div
        className="size-5 animate-spin rounded-full border border-border border-t-text-muted"
        aria-label={t('layout.loadingTab')}
        role="status"
      />
    </div>
  );
};

const TeamPaneLazyFallback = ({
  teamName,
  isActive,
  isPaneFocused,
}: {
  teamName: string;
  isActive: boolean;
  isPaneFocused: boolean;
}): React.JSX.Element => {
  const { isLight } = useTheme();
  const { messagesPanelMode, teamSummaryColor, teamSummaryDisplayName } = useStore(
    useShallow((s) => ({
      messagesPanelMode: s.messagesPanelMode,
      teamSummaryColor: teamName ? s.teamByName[teamName]?.color : undefined,
      teamSummaryDisplayName: teamName ? s.teamByName[teamName]?.displayName : undefined,
    }))
  );
  const headerColorSet = teamSummaryColor
    ? getTeamColorSet(teamSummaryColor)
    : nameColorSet(teamSummaryDisplayName || teamName);

  return (
    <TeamLoadingSkeleton
      teamName={teamName}
      isActive={isActive}
      isFocused={isPaneFocused}
      messagesPanelMode={messagesPanelMode}
      headerColorSet={headerColorSet}
      isLight={isLight}
    />
  );
};

const PaneTabSlot = ({ tab, isActive, isPaneFocused }: PaneTabSlotProps): React.JSX.Element => {
  const [hasActivated, setHasActivated] = useState(isActive);
  const shouldRenderContent = hasActivated && (tab.type !== 'teams' || isActive);

  useEffect(() => {
    if (isActive) {
      setHasActivated(true);
    }
  }, [isActive]);

  const fallback =
    tab.type === 'team' && tab.teamName ? (
      <TeamPaneLazyFallback
        teamName={tab.teamName}
        isActive={isActive}
        isPaneFocused={isPaneFocused}
      />
    ) : (
      <PaneLazyFallback />
    );

  return (
    <div className="absolute inset-0 flex" style={{ display: isActive ? 'flex' : 'none' }}>
      {shouldRenderContent && (
        <Suspense fallback={fallback}>
          {tab.type === 'dashboard' && <DashboardView isActive={isActive} />}
          {tab.type === 'notifications' && <NotificationsView />}
          {tab.type === 'settings' && <SettingsView />}
          {tab.type === 'teams' && <TeamListView />}
          {tab.type === 'organizations' && (
            <TabUIProvider tabId={tab.id}>
              <OrganizationMapTab isActive={isActive} isPaneFocused={isPaneFocused} />
            </TabUIProvider>
          )}
          {tab.type === 'team' && (
            <TabUIProvider tabId={tab.id}>
              <TeamDetailView
                teamName={tab.teamName ?? ''}
                isActive={isActive}
                isPaneFocused={isPaneFocused}
              />
            </TabUIProvider>
          )}
          {tab.type === 'session' && (
            <TabUIProvider tabId={tab.id}>
              <SessionTabContent tab={tab} isActive={isActive} />
            </TabUIProvider>
          )}
          {tab.type === 'report' && <SessionReportTab tab={tab} />}
          {tab.type === 'extensions' && (
            <TabUIProvider tabId={tab.id}>
              <ExtensionStoreView />
            </TabUIProvider>
          )}
          {tab.type === 'schedules' && <SchedulesView />}
          {tab.type === 'token-usage' && <TokenUsageDashboard initialTeamName={tab.teamName} />}
          {tab.type === 'graph' && (
            <TabUIProvider tabId={tab.id}>
              <TeamGraphTab
                teamName={tab.teamName ?? ''}
                isActive={isActive}
                isPaneFocused={isPaneFocused}
              />
            </TabUIProvider>
          )}
        </Suspense>
      )}
    </div>
  );
};

export const PaneContent = ({ pane, isPaneFocused }: PaneContentProps): React.JSX.Element => {
  const activeTabId = pane.activeTabId;

  // Show default dashboard if no tabs are open in this pane
  const showDefaultDashboard = !activeTabId && pane.tabs.length === 0;

  return (
    <div className="relative flex flex-1 overflow-hidden">
      {showDefaultDashboard && (
        <div className="absolute inset-0 flex">
          <DashboardView />
        </div>
      )}

      {pane.tabs.map((tab) => {
        const isActive = tab.id === activeTabId;
        return (
          <PaneTabSlot key={tab.id} tab={tab} isActive={isActive} isPaneFocused={isPaneFocused} />
        );
      })}
    </div>
  );
};
