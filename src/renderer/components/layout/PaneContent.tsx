/**
 * PaneContent - Renders tab content for a single pane.
 * Uses CSS display-toggle to keep all tabs mounted (preserving state).
 */

import { TabUIProvider } from '@renderer/contexts/TabUIContext';
import { TeamGraphTab } from '@renderer/features/agent-graph/ui/TeamGraphTab';

import { DashboardView } from '../dashboard/DashboardView';
import { ExtensionStoreView } from '../extensions/ExtensionStoreView';
import { NotificationsView } from '../notifications/NotificationsView';
import { SessionReportTab } from '../report/SessionReportTab';
import { SchedulesView } from '../schedules/SchedulesView';
import { SettingsView } from '../settings/SettingsView';
import { TeamDetailView } from '../team/TeamDetailView';
import { TeamListView } from '../team/TeamListView';

import { SessionTabContent } from './SessionTabContent';

import type { Pane } from '@renderer/types/panes';

interface PaneContentProps {
  pane: Pane;
  isPaneFocused: boolean;
}

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
          <div
            key={tab.id}
            className="absolute inset-0 flex"
            style={{ display: isActive ? 'flex' : 'none' }}
          >
            {tab.type === 'dashboard' && <DashboardView />}
            {tab.type === 'notifications' && <NotificationsView />}
            {tab.type === 'settings' && <SettingsView />}
            {tab.type === 'teams' && <TeamListView />}
            {tab.type === 'team' && (
              <TabUIProvider tabId={tab.id}>
                <TeamDetailView teamName={tab.teamName ?? ''} isPaneFocused={isPaneFocused} />
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
            {tab.type === 'graph' && (
              <TabUIProvider tabId={tab.id}>
                <TeamGraphTab
                  teamName={tab.teamName ?? ''}
                  isActive={isActive}
                  isPaneFocused={isPaneFocused}
                />
              </TabUIProvider>
            )}
          </div>
        );
      })}
    </div>
  );
};
