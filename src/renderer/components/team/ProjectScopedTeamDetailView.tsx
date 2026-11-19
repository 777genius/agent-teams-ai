import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useAppTranslation } from '@features/localization/renderer';
import { api } from '@renderer/api';
import { Button } from '@renderer/components/ui/button';
import { useStore } from '@renderer/store';
import { isTeamProvisioningActive } from '@renderer/store/slices/teamSlice';
import { redirectProjectAliasTaskNavigation } from '@renderer/store/team/projectAliasTaskNavigation';
import {
  registerFocusedProjectTeam,
  registerVisiblePhysicalTeam,
} from '@renderer/store/team/teamViewVisibility';
import { useShallow } from 'zustand/react/shallow';

import { TeamDetailView } from './TeamDetailView';
import { findTeamProjectSelectionTarget, resolveTeamProjectSelection } from './teamProjectSelection';
import { TeamProvisioningBanner } from './TeamProvisioningBanner';

import type { TeamProjectContextView } from '@features/team-project-context/contracts';
import type { TeamLaunchRequest } from '@shared/types';

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
const LaunchTeamDialog = lazy(() =>
  import('./dialogs/LaunchTeamDialog').then((mod) => ({ default: mod.LaunchTeamDialog }))
);

/**
 * One visible logical-team tab. A ready, owner-verified native alias is passed
 * to the existing Tasks/Messages screen; nothing is copied or filtered by time.
 */
export const ProjectScopedTeamDetailView = ({
  teamName,
  isActive = true,
  isPaneFocused = true,
}: Readonly<Props>): React.JSX.Element => {
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
  // A launch can start in Create Team or Team List, before this view owns a launchRef.
  const provisioningActive = useStore((s) => isTeamProvisioningActive(s, teamName));
  const provisioningError = useStore((s) => s.provisioningErrorByTeam[teamName] ?? null);
  const selectedTeamName = useStore((s) => s.selectedTeamName);
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
  const [launchDialogOpen, setLaunchDialogOpen] = useState(false);
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
  // Deep links can outlive a deleted worktree. Never route their physical
  // task identity to whichever unrelated project the sidebar currently shows.
  const redirectProjectListed = useMemo(
    () => redirectProject
      ? findTeamProjectSelectionTarget(repositoryGroups, projects, redirectProject) !== null
      : false,
    [redirectProject, repositoryGroups, projects]
  );
  useEffect(() => {
    if (!isActive || !isPaneFocused || !redirectTeam ||
        !redirectProject || !redirectProjectListed) return;
    // A deep link may still use the physical alias. Navigate through its
    // verified owner; never mount the alias as an independent team editor.
    redirectProjectAliasTaskNavigation(
      () => useStore.getState(), teamName, redirectTeam, redirectProject
    );
  }, [isActive, isPaneFocused, redirectTeam, redirectProject, redirectProjectListed, teamName]);

  const visiblePhysicalTeam =
    !isActive || context?.mode !== 'per_project'
      ? null
      : context.state === 'ready'
        ? context.executionTeamName
        : (context.state === 'redirect' && !redirectProjectListed)
          ? teamName
          : null;
  useEffect(
    () => visiblePhysicalTeam ? registerVisiblePhysicalTeam(visiblePhysicalTeam) : undefined,
    [visiblePhysicalTeam]
  );

  // Register only the focused ready project; background tabs do not
  // constitute the viewed native notification owner.
  const focusedProjectTeamName =
    isActive && isPaneFocused &&
    context?.mode === 'per_project' && context.state === 'ready'
      ? context.executionTeamName
      : null;
  useEffect(
    () => focusedProjectTeamName
      ? registerFocusedProjectTeam(teamName, focusedProjectTeamName)
      : undefined,
    [focusedProjectTeamName, teamName]
  );

  // Activating an already-open logical tab can reselect the logical team.
  // Restore the verified physical runtime whenever that occurs while focused.
  const readyExecutionTeamName =
    context?.mode === 'per_project' && context.state === 'ready'
      ? context.executionTeamName
      : null;
  useEffect(() => {
    if (!isActive || !isPaneFocused || !readyExecutionTeamName ||
        selectedTeamName !== teamName) return;
    void useStore.getState().selectTeam(readyExecutionTeamName);
  }, [isActive, isPaneFocused, readyExecutionTeamName, selectedTeamName, teamName]);

  const start = useCallback(async (request: TeamLaunchRequest): Promise<void> => {
    const cwd = request.cwd.trim();
    if (!cwd || launchingKey !== null) throw new Error('Choose a project before launch');
    const targetKey = `${teamName}\u0000${cwd}`;
    setLaunchingKey(targetKey);
    setAwaitingReadyKey(targetKey);
    launchRef.current = { key: targetKey, runId: null };
    try {
      // The store owns successor-run adoption, optimistic status and polling.
      // Direct IPC would leave the previous project's logical run pinned.
      const runId = await useStore.getState().launchTeam({ ...request, teamName, cwd });
      if (launchRef.current?.key === targetKey) launchRef.current.runId = runId;
      if (activeKeyRef.current === targetKey) {
        await refresh(() => activeKeyRef.current === targetKey);
      }
    } catch (reason) {
      if (activeKeyRef.current === targetKey) {
        setAwaitingReadyKey((current) => current === targetKey ? null : current);
        setResult({
          key: targetKey,
          error: reason instanceof Error ? reason.message : String(reason),
        });
      }
      if (launchRef.current?.key === targetKey) launchRef.current = null;
      throw reason;
    } finally {
      setLaunchingKey((current) => current === targetKey ? null : current);
    }
  }, [launchingKey, refresh, teamName]);

  if (context?.state === 'redirect' && !redirectProjectListed) {
    // The verified physical alias remains readable even when the worktree
    // disappeared from project discovery. Do not dispatch new work to a
    // missing/unknown project or discard pending physical task navigation.
    return (
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <p role="status" className="border-b border-border px-4 py-2 text-xs text-text-muted">
          {t('projectContextView.projectMissing')}
        </p>
        <div className="flex min-h-0 min-w-0 flex-1" data-team-name={teamName}>
          <TeamDetailView
            teamName={teamName}
            logicalTeamName={context.logicalTeamName}
            teamDisplayName={context.logicalTeamName}
            retainedHistory
            isActive={isActive}
            isPaneFocused={isPaneFocused}
          />
        </div>
      </div>
    );
  }

  if (context?.state === 'ready') {
    // The history mode is fixed when the team is created, so a ready team shows
    // its normal screen with no mode control; the project is in the team header.
    if (context.mode === 'shared') {
      return (
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <div className="flex min-h-0 min-w-0 flex-1">
            <TeamDetailView teamName={teamName} isActive={isActive} isPaneFocused={isPaneFocused} />
          </div>
        </div>
      );
    }
    return (
      <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-team-name={teamName}>
        <div className="flex min-h-0 min-w-0 flex-1" data-team-name={context.executionTeamName}>
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

  const canStart =
    Boolean(selectedProjectPath) &&
    launchingKey === null &&
    awaitingReadyKey !== key &&
    !provisioningActive &&
    !error &&
    (context?.state === 'empty' || context?.state === 'pending');
  // Only invite to Launch when the button is really there, and say "in this
  // project": the team may already be running in another one.
  const showEmptyPrompt = canStart && context?.state === 'empty';

  let message = t('projectContextView.loading');
  if (error) message = error;
  else if (context?.state === 'needs_project') message = t('projectContextView.selectProject');
  else if (context?.state === 'empty') {
    message = showEmptyPrompt
      ? t('projectContextView.empty', { team: logicalDisplayName })
      : t('projectContextView.pending');
  }
  else if (context?.state === 'pending') message = t('projectContextView.pending');

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      {context?.state === 'pending' && (
        <div className="px-4 pt-3">
          <TeamProvisioningBanner teamName={teamName} />
        </div>
      )}
      <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
      <h2 className={showEmptyPrompt ? 'text-sm font-medium text-text' : 'text-base font-semibold'}>
        {showEmptyPrompt ? t('projectContextView.emptyTitle') : logicalDisplayName}
      </h2>
      {!(context?.state === 'pending' && provisioningError) && (
        <p className="max-w-md text-xs text-text-secondary" role={error ? 'alert' : 'status'}>
          {message}
        </p>
      )}
      {canStart && (
        <button
          type="button"
          className="mt-1 rounded-md bg-blue-600 px-4 py-1.5 text-xs font-medium text-white transition-colors hover:bg-blue-500 disabled:opacity-50"
          onClick={() => setLaunchDialogOpen(true)}
          disabled={launching}
        >
          {t('detail.actions.launch')}
        </button>
      )}
      {error && (
        <Button variant="outline" onClick={() => { void refresh(() => activeKeyRef.current === key); }}>
          {t('projectContextView.retry')}
        </Button>
      )}
      </div>
      {launchDialogOpen && selectedProjectPath && (
        <Suspense fallback={null}>
          <LaunchTeamDialog
            mode="launch"
            open
            teamName={teamName}
            members={[]}
            projectPermissionTeamName={null}
            defaultProjectPath={selectedProjectPath}
            provisioningError={error ?? null}
            onClose={() => setLaunchDialogOpen(false)}
            onLaunch={start}
          />
        </Suspense>
      )}
    </div>
  );
};
