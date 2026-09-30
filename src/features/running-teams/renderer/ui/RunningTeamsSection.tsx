import { useDesktopRunningTeams } from '../hooks/useDesktopRunningTeams';
import { filterRunningTeamRows } from '../view-models/filterRunningTeamRows';

import { RunningTeamsSectionView } from './RunningTeamsSectionView';

import type React from 'react';

interface RunningTeamsSectionProps {
  searchQuery: string;
}

/** Legacy connected entrypoint. DashboardScreen uses the public read adapter directly. */
export const RunningTeamsSection = ({
  searchQuery,
}: Readonly<RunningTeamsSectionProps>): React.JSX.Element | null => {
  const section = useDesktopRunningTeams();
  const rows = filterRunningTeamRows(section.rows, searchQuery);
  if (rows.length === 0 && !section.readState && !searchQuery.trim()) return null;
  return <RunningTeamsSectionView {...section} rows={rows} />;
};
