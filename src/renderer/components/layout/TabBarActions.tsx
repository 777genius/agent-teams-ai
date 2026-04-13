/**
 * TabBarActions - Right-side action buttons for the tab bar row.
 * Extracted from TabBar to render once (not per-pane).
 * Reads focused pane data from root store selectors (auto-synced via syncRootState).
 */

import { useMemo, useState } from 'react';

import { isElectronMode } from '@renderer/api';
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip';
import { useStore } from '@renderer/store';
import { Bell, PanelRight } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';

import { MoreMenu } from './MoreMenu';

export const TabBarActions = (): React.JSX.Element => {
  const {
    unreadCount,
    openNotificationsTab,
    activeTabId,
    openTabs,
    tabSessionData,
    sidebarCollapsed,
    toggleSidebar,
    updateStatus,
    openUpdateDialog,
  } = useStore(
    useShallow((s) => ({
      unreadCount: s.unreadCount,
      openNotificationsTab: s.openNotificationsTab,
      activeTabId: s.activeTabId,
      openTabs: s.openTabs,
      tabSessionData: s.tabSessionData,
      sidebarCollapsed: s.sidebarCollapsed,
      toggleSidebar: s.toggleSidebar,
      updateStatus: s.updateStatus,
      openUpdateDialog: s.openUpdateDialog,
    }))
  );

  // Hover states for buttons
  const [notificationsHover, setNotificationsHover] = useState(false);
  const [githubHover, setGithubHover] = useState(false);
  const [discordHover, setDiscordHover] = useState(false);
  const [expandHover, setExpandHover] = useState(false);
  const [updateHover, setUpdateHover] = useState(false);

  // Derive active tab and session detail for MoreMenu
  const activeTab = useMemo(
    () => openTabs.find((t) => t.id === activeTabId),
    [openTabs, activeTabId]
  );
  const activeTabSessionDetail = activeTabId
    ? (tabSessionData[activeTabId]?.sessionDetail ?? null)
    : null;

  return (
    <div
      className="ml-2 flex shrink-0 items-center gap-1"
      style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
    >
      {/* Update app button — only visible when update available or downloaded */}
      {(updateStatus === 'available' || updateStatus === 'downloaded') && (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              onClick={openUpdateDialog}
              onMouseEnter={() => setUpdateHover(true)}
              onMouseLeave={() => setUpdateHover(false)}
              className="rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors"
              style={{
                color: updateHover ? '#4ade80' : '#22c55e',
                backgroundColor: updateHover ? 'rgba(34, 197, 94, 0.1)' : 'transparent',
              }}
            >
              {updateStatus === 'downloaded' ? 'Restart to update' : 'Update app'}
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            {updateStatus === 'downloaded'
              ? 'Update downloaded, restart to apply'
              : 'New version available'}
          </TooltipContent>
        </Tooltip>
      )}

      {/* Notifications bell icon */}
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            onClick={openNotificationsTab}
            onMouseEnter={() => setNotificationsHover(true)}
            onMouseLeave={() => setNotificationsHover(false)}
            className="relative rounded-md p-2 transition-colors"
            style={{
              color: notificationsHover ? 'var(--color-text)' : 'var(--color-text-muted)',
              backgroundColor: notificationsHover ? 'var(--color-surface-raised)' : 'transparent',
            }}
            aria-label="Notifications"
          >
            <Bell className="size-4" />
            {unreadCount > 0 && (
              <span className="absolute -right-0.5 -top-0.5 flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-red-500 px-1 text-xs font-medium text-white">
                {unreadCount > 99 ? '99+' : unreadCount}
              </span>
            )}
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom">Notifications</TooltipContent>
      </Tooltip>

      {/* GitHub link */}
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            onClick={async () => {
              if (isElectronMode()) {
                await window.electronAPI.openExternal(
                  'https://github.com/777genius/claude_agent_teams_ui'
                );
                return;
              }

              window.open(
                'https://github.com/777genius/claude_agent_teams_ui',
                '_blank',
                'noopener,noreferrer'
              );
            }}
            onMouseEnter={() => setGithubHover(true)}
            onMouseLeave={() => setGithubHover(false)}
            className="rounded-md p-2 transition-colors"
            style={{
              color: githubHover ? 'var(--color-text)' : 'var(--color-text-muted)',
              backgroundColor: githubHover ? 'var(--color-surface-raised)' : 'transparent',
            }}
            aria-label="GitHub"
          >
            <svg className="size-4" viewBox="0 0 24 24" fill="currentColor">
              <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0 0 24 12c0-6.63-5.37-12-12-12Z" />
            </svg>
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom">GitHub</TooltipContent>
      </Tooltip>

      {/* Discord link */}
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            onClick={async () => {
              if (isElectronMode()) {
                await window.electronAPI.openExternal('https://discord.gg/qtqSZSyuEc');
                return;
              }

              window.open('https://discord.gg/qtqSZSyuEc', '_blank', 'noopener,noreferrer');
            }}
            onMouseEnter={() => setDiscordHover(true)}
            onMouseLeave={() => setDiscordHover(false)}
            className="rounded-md p-2 transition-colors"
            style={{
              color: discordHover ? 'var(--color-text)' : 'var(--color-text-muted)',
              backgroundColor: discordHover ? 'var(--color-surface-raised)' : 'transparent',
            }}
            aria-label="Discord"
          >
            <svg className="size-4" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <path d="M20.317 4.3698A19.791 19.791 0 0 0 15.4319 3.0a13.873 13.873 0 0 0-.6242 1.2757 18.27 18.27 0 0 0-5.6154 0A13.872 13.872 0 0 0 8.5681 3 19.736 19.736 0 0 0 3.683 4.3698C.5334 9.1048-.319 13.7216.099 18.272a19.9 19.9 0 0 0 6.0892 3.1157 14.96 14.96 0 0 0 1.303-2.1356 12.46 12.46 0 0 1-1.9352-.9351c.1624-.1218.3217-.2462.4763-.3736 3.7294 1.7014 7.772 1.7014 11.4572 0 .1546.1274.3139.2518.4763.3736-.6163.3622-1.2638.6754-1.9352.9351.3654.7439.8041 1.4554 1.303 2.1356A19.9 19.9 0 0 0 23.901 18.272c.5003-5.2737-.8381-9.8482-3.584-13.9022ZM8.02 15.3312c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3334.9555-2.4191 2.1569-2.4191 1.2103 0 2.1757 1.0946 2.1568 2.419 0 1.3334-.9465 2.4191-2.1568 2.4191Zm7.96 0c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3334.9555-2.4191 2.1569-2.4191 1.2103 0 2.1757 1.0946 2.1568 2.419 0 1.3334-.9465 2.4191-2.1568 2.4191Z" />
            </svg>
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom">Discord</TooltipContent>
      </Tooltip>

      {/* More menu (Teams, Settings, Extensions, Search, Export, Analyze, Schedules) */}
      <MoreMenu
        activeTab={activeTab}
        activeTabSessionDetail={activeTabSessionDetail}
        activeTabId={activeTabId}
      />

      {/* Expand sidebar — rightmost, only when collapsed */}
      {sidebarCollapsed && (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              onClick={toggleSidebar}
              onMouseEnter={() => setExpandHover(true)}
              onMouseLeave={() => setExpandHover(false)}
              className="mr-1 rounded-md p-2 transition-colors"
              style={{
                color: expandHover ? 'var(--color-text)' : 'var(--color-text-muted)',
                backgroundColor: expandHover ? 'var(--color-surface-raised)' : 'transparent',
              }}
              aria-label="Expand sidebar"
            >
              <PanelRight className="size-4" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom">Expand sidebar</TooltipContent>
        </Tooltip>
      )}
    </div>
  );
};
