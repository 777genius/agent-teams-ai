import { useAppTranslation } from '@features/localization/renderer';
import { Button } from '@renderer/components/ui/button';

import type { TeamReadUnavailable } from '@shared/types';

interface Props {
  surface: 'teams' | 'tasks';
  unavailable: readonly TeamReadUnavailable[];
  error: string | null;
  loadedCount: number;
  loading: boolean;
  onRefresh(): void;
  onOpenTeam(teamName: string): void;
}

/** Display-only metadata; navigation and Refresh keep their original owners. */
export const TeamAggregateReadNotice = ({
  surface,
  unavailable,
  error,
  loadedCount,
  loading,
  onRefresh,
  onOpenTeam,
}: Props): React.JSX.Element | null => {
  const { t } = useAppTranslation('team');
  const stale = error !== null;
  if (!stale && unavailable.length === 0) return null;
  const teams = unavailable.filter((row) => row.kind === 'team');
  const ownerCount = unavailable.length - teams.length;
  const title =
    surface === 'teams'
      ? t(stale ? 'list.aggregate.staleTeams' : 'list.aggregate.partialTeams')
      : t(stale ? 'list.aggregate.staleTasks' : 'list.aggregate.partialTasks');
  return (
    <section
      role="status"
      aria-label={title}
      data-team-aggregate-notice={surface}
      data-state={stale ? 'stale' : 'partial'}
      data-team-count={teams.length}
      data-owner-count={ownerCount}
      data-loaded-count={loadedCount}
      className="m-2 rounded-md border border-amber-500/30 bg-amber-500/5 p-3 text-xs text-text-secondary"
    >
      <div className="flex items-center justify-between gap-2">
        <strong>{title}</strong>
        <Button variant="outline" size="sm" disabled={loading} onClick={onRefresh}>
          {t('list.aggregate.refresh')}
        </Button>
      </div>
      <p className="mt-1">
        {stale
          ? t('list.aggregate.staleDescription')
          : t(
              surface === 'teams'
                ? 'list.aggregate.teamsDescription'
                : 'list.aggregate.tasksDescription'
            )}
      </p>
      <p className="mt-1">{t('list.aggregate.loadedCount', { count: loadedCount })}</p>
      {teams.length > 0 && (
        <div className="mt-2">
          <p>{t('list.aggregate.unavailableTeams', { count: teams.length })}</p>
          <ul className="mt-1 space-y-1">
            {teams.map((team) => (
              <li key={team.teamName}>
                <Button
                  variant="link"
                  size="sm"
                  data-unavailable-team={team.teamName}
                  onClick={() => onOpenTeam(team.teamName)}
                  aria-label={t('list.aggregate.openTeam', { name: team.displayName })}
                >
                  {team.displayName}
                </Button>
              </li>
            ))}
          </ul>
        </div>
      )}
      {ownerCount > 0 && (
        <p className="mt-2">{t('list.aggregate.unavailableOwners', { count: ownerCount })}</p>
      )}
      {stale && error && <p className="mt-2 text-red-400">{error}</p>}
    </section>
  );
};
