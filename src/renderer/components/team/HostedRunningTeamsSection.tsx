import { useMemo } from 'react';

import { useAppTranslation } from '@features/localization/renderer';
import {
  rankRunningTeamFacts,
  RunningTeamsSectionView,
} from '@features/running-teams/renderer/hosted';

import type { RunningTeamFacts, RunningTeamViewRow } from '@features/running-teams/renderer/hosted';
import type { HostedTeamDirectoryReadState } from '@features/team-lifecycle/renderer';
import type { TeamId, WorkspaceId } from '@shared/contracts/hosted';

interface HostedRunningTeamsSectionProps {
  readonly workspaceId: WorkspaceId;
  readonly state: HostedTeamDirectoryReadState;
  readonly reload: () => Promise<void>;
  readonly onSelect: (teamId: TeamId) => void;
}

/** Hosted contributes only exact positive runtime evidence to the shared running view. */
export const HostedRunningTeamsSection = ({
  workspaceId,
  state,
  reload,
  onSelect,
}: HostedRunningTeamsSectionProps): React.JSX.Element => {
  const { t } = useAppTranslation('team');
  const rows = useMemo<RunningTeamViewRow[]>(() => {
    const facts: RunningTeamFacts[] = (state.snapshot?.items ?? []).map((item) => ({
      targetKey: item.teamId,
      displayName: item.displayName,
      activity:
        state.runtime.byTeamId.get(item.teamId)?.runtime === 'running'
          ? 'running_unknown'
          : 'not_running',
      taskCounts: { kind: 'unknown' },
      lastActivity: { kind: 'unknown' },
    }));
    return rankRunningTeamFacts(facts).map((fact) => ({
      targetKey: fact.targetKey,
      displayName: fact.displayName,
      status: 'running_unknown',
      statusLabel:
        state.snapshot?.items.find((item) => item.teamId === fact.targetKey)?.lifecycle ===
        'degraded'
          ? `${t('list.status.running')} - ${t('list.status.partialFailure')}`
          : t('list.status.running'),
    }));
  }, [state.snapshot, state.runtime.byTeamId, t]);
  const open = (targetKey: string): void => {
    if (state.scopeKey !== workspaceId) return;
    const item = state.snapshot?.items.find(
      (candidate) => candidate.teamId === targetKey && candidate.workspaceId === workspaceId
    );
    if (item) onSelect(item.teamId);
  };

  return (
    <RunningTeamsSectionView
      title="Running teams"
      compact
      rows={rows}
      onOpen={open}
      emptyMessage="No running teams"
      readState={{
        phase:
          state.freshness === 'failed' ? 'error' : state.snapshot === null ? 'loading' : 'ready',
        stale: state.freshness === 'stale' || state.freshness === 'refreshing',
        incomplete: state.runtime.phase === 'incomplete' || state.runtime.phase === 'reading',
        message: state.failure
          ? 'Running team data is unavailable.'
          : state.freshness === 'refreshing'
            ? 'Refreshing teams...'
            : state.runtime.phase === 'incomplete'
              ? 'Some runtime statuses are unavailable.'
              : state.runtime.phase === 'reading'
                ? 'Checking runtime statuses...'
                : undefined,
        onRetry: () => void reload(),
        retryLabel: 'Refresh',
      }}
    />
  );
};
