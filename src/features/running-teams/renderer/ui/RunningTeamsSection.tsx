import { useAppTranslation } from '@features/localization/renderer';

import { useRunningTeamsSection } from '../hooks/useRunningTeamsSection';

import { RunningTeamsSectionView } from './RunningTeamsSectionView';

import type React from 'react';

interface RunningTeamsSectionProps {
  searchQuery: string;
}

export const RunningTeamsSection = ({
  searchQuery,
}: Readonly<RunningTeamsSectionProps>): React.JSX.Element | null => {
  const { t } = useAppTranslation('team');
  const { rows, hidden, openRunningTeam } = useRunningTeamsSection(searchQuery);

  if (hidden) {
    return null;
  }

  return (
    <RunningTeamsSectionView
      title={t('runningTeams.title')}
      rows={rows.map((row) => ({
        targetKey: row.id,
        displayName: row.displayName,
        projectLabel: row.projectLabel,
        detail: row.projectPath,
        status: row.status,
        statusLabel: row.statusLabel,
        iconColor: row.iconColor,
        taskCounts: row.taskCounts,
      }))}
      onOpen={(targetKey) => {
        const row = rows.find((candidate) => candidate.id === targetKey);
        if (row) {
          openRunningTeam(row);
        }
      }}
    />
  );
};
