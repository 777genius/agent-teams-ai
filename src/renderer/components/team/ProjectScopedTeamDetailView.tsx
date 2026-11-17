import { useCallback, useEffect, useMemo, useState } from 'react';

import { useAppTranslation } from '@features/localization/renderer';
import { Button } from '@renderer/components/ui/button';
import { api } from '@renderer/api';
import { useStore } from '@renderer/store';
import { useShallow } from 'zustand/react/shallow';

import { resolveTeamProjectSelection } from './teamProjectSelection';
import { TeamDetailView } from './TeamDetailView';

import type { TeamProjectContextView } from '@features/team-project-context/contracts';

interface Props {
  teamName: string;
  isActive?: boolean;
  isPaneFocused?: boolean;
}

interface ViewResult {
  key: string;
  context?: TeamProjectContextView;
  error?: string;
}

const POLL_INTERVAL_MS = 2_500;

/**
 * One visible logical-team tab. A ready, owner-verified native alias is passed
 * to the existing Tasks/Messages screen; nothing is copied or filtered by time.
 */
export function ProjectScopedTeamDetailView({
  teamName,
  isActive = true,
  isPaneFocused = true,
}: Props): React.JSX.Element {
  const { t } = useAppTranslation('team');
  const {
    repositoryGroups,
    projects,
    selectedRepositoryId,
    selectedWorktreeId,
    selectedProjectId,
    activeProjectId,
    logicalDisplayName,
  } = useStore(useShallow((state) => ({
    repositoryGroups: state.repositoryGroups,
    projects: state.projects,
    selectedRepositoryId: state.selectedRepositoryId,
    selectedWorktreeId: state.selectedWorktreeId,
    selectedProjectId: state.selectedProjectId,
    activeProjectId: state.activeProjectId,
    logicalDisplayName: state.teamByName[teamName]?.displayName ?? teamName,
  })));
  const selectedProjectPath = useMemo(
    () =>
      resolveTeamProjectSelection({
        repositoryGroups,
        projects,
        selectedRepositoryId,
        selectedWorktreeId,
        selectedProjectId,
        activeProjectId,
      }).projectPath,
    [
      repositoryGroups,
      projects,
      selectedRepositoryId,
      selectedWorktreeId,
      selectedProjectId,
      activeProjectId,
    ]
  );
  const key = `${teamName}\u0000${selectedProjectPath ?? ''}`;
  const [result, setResult] = useState<ViewResult | null>(null);
  const [launching, setLaunching] = useState(false);
  const [awaitingReadyKey, setAwaitingReadyKey] = useState<string | null>(null);

  const refresh = useCallback(async (isCurrent: () => boolean): Promise<void> => {
    try {
      const context = await api.teams.getProjectContextView(teamName, selectedProjectPath);
      if (isCurrent()) {
        setResult({ key, context });
        if (context.state === 'ready') {
          setAwaitingReadyKey((current) => current === key ? null : current);
        }
      }
    } catch (error) {
      if (isCurrent()) {
        setResult({ key, error: error instanceof Error ? error.message : String(error) });
      }
    }
  }, [key, selectedProjectPath, teamName]);

  const state = result?.key === key ? result.context?.state : undefined;
  useEffect(() => {
    let alive = true;
    void refresh(() => alive);
    // Poll only while native provisioning is pending or immediately after an
    // explicit launch. A ready context requires no persistent background timer.
    const shouldPoll = isActive && (state === 'pending' || awaitingReadyKey === key);
    const timer = shouldPoll
      ? setInterval(() => { void refresh(() => alive); }, POLL_INTERVAL_MS)
      : null;
    return () => {
      alive = false;
      if (timer !== null) clearInterval(timer);
    };
  }, [isActive, state, awaitingReadyKey, key, refresh]);

  const context = result?.key === key ? result.context : undefined;
  const error = result?.key === key ? result.error : undefined;

  const start = useCallback(async (): Promise<void> => {
    if (!selectedProjectPath || launching) return;
    setLaunching(true);
    setAwaitingReadyKey(key);
    try {
      await api.teams.launchTeam({ teamName, cwd: selectedProjectPath });
      await refresh(() => true);
    } catch (reason) {
      setAwaitingReadyKey(null);
      setResult({
        key,
        error: reason instanceof Error ? reason.message : String(reason),
      });
    } finally {
      setLaunching(false);
    }
  }, [key, launching, refresh, selectedProjectPath, teamName]);

  if (context?.state === 'ready') {
    if (context.mode === 'shared') {
      return <TeamDetailView teamName={teamName} isActive={isActive} isPaneFocused={isPaneFocused} />;
    }
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="border-b border-border px-4 py-2 text-xs text-text-muted">
          {logicalDisplayName} · {selectedProjectPath}
        </div>
        <div className="flex min-h-0 flex-1">
          <TeamDetailView
            key={context.workContextId}
            teamName={context.executionTeamName}
            isActive={isActive}
            isPaneFocused={isPaneFocused}
          />
        </div>
      </div>
    );
  }

  let message = t('projectContextView.loading');
  if (error) message = error;
  else if (context?.state === 'needs_project') message = t('projectContextView.selectProject');
  else if (context?.state === 'empty') {
    message = t(awaitingReadyKey === key ? 'projectContextView.pending' : 'projectContextView.empty');
  }
  else if (context?.state === 'pending') message = t('projectContextView.pending');

  const canStart =
    Boolean(selectedProjectPath) &&
    !launching &&
    awaitingReadyKey !== key &&
    !error &&
    (context?.state === 'empty' || context?.state === 'pending');

  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
      <h2 className="text-base font-semibold">{logicalDisplayName}</h2>
      <p className="max-w-lg text-sm text-text-muted" role={error ? 'alert' : 'status'}>
        {message}
      </p>
      {canStart && (
        <Button onClick={() => { void start(); }} disabled={launching}>
          {t('projectContextView.start')}
        </Button>
      )}
      {error && (
        <Button variant="outline" onClick={() => { void refresh(() => true); }}>
          {t('projectContextView.retry')}
        </Button>
      )}
    </div>
  );
}
