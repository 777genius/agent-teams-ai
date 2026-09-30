import { DashboardScreen } from '@features/dashboard/renderer';
import { useAppTranslation } from '@features/localization/renderer';

import type { DashboardScreenProps } from '@features/dashboard/renderer';
import type { RunningTeamsSectionViewProps } from '@features/running-teams/renderer/hosted';

interface HostedDashboardSurfaceProps {
  readonly active: boolean;
  readonly scopeKey: string;
  readonly runningTeams: RunningTeamsSectionViewProps;
  readonly runningTeamsAvailable: boolean;
  readonly RecentProjects: DashboardScreenProps['RecentProjects'];
  readonly onSelectTeam: () => void;
  readonly onOpenPalette: () => void;
}

export const HostedDashboardSurface = ({
  active,
  scopeKey,
  runningTeams,
  runningTeamsAvailable,
  RecentProjects,
  onSelectTeam,
  onOpenPalette,
}: HostedDashboardSurfaceProps): React.JSX.Element => {
  const { t } = useAppTranslation('dashboard');
  const { t: tTeam } = useAppTranslation('team');
  return (
    <div className={active ? 'flex size-full min-h-0' : 'hidden'}>
      <DashboardScreen
        scopeKey={scopeKey}
        runningTeams={
          runningTeamsAvailable
            ? runningTeams
            : { title: 'Running teams', rows: [], onOpen: () => {} }
        }
        RecentProjects={RecentProjects}
        onSelectTeam={onSelectTeam}
        onOpenPalette={onOpenPalette}
        labels={{
          selectTeam: t('actions.selectTeam'),
          or: t('actions.or'),
          searchPlaceholder: t('recentProjects.searchPlaceholder'),
          palette: 'Browse workspaces',
          paletteShortcut: '',
          recentTitle: t('recentProjects.title'),
          searchResults: t('recentProjects.searchResults'),
          clearSearch: t('actions.clearSearch'),
          noRunningMatches: tTeam('list.noMatches'),
        }}
      />
    </div>
  );
};
