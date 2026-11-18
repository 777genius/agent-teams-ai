import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useAppTranslation } from '@features/localization/renderer';
import { api } from '@renderer/api';
import { Button } from '@renderer/components/ui/button';
import { useStore } from '@renderer/store';
import { isTeamProvisioningActive } from '@renderer/store/slices/teamSlice';
import { redirectProjectAliasTaskNavigation } from '@renderer/store/team/projectAliasTaskNavigation';
import { registerVisiblePhysicalTeam } from '@renderer/store/team/teamViewVisibility';
import { useShallow } from 'zustand/react/shallow';

import { TeamDetailView } from './TeamDetailView';
import { TeamHistoryModePicker } from './TeamHistoryModePicker';
import { TeamProvisioningBanner } from './TeamProvisioningBanner';
import { findTeamProjectSelectionTarget, resolveTeamProjectSelection } from './teamProjectSelection';

import type { TeamProjectContextView } from '@features/team-project-context/contracts';
import type { TeamLaunchRequest } from '@shared/types';

interface Props {
  teamName: string;
  /** Route from an old shared task after this team was switched to per-project mode. */
  retainedSharedHistory?: boolean;
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
  retainedSharedHistory = false,
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
  const retainedOwner = context?.state === 'retained' ? context.logicalTeamName : null;
  useEffect(() => {
    if (!isActive || !retainedOwner) return;
    const state = useStore.getState();
    const current = state.getAllPaneTabs().find(
      (tab) => tab.id === state.activeTabId && tab.type === 'team' && tab.teamName === teamName
    );
    if (current) {
      state.updateTabLabel(
        current.id, `${retainedOwner} · ${t('projectContextView.retainedHistory')}`
      );
    }
  }, [isActive, retainedOwner, teamName, t]);
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
    if (!isActive || !redirectTeam || !redirectProject || !redirectProjectListed) return;
    // A deep link may still use the physical alias. Navigate through its
    // verified owner; never mount the alias as an independent team editor.
    redirectProjectAliasTaskNavigation(
      () => useStore.getState(), teamName, redirectTeam, redirectProject
    );
  }, [isActive, redirectTeam, redirectProject, redirectProjectListed, teamName]);

  const visiblePhysicalTeam =
    !isActive || context?.mode !== 'per_project'
      ? null
      : (context.state === 'ready' || context.state === 'retained')
        ? context.executionTeamName
        : (context.state === 'redirect' && !redirectProjectListed)
          ? teamName
          : null;
  useEffect(
    () => visiblePhysicalTeam ? registerVisiblePhysicalTeam(visiblePhysicalTeam) : undefined,
    [visiblePhysicalTeam]
  );

  const start = useCallback(async (request: TeamLaunchRequest): Promise<void> => {
    const cwd = request.cwd.trim();
    if (!cwd || launchingKey !== null) throw new Error('Choose a project before launch');
    const targetKey = `${teamName}\u0000${cwd}`;
    setLaunchingKey(targetKey);
    setAwaitingReadyKey(targetKey);
    launchRef.current = { key: targetKey, runId: null };
    try {
      const outcome = await api.teams.launchTeam({ ...request, teamName, cwd });
      if (launchRef.current?.key === targetKey) launchRef.current.runId = outcome.runId;
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

  if (retainedSharedHistory && context?.mode === 'per_project' &&
      context.state !== 'redirect' && context.state !== 'retained') {
    // The task identity still belongs to the pre-isolation physical team,
    // even though all NEW work now goes to a project-specific runtime.
    return (
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-2 text-xs text-text-muted">
          <span>{logicalDisplayName} · {t('projectContextView.retainedHistory')}</span>
          <Button size="sm" variant="outline" onClick={() => useStore.getState().openTeamTab(teamName)}>
            {t('projectContextView.openCurrent')}
          </Button>
        </div>
        <div className="flex min-h-0 min-w-0 flex-1" data-team-name={teamName}>
          <TeamDetailView
            teamName={teamName}
            logicalTeamName={teamName}
            retainedHistory
            isActive={isActive}
            isPaneFocused={isPaneFocused}
          />
        </div>
      </div>
    );
  }

  if (context?.state === 'redirect' && !redirectProjectListed) {
    // The verified physical alias remains readable even when the worktree
    // disappeared from project discovery. Do not dispatch new work to a
    // missing/unknown project or discard pending physical task navigation.
    return (
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div className="border-b border-border px-4 py-2 text-xs text-text-muted">
          {context.logicalTeamName} · {context.projectPath} · {t('projectContextView.retainedHistory')}
        </div>
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

  if (context?.state === 'retained') {
    // Only a backend-verified, owned historical alias can reach this branch.
    // The logical team's selected mode still controls all future launches.
    return (
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-2 text-xs text-text-muted">
          <span>
            {context.logicalTeamName} · {t('projectContextView.retainedHistory')} · {context.projectPath}
          </span>
          <Button
            size="sm"
            variant="outline"
            onClick={() => useStore.getState().openTeamTab(context.logicalTeamName)}
          >
            {t('projectContextView.openCurrent')}
          </Button>
        </div>
        <div className="flex min-h-0 min-w-0 flex-1" data-team-name={context.executionTeamName}>
          <TeamDetailView
            key={context.workContextId}
            teamName={context.executionTeamName}
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
    if (context.mode === 'shared') {
      return (
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <div className="border-b border-border px-4 py-2">
            <TeamHistoryModePicker
              teamName={teamName} mode="shared"
              onChanged={async () => {
                await useStore.getState().fetchTeams();
                await refresh(() => activeKeyRef.current === key);
              }}
            />
          </div>
          <div className="flex min-h-0 min-w-0 flex-1">
            <TeamDetailView teamName={teamName} isActive={isActive} isPaneFocused={isPaneFocused} />
          </div>
        </div>
      );
    }
    return (
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-2 text-xs text-text-muted">
          <span>{logicalDisplayName} · {selectedProjectPath}</span>
          <TeamHistoryModePicker
            teamName={teamName} mode="per_project"
            onChanged={async () => {
                await useStore.getState().fetchTeams();
                await refresh(() => activeKeyRef.current === key);
              }}
          />
        </div>
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
    !provisioningActive &&
    !error &&
    (context?.state === 'empty' || context?.state === 'pending');

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      {context && context.state !== 'redirect' && (
        <div className="border-b border-border px-4 py-2">
          <TeamHistoryModePicker
            teamName={teamName} mode={context.mode}
            onChanged={async () => {
                await useStore.getState().fetchTeams();
                await refresh(() => activeKeyRef.current === key);
              }}
          />
        </div>
      )}
      {context?.state === 'pending' && (
        <div className="px-4 pt-3">
          <TeamProvisioningBanner teamName={teamName} />
        </div>
      )}
      <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
      <h2 className="text-base font-semibold">{logicalDisplayName}</h2>
      {!(context?.state === 'pending' && provisioningError) && (
        <p className="max-w-lg text-sm text-text-muted" role={error ? 'alert' : 'status'}>
          {message}
        </p>
      )}
      {canStart && (
        <Button onClick={() => setLaunchDialogOpen(true)} disabled={launching}>
          {t('projectContextView.start')}
        </Button>
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
