import { useCallback } from 'react';

import { DashboardScreen } from '@features/dashboard/renderer';
import { useAppTranslation } from '@features/localization/renderer';
import { RecentProjectsSection } from '@features/recent-projects/renderer';
import { useDesktopRunningTeams } from '@features/running-teams/renderer';
import { CliStatusBanner } from '@renderer/components/dashboard/CliStatusBanner';
import { DashboardUpdateBanner } from '@renderer/components/dashboard/DashboardUpdateBanner';
import { TmuxStatusBanner } from '@renderer/components/dashboard/TmuxStatusBanner';
import { WebPreviewBanner } from '@renderer/components/dashboard/WebPreviewBanner';
import { WindowsAdministratorBanner } from '@renderer/components/dashboard/WindowsAdministratorBanner';
import { getOverlaySnapshot } from '@renderer/hooks/useOverlayOccupancy';
import { useStore } from '@renderer/store';
import { formatShortcut } from '@renderer/utils/stringUtils';
import { useShallow } from 'zustand/react/shallow';

import type React from 'react';

export const DesktopDashboard = ({
  isActive,
}: Readonly<{ isActive: boolean }>): React.JSX.Element => {
  const { t } = useAppTranslation('dashboard');
  const { t: tTeam } = useAppTranslation('team');
  const runningTeams = useDesktopRunningTeams();
  const { openTeamsTab, openCommandPalette, selectedProjectId, activeContextId } = useStore(
    useShallow((state) => ({
      openTeamsTab: state.openTeamsTab,
      openCommandPalette: state.openCommandPalette,
      selectedProjectId: state.selectedProjectId,
      activeContextId: state.activeContextId,
    }))
  );
  const shortcut = formatShortcut('K');
  const shouldFocusSearch = useCallback(
    () =>
      isActive &&
      document.visibilityState === 'visible' &&
      document.hasFocus() &&
      getOverlaySnapshot().count === 0,
    [isActive]
  );
  return (
    <DashboardScreen
      shouldFocusSearch={shouldFocusSearch}
      scopeKey={activeContextId}
      runningTeams={runningTeams}
      RecentProjects={RecentProjectsSection}
      onSelectTeam={() => openTeamsTab()}
      onOpenPalette={openCommandPalette}
      labels={{
        selectTeam: t('actions.selectTeam'),
        or: t('actions.or'),
        searchPlaceholder: t('recentProjects.searchPlaceholder'),
        palette: selectedProjectId
          ? `Search in sessions (${shortcut})`
          : `Search projects (${shortcut})`,
        paletteShortcut: shortcut,
        recentTitle: t('recentProjects.title'),
        searchResults: t('recentProjects.searchResults'),
        clearSearch: t('actions.clearSearch'),
        noRunningMatches: tTeam('list.noMatches'),
      }}
      environmentNotices={
        <>
          <WebPreviewBanner />
          <WindowsAdministratorBanner />
          <DashboardUpdateBanner />
          <CliStatusBanner isDashboardActive={isActive} />
          <TmuxStatusBanner />
        </>
      }
    />
  );
};
