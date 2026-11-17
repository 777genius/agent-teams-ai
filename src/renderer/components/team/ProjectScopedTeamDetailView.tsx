import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useAppTranslation } from '@features/localization/renderer';
import { api } from '@renderer/api';
import { Button } from '@renderer/components/ui/button';
import { useStore } from '@renderer/store';
import { useShallow } from 'zustand/react/shallow';

import { TeamDetailView } from './TeamDetailView';
import { TeamHistoryModePicker } from './TeamHistoryModePicker';
import { resolveTeamProjectSelection } from './teamProjectSelection';

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
  const [launchingKey, setLaunchingKey] = useState<string | null>(null);
  const [awaitingReadyKey, setAwaitingReadyKey] = useState<string | null>(null);
  const activeKeyRef = useRef(key);
  activeKeyRef.current = key;
  const launchRef = useRef<{ key: string; runId: string | null } | null>(null);
  const launching = launchingKey === key;

  const refresh = useCallback(async (isCurrent: () => boolean): Promise<void> => {
    try {
      const context = await api.teams.getProjectContextView(teamName, selectedProjectPath);
      if (isCurrent() && activeKeyRef.current === key) {
        setResult({ key, context });
        if (context.state === 'ready') {
          setAwaitingReadyKey((current) => current === key ? null : current);
        }
      }
    } catch (error) {
      if (isCurrent() && activeKeyRef.current === key) {
        setResult({ key, error: error instanceof Error ? error.message : String(error) });
      }
    }
  }, [key, selectedProjectPath, teamName]);

  useEffect(() =>
    api.teams.onProvisioningProgress((_event, progress) => {
      const launch = launchRef.current;
      if (!launch || launch.key !== activeKeyRef.current) return;
      if (progress.teamName !== teamName) return;
      if (launch.runId && launch.runId !== progress.runId) return;
      if (progress.state === 'failed' || progress.state === 'cancelled' ||
          progress.state === 'disconnected') {
        setAwaitingReadyKey((current) => current === launch.key ? null : current);
        setResult({
          key: launch.key,
          error: progress.error || progress.message || 'Team provisioning failed',
        });
        launchRef.current = null;
      }
      if (progress.state === 'ready') {
        void refresh(() => activeKeyRef.current === launch.key);
      }
    }), [teamName, refresh]);

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
    // Native provisioning may be interrupted without a final progress event.
    // Allow explicit retry after the bounded wait; runtime admission still
    // refuses a parallel process or an unowned/incomplete physical context.
    const timeout = awaitingReadyKey === key
      ? setTimeout(() => {
          if (alive && activeKeyRef.current === key) {
            setAwaitingReadyKey((current) => current === key ? null : current);
            launchRef.current = null;
            setResult({
              key,
              error: 'Project provisioning has not completed. Check the team status and retry.',
            });
          }
        }, 120_000)
      : null;
    return () => {
      alive = false;
      if (timer !== null) clearInterval(timer);
      if (timeout !== null) clearTimeout(timeout);
    };
  }, [isActive, state, awaitingReadyKey, key, refresh]);

  const context = result?.key === key ? result.context : undefined;
  const error = result?.key === key ? result.error : undefined;
  const redirectTeam = context?.state === 'redirect' ? context.logicalTeamName : null;
  const redirectProject = context?.state === 'redirect' ? context.projectPath : null;
  useEffect(() => {
    if (!isActive || !redirectTeam || !redirectProject) return;
    // A deep link may still use the physical alias. Navigate through its
    // verified owner; never mount the alias as an independent team editor.
    useStore.getState().openTeamTab(redirectTeam, redirectProject);
  }, [isActive, redirectTeam, redirectProject]);

  const start = useCallback(async (): Promise<void> => {
    if (!selectedProjectPath || launchingKey !== null) return;
    setLaunchingKey(key);
    setAwaitingReadyKey(key);
    launchRef.current = { key, runId: null };
    try {
      const outcome = await api.teams.launchTeam({ teamName, cwd: selectedProjectPath });
      if (launchRef.current?.key === key) launchRef.current.runId = outcome.runId;
      await refresh(() => activeKeyRef.current === key);
    } catch (reason) {
      if (activeKeyRef.current === key) {
        setAwaitingReadyKey((current) => current === key ? null : current);
        setResult({
          key,
          error: reason instanceof Error ? reason.message : String(reason),
        });
      }
      if (launchRef.current?.key === key) launchRef.current = null;
    } finally {
      setLaunchingKey((current) => current === key ? null : current);
    }
  }, [key, launchingKey, refresh, selectedProjectPath, teamName]);

  if (context?.state === 'ready') {
    if (context.mode === 'shared') {
      return (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="border-b border-border px-4 py-2">
            <TeamHistoryModePicker
              teamName={teamName} mode="shared"
              onChanged={() => refresh(() => activeKeyRef.current === key)}
            />
          </div>
          <div className="flex min-h-0 flex-1">
            <TeamDetailView teamName={teamName} isActive={isActive} isPaneFocused={isPaneFocused} />
          </div>
        </div>
      );
    }
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-2 text-xs text-text-muted">
          <span>{logicalDisplayName} · {selectedProjectPath}</span>
          <TeamHistoryModePicker
            teamName={teamName} mode="per_project"
            onChanged={() => refresh(() => activeKeyRef.current === key)}
          />
        </div>
        <div className="flex min-h-0 flex-1" data-team-name={context.executionTeamName}>
          <TeamDetailView
            key={context.workContextId}
            teamName={context.executionTeamName}
            logicalTeamName={teamName}
            teamDisplayName={logicalDisplayName}
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
    launchingKey === null &&
    awaitingReadyKey !== key &&
    !error &&
    (context?.state === 'empty' || context?.state === 'pending');

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {context && (
        <div className="border-b border-border px-4 py-2">
          <TeamHistoryModePicker
            teamName={teamName} mode={context.mode}
            onChanged={() => refresh(() => activeKeyRef.current === key)}
          />
        </div>
      )}
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
        <Button variant="outline" onClick={() => { void refresh(() => activeKeyRef.current === key); }}>
          {t('projectContextView.retry')}
        </Button>
      )}
      </div>
    </div>
  );
}
