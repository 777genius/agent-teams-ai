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
  const { rows, hidden, readStatus, retryAliveRead, openRunningTeam } =
    useRunningTeamsSection(searchQuery);

  if (hidden) {
    return null;
  }

  return (
    <RunningTeamsSectionView
      title={t('runningTeams.title')}
      readState={
        readStatus.phase === 'ready'
          ? undefined
          : {
              phase: readStatus.phase,
              stale: readStatus.stale,
              message: t(readStatus.phase === 'loading' ? 'list.loading' : 'list.loadFailed'),
              onRetry: readStatus.phase === 'error' ? retryAliveRead : undefined,
              retryLabel: t('list.actions.retry'),
            }
      }
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
