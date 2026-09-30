import { useAppTranslation } from '@features/localization/renderer';

import { useRunningTeamsSection } from './useRunningTeamsSection';

import type { RunningTeamsSectionViewProps } from '../ui/RunningTeamsSectionView';

/** Desktop read and navigation adapter. Query belongs to the Dashboard screen. */
export function useDesktopRunningTeams(): RunningTeamsSectionViewProps {
  const { t } = useAppTranslation('team');
  const { rows, readStatus, retryAliveRead, openRunningTeam } = useRunningTeamsSection();

  return {
    title: t('runningTeams.title'),
    readState:
      readStatus.phase === 'ready'
        ? undefined
        : {
            phase: readStatus.phase,
            stale: readStatus.stale,
            message: t(readStatus.phase === 'loading' ? 'list.loading' : 'list.loadFailed'),
            onRetry: readStatus.phase === 'error' ? retryAliveRead : undefined,
            retryLabel: t('list.actions.retry'),
          },
    rows: rows.map((row) => ({
      targetKey: row.id,
      displayName: row.displayName,
      projectLabel: row.projectLabel,
      detail: row.projectPath,
      status: row.status,
      statusLabel: row.statusLabel,
      iconColor: row.iconColor,
      taskCounts: row.taskCounts,
    })),
    onOpen: (targetKey) => {
      const row = rows.find((candidate) => candidate.id === targetKey);
      if (row) openRunningTeam(row);
    },
  };
}
