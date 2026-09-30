import { lazy, memo, Suspense, useCallback, useEffect, useMemo, useState } from 'react';

import { useAppTranslation } from '@features/localization/renderer';
import { recordRecentProjectOpenPaths } from '@features/recent-projects/renderer';
import {
  resolveTeamDirectoryOpenIntent,
  TeamDirectoryQueryInput,
  TeamDirectoryRows,
} from '@features/team-directory/renderer';
import { classifyAnalyticsError, recordTeamStop } from '@renderer/analytics/productAnalytics';
import { api, isElectronMode } from '@renderer/api';
import { confirm } from '@renderer/components/common/ConfirmDialog';
import { Button } from '@renderer/components/ui/button';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@renderer/components/ui/tooltip';
import { getTeamColorSet } from '@renderer/constants/teamColors';
import { useBranchSync } from '@renderer/hooks/useBranchSync';
import { useTheme } from '@renderer/hooks/useTheme';
import { useStore } from '@renderer/store';
import { isTeamProvisioningActive } from '@renderer/store/slices/teamSlice';
import {
  getProjectSelectionResetState,
  getWorktreeNavigationState,
} from '@renderer/store/utils/stateResetHelpers';
import { buildTaskCountsByTeam, normalizePath } from '@renderer/utils/pathNormalize';
import { nameColorSet } from '@renderer/utils/projectColor';
import { Import, Network, Plus, RotateCcw, Search, Trash2 } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';

import { LaunchTeamDialogLoadingFallback } from './dialogs/LaunchTeamDialogLoadingFallback';
import { executeTeamRelaunch } from './dialogs/teamRelaunchFlow';
import { CreateTeamDialogLoadingFallback } from './CreateTeamDialogLoadingFallback';
import { ActiveTeamCard, DesktopTeamDirectoryMemberNames } from './DesktopTeamDirectoryCard';
import { buildDesktopTeamDirectoryView } from './desktopTeamDirectoryRows';
import { buildCopiedTeamMembers } from './teamCopyData';
import { showTeamDeleteError } from './teamDeleteErrorDialog';
import { TeamEmptyState } from './TeamEmptyState';
import { EMPTY_TEAM_FILTER, TeamListFilterPopover } from './TeamListFilterPopover';
import { formatTeamProjectPathName, resolveLaunchDialogMembers } from './teamListPresentation';
import {
  findTeamProjectSelectionTarget,
  resolveCreateTeamDefaultProjectPath,
  resolveTeamProjectSelection,
  resolveTeamsProjectNavigationPath,
  teamMatchesProjectSelection,
} from './teamProjectSelection';
import { useTeamRendererPorts } from './useTeamRendererPorts';
import { useTeamStopControl } from './useTeamStopControl';

import type { ActiveTeamRef, TeamCopyData } from './dialogs/CreateTeamDialog';
import type { TeamLaunchDialogMode } from './dialogs/LaunchTeamDialog';
import type { TeamListFilterState } from './TeamListFilterPopover';
import type { OrganizationPlacementSelection } from '@features/organizations/contracts';
import type { ResolvedTeamMember, TeamCreateRequest, TeamLaunchRequest } from '@shared/types';

const CreateTeamDialog = lazy(() =>
  import('./dialogs/CreateTeamDialog').then((m) => ({ default: m.CreateTeamDialog }))
);
const LaunchTeamDialog = lazy(() =>
  import('./dialogs/LaunchTeamDialog').then((m) => ({ default: m.LaunchTeamDialog }))
);
const ImportTeamDialog = lazy(() =>
  import('@features/team-import/renderer').then((m) => ({ default: m.ImportTeamDialog }))
);

const TEAM_SECTION_INITIAL_VISIBLE_COUNT = 24;
const TEAM_SECTION_PAGE_SIZE = 24;

function generateUniqueName(sourceName: string, existingNames: string[]): string {
  const base = sourceName.replace(/-\d+$/, '');
  const existing = new Set(existingNames);
  for (let i = 1; ; i++) {
    const candidate = `${base}-${i}`;
    if (!existing.has(candidate)) {
      return candidate;
    }
  }
}

export const TeamListView = memo(function TeamListView(): React.JSX.Element {
  const { isLight } = useTheme();
  const { t } = useAppTranslation('team');
  const { t: tCommon } = useAppTranslation('common');
  const electronMode = isElectronMode();
  const launchTeamFromStore = useCallback(
    (request: TeamLaunchRequest) => useStore.getState().launchTeam(request),
    []
  );
  const {
    read: productionTeamListReadPorts,
    lifecycle: productionTeamListLifecyclePorts,
    provisioning: productionTeamListProvisioningPorts,
    roster: productionTeamListRosterPorts,
    stopRunningTeam,
  } = useTeamRendererPorts(api, launchTeamFromStore);
  const teamStopControl = useTeamStopControl({
    stopRunningTeam,
  });
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [showImportDialog, setShowImportDialog] = useState(false);
  const [copyData, setCopyData] = useState<TeamCopyData | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [filter, setFilter] = useState<TeamListFilterState>(EMPTY_TEAM_FILTER);
  const [teamPriorityProjectPath, setTeamPriorityProjectPath] = useState<string | null>(null);
  const [aliveTeams, setAliveTeams] = useState<string[]>([]);
  const [aliveReadScopeKey, setAliveReadScopeKey] = useState<string | null>(null);
  const [teamSectionVisibleCountByKey, setTeamSectionVisibleCountByKey] = useState<
    Record<string, number>
  >({});
  const {
    teams,
    teamsLoading,
    teamsError,
    fetchTeams,
    openTab,
    openTeamTab,
    deleteTeam,
    restoreTeam,
    permanentlyDeleteTeam,
    projects,
    globalTasks,
    fetchAllTasks,
    repositoryGroups,
    selectedRepositoryId,
    selectedWorktreeId,
    selectedProjectId,
    activeProjectId,
    teamsProjectNavigationIntent,
    branchByPath,
  } = useStore(
    useShallow((s) => ({
      teams: s.teams,
      teamsLoading: s.teamsLoading,
      teamsError: s.teamsError,
      fetchTeams: s.fetchTeams,
      openTab: s.openTab,
      openTeamTab: s.openTeamTab,
      deleteTeam: s.deleteTeam,
      restoreTeam: s.restoreTeam,
      permanentlyDeleteTeam: s.permanentlyDeleteTeam,
      projects: s.projects,
      globalTasks: s.globalTasks,
      fetchAllTasks: s.fetchAllTasks,
      repositoryGroups: s.repositoryGroups,
      selectedRepositoryId: s.selectedRepositoryId,
      selectedWorktreeId: s.selectedWorktreeId,
      selectedProjectId: s.selectedProjectId,
      activeProjectId: s.activeProjectId,
      teamsProjectNavigationIntent: s.teamsProjectNavigationIntent,
      branchByPath: s.branchByPath,
    }))
  );
  const {
    connectionMode,
    activeContextId,
    createTeam,
    provisioningErrorByTeam,
    clearProvisioningError,
    provisioningRuns,
    provisioningSnapshotByTeam,
    currentProvisioningRunIdByTeam,
    leadActivityByTeam,
  } = useStore(
    useShallow((s) => ({
      connectionMode: s.connectionMode,
      activeContextId: s.activeContextId,
      createTeam: s.createTeam,
      provisioningErrorByTeam: s.provisioningErrorByTeam,
      clearProvisioningError: s.clearProvisioningError,
      provisioningRuns: s.provisioningRuns,
      provisioningSnapshotByTeam: s.provisioningSnapshotByTeam,
      currentProvisioningRunIdByTeam: s.currentProvisioningRunIdByTeam,
      leadActivityByTeam: s.leadActivityByTeam,
    }))
  );
  const canCreate = electronMode && connectionMode === 'local';
  const provisioningState = useMemo(
    () => ({ currentProvisioningRunIdByTeam, provisioningRuns }),
    [currentProvisioningRunIdByTeam, provisioningRuns]
  );

  /** Team names currently in active provisioning — prevents name conflicts in create dialog. */
  const provisioningTeamNames = useMemo(() => {
    return Object.keys(currentProvisioningRunIdByTeam).filter((teamName) =>
      isTeamProvisioningActive(provisioningState, teamName)
    );
  }, [currentProvisioningRunIdByTeam, provisioningState]);

  /** Merge real teams with synthetic launching cards for active provisioning. */
  const teamsWithProvisioning = useMemo(() => {
    const existingNames = new Set(teams.map((t) => t.teamName));
    const synthetic = provisioningTeamNames
      .filter((name) => !existingNames.has(name) && provisioningSnapshotByTeam[name])
      .map((name) => provisioningSnapshotByTeam[name]);
    return synthetic.length > 0 ? [...teams, ...synthetic] : teams;
  }, [teams, provisioningTeamNames, provisioningSnapshotByTeam]);

  const fetchAliveTeams = useCallback(async (): Promise<string[] | null> => {
    if (!electronMode) return null;
    try {
      return await productionTeamListLifecyclePorts.listAliveTeams();
    } catch {
      return null;
    }
  }, [electronMode, productionTeamListLifecyclePorts]);

  // Fetch alive teams on mount and when teams list changes.
  useEffect(() => {
    let cancelled = false;
    void fetchAliveTeams().then((list) => {
      if (cancelled || useStore.getState().activeContextId !== activeContextId) return;
      if (list) {
        setAliveTeams(list);
        setAliveReadScopeKey(activeContextId);
      } else {
        // Failed refresh leaves the team list intact, but runtime state is unknown.
        setAliveReadScopeKey(null);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [activeContextId, fetchAliveTeams, teams]);

  const readyProgressRefreshKey = useMemo(() => {
    return Object.entries(currentProvisioningRunIdByTeam)
      .map(([teamName, runId]) => {
        if (!runId) return null;
        const progress = provisioningRuns[runId];
        return progress?.state === 'ready'
          ? `${teamName}:${progress.runId}:${progress.updatedAt}`
          : null;
      })
      .filter((item): item is string => Boolean(item))
      .join('|');
  }, [currentProvisioningRunIdByTeam, provisioningRuns]);

  // Terminal launch progress can arrive before aliveList catches up.
  useEffect(() => {
    if (!readyProgressRefreshKey) return;
    let cancelled = false;
    void fetchAliveTeams().then((list) => {
      if (cancelled || useStore.getState().activeContextId !== activeContextId) return;
      if (list) {
        setAliveTeams(list);
        setAliveReadScopeKey(activeContextId);
      } else {
        // Failed refresh leaves the team list intact, but runtime state is unknown.
        setAliveReadScopeKey(null);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [activeContextId, fetchAliveTeams, readyProgressRefreshKey]);

  // Refresh alive teams when opening the create dialog so conflict warning is accurate.
  useEffect(() => {
    if (!electronMode || !showCreateDialog) return;
    let cancelled = false;
    void fetchAliveTeams().then((list) => {
      if (cancelled || useStore.getState().activeContextId !== activeContextId) return;
      if (list) {
        setAliveTeams(list);
        setAliveReadScopeKey(activeContextId);
      } else {
        // Failed refresh leaves the team list intact, but runtime state is unknown.
        setAliveReadScopeKey(null);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [activeContextId, electronMode, fetchAliveTeams, showCreateDialog]);

  const currentProjectSelection = useMemo(
    () =>
      resolveTeamProjectSelection({
        repositoryGroups,
        projects,
        selectedRepositoryId,
        selectedWorktreeId,
        selectedProjectId,
        activeProjectId,
      }),
    [
      repositoryGroups,
      projects,
      selectedRepositoryId,
      selectedWorktreeId,
      selectedProjectId,
      activeProjectId,
    ]
  );
  const navigationProjectPath = resolveTeamsProjectNavigationPath(
    teamsProjectNavigationIntent,
    selectedProjectId
  );
  const selectedProjectPath = navigationProjectPath ?? currentProjectSelection.projectPath;
  const currentProjectPath = teamPriorityProjectPath ?? selectedProjectPath;
  const createTeamDefaultProjectPath = resolveCreateTeamDefaultProjectPath({
    initialProjectPath: copyData?.cwd,
    selectedProjectPath,
    priorityProjectPath: teamPriorityProjectPath,
  });

  const directoryView = useMemo(
    () =>
      buildDesktopTeamDirectoryView({
        teams: teamsWithProvisioning,
        scopeKey: activeContextId,
        aliveTeams: aliveReadScopeKey === activeContextId ? aliveTeams : [],
        aliveReadKnown: aliveReadScopeKey === activeContextId,
        provisioningState,
        leadActivityByTeam,
        currentProjectPath,
        filter: {
          query: searchQuery,
          selectedStatuses: filter.selectedStatuses,
        },
        nowMs: Date.now(),
      }),
    [
      teamsWithProvisioning,
      activeContextId,
      aliveTeams,
      aliveReadScopeKey,
      provisioningState,
      leadActivityByTeam,
      currentProjectPath,
      searchQuery,
      filter,
    ]
  );
  const filteredTeams = directoryView.teams;
  const statusByName = directoryView.statusByName;
  const openDirectoryTeam = useCallback(
    (teamName: string, projectPath?: string): void => {
      const currentState = useStore.getState();
      const currentScopeKey = currentState.activeContextId;
      const row = resolveTeamDirectoryOpenIntent(
        { scopeKey: activeContextId, targetKey: teamName, readEpoch: 0 },
        { scopeKey: currentScopeKey, readEpoch: 0, rows: directoryView.rows }
      );
      const stillPresent =
        currentState.teams.some((team) => team.teamName === teamName) ||
        Boolean(currentState.provisioningSnapshotByTeam[teamName]);
      if (row && stillPresent) openTeamTab(teamName, projectPath);
    },
    [activeContextId, directoryView.rows, openTeamTab]
  );

  const handleProjectSelectionChange = useCallback(
    (projectPath: string | null): void => {
      useStore.setState({ teamsProjectNavigationIntent: null });
      if (!projectPath) {
        setTeamPriorityProjectPath(null);
        useStore.setState(getProjectSelectionResetState());
        return;
      }

      setTeamPriorityProjectPath(projectPath);
      const target = findTeamProjectSelectionTarget(repositoryGroups, projects, projectPath);
      if (!target) {
        return;
      }

      if (target.kind === 'grouped') {
        useStore.setState(getWorktreeNavigationState(target.repositoryId, target.worktreeId));
        void useStore.getState().fetchSessionsInitial(target.worktreeId);
        recordRecentProjectOpenPaths([projectPath]);
        return;
      }

      useStore.getState().selectProject(target.projectId);
      recordRecentProjectOpenPaths([projectPath]);
    },
    [projects, repositoryGroups]
  );

  // Fetch branches once for all visible team project paths (no live polling)
  const teamPaths = useMemo(
    () => filteredTeams.map((t) => t.projectPath?.trim()).filter(Boolean) as string[],
    [filteredTeams]
  );
  useBranchSync(teamPaths, { live: false });

  const handleDeleteTeam = useCallback(
    (teamName: string, isDraft: boolean, e: React.MouseEvent) => {
      e.stopPropagation();
      void (async () => {
        if (isDraft) {
          const confirmed = await confirm({
            title: t('list.deleteDraft.title'),
            message: t('list.deleteDraft.message', { teamName }),
            confirmLabel: t('list.deleteDraft.confirmLabel'),
            cancelLabel: t('list.deleteDraft.cancelLabel'),
            variant: 'danger',
          });
          if (confirmed) {
            void productionTeamListProvisioningPorts.deleteDraft(teamName).catch(() => {});
          }
          return;
        }
        const confirmed = await confirm({
          title: t('list.moveToTrash.title'),
          message: t('list.moveToTrash.message', { teamName }),
          confirmLabel: t('list.moveToTrash.confirmLabel'),
          cancelLabel: t('list.moveToTrash.cancelLabel'),
          variant: 'danger',
        });
        if (confirmed) {
          await deleteTeam(teamName).catch((error: unknown) => showTeamDeleteError(t, error));
        }
      })();
    },
    [deleteTeam, productionTeamListProvisioningPorts, t]
  );

  const handleRestoreTeam = useCallback(
    (teamName: string, e: React.MouseEvent) => {
      e.stopPropagation();
      void (async () => {
        try {
          await restoreTeam(teamName);
        } catch {
          // error via store
        }
      })();
    },
    [restoreTeam]
  );

  const handlePermanentlyDeleteTeam = useCallback(
    (teamName: string, e: React.MouseEvent) => {
      e.stopPropagation();
      void (async () => {
        const confirmed = await confirm({
          title: t('list.deleteForever.title'),
          message: t('list.deleteForever.message', { teamName }),
          confirmLabel: t('list.deleteForever.confirmLabel'),
          cancelLabel: t('list.deleteForever.cancelLabel'),
          variant: 'danger',
        });
        if (confirmed) {
          await permanentlyDeleteTeam(teamName).catch((error: unknown) =>
            showTeamDeleteError(t, error)
          );
        }
      })();
    },
    [permanentlyDeleteTeam, t]
  );

  const handleCopyTeam = useCallback(
    (teamName: string, e: React.MouseEvent) => {
      e.stopPropagation();
      void (async () => {
        try {
          const existingNames = teams.map((t) => t.teamName);
          const uniqueName = generateUniqueName(teamName, existingNames);
          const savedRequest = await productionTeamListProvisioningPorts
            .readDraft(teamName)
            .catch(() => null);
          if (savedRequest) {
            setCopyData({
              teamName: uniqueName,
              description: savedRequest.description,
              color: savedRequest.color,
              cwd: savedRequest.cwd,
              prompt: savedRequest.prompt,
              providerId: savedRequest.providerId,
              model: savedRequest.model,
              effort: savedRequest.effort,
              fastMode: savedRequest.fastMode,
              syncModelsWithLead: savedRequest.syncModelsWithLead,
              limitContext: savedRequest.limitContext,
              skipPermissions: savedRequest.skipPermissions,
              members: buildCopiedTeamMembers(savedRequest.members),
            });
            setShowCreateDialog(true);
            return;
          }

          const data = await productionTeamListReadPorts.readTeamData(teamName, {
            includeMemberBranches: false,
          });
          setCopyData({
            teamName: uniqueName,
            description: data.config.description,
            color: data.config.color,
            cwd: data.config.projectPath,
            members: buildCopiedTeamMembers(data.config.members, data.members),
          });
          setShowCreateDialog(true);
        } catch {
          // silently ignore — team data may be unavailable
        }
      })();
    },
    [productionTeamListProvisioningPorts, productionTeamListReadPorts, teams]
  );

  const handleStopTeam = useCallback(
    async (teamName: string, e: React.MouseEvent) => {
      e.stopPropagation();
      await teamStopControl.stopTeam(teamName, {
        refresh: async () => {
          const list = await fetchAliveTeams();
          if (list) setAliveTeams(list);
        },
        onOutcome: (outcome, error) => {
          const success = outcome === 'stopped' || outcome === 'stopped_after_transport_error';
          recordTeamStop({
            source: 'list',
            success,
            runtimeActive: true,
            errorClass: success ? 'none' : classifyAnalyticsError(error),
          });
          if (success) setAliveTeams((prev) => prev.filter((name) => name !== teamName));
        },
      });
    },
    [fetchAliveTeams, teamStopControl]
  );

  const [launchingTeamName, setLaunchingTeamName] = useState<string | null>(null);
  const [launchDialogOpen, setLaunchDialogOpen] = useState(false);
  const [launchDialogMode, setLaunchDialogMode] = useState<TeamLaunchDialogMode>('launch');
  const [launchDialogTeamName, setLaunchDialogTeamName] = useState('');
  const [launchDialogMembers, setLaunchDialogMembers] = useState<ResolvedTeamMember[]>([]);
  const [launchDialogDefaultPath, setLaunchDialogDefaultPath] = useState<string | undefined>();

  const handleLaunchTeam = useCallback(
    async (
      teamName: string,
      projectPath: string | undefined,
      mode: TeamLaunchDialogMode,
      e: React.MouseEvent
    ) => {
      e.stopPropagation();
      if (!projectPath) return;
      try {
        const data = await productionTeamListReadPorts.readTeamData(teamName, {
          includeMemberBranches: false,
        });
        setLaunchDialogMode(mode);
        setLaunchDialogTeamName(teamName);
        setLaunchDialogMembers(resolveLaunchDialogMembers(data.members ?? []));
        setLaunchDialogDefaultPath(data.config.projectPath ?? projectPath);
        setLaunchDialogOpen(true);
      } catch (err) {
        // Draft teams (no config.json) throw TEAM_DRAFT — expected, use fallback
        if (!(err instanceof Error && err.message.includes('TEAM_DRAFT'))) {
          console.error('Failed to load team data for launch dialog:', err);
        }
        // Fallback: open dialog with minimal data
        setLaunchDialogMode(mode);
        setLaunchDialogTeamName(teamName);
        setLaunchDialogMembers([]);
        setLaunchDialogDefaultPath(projectPath);
        setLaunchDialogOpen(true);
      }
    },
    [productionTeamListReadPorts]
  );

  const handleLaunchSubmit = useCallback(
    async (request: TeamLaunchRequest) => {
      setLaunchingTeamName(request.teamName);
      try {
        await productionTeamListProvisioningPorts.launchTeam(request);
      } catch (err) {
        console.error('Failed to launch team:', err);
        throw err;
      } finally {
        setLaunchingTeamName(null);
      }
    },
    [productionTeamListProvisioningPorts]
  );

  const handleRelaunchSubmit = useCallback(
    async (request: TeamLaunchRequest, members: TeamCreateRequest['members']) => {
      setLaunchingTeamName(request.teamName);
      try {
        await executeTeamRelaunch({
          teamName: request.teamName,
          isTeamAlive: true,
          request,
          members,
          stopTeam: async (nextTeamName) => {
            try {
              await productionTeamListLifecyclePorts.stopRunningTeam(nextTeamName);
              recordTeamStop({
                source: 'relaunch',
                success: true,
                runtimeActive: true,
                errorClass: 'none',
              });
            } catch (error) {
              recordTeamStop({
                source: 'relaunch',
                success: false,
                runtimeActive: true,
                errorClass: classifyAnalyticsError(error),
              });
              throw error;
            }
          },
          replaceMembers: (nextTeamName, nextRequest) =>
            productionTeamListRosterPorts.replaceRoster(nextTeamName, nextRequest),
          launchTeam: productionTeamListProvisioningPorts.launchTeam,
        });
      } catch (err) {
        console.error('Failed to relaunch team:', err);
        throw err;
      } finally {
        setLaunchingTeamName(null);
      }
    },
    [
      productionTeamListLifecyclePorts,
      productionTeamListProvisioningPorts,
      productionTeamListRosterPorts,
    ]
  );

  useEffect(() => {
    if (!electronMode) {
      return;
    }
    void fetchTeams();
    void fetchAllTasks();
  }, [electronMode, fetchTeams, fetchAllTasks]);

  const taskCountsByTeam = useMemo(() => buildTaskCountsByTeam(globalTasks), [globalTasks]);

  const activeTeams = useMemo<ActiveTeamRef[]>(() => {
    const aliveSet = new Set(aliveTeams);
    return teams
      .filter((t) => aliveSet.has(t.teamName) && t.projectPath)
      .map((t) => ({
        teamName: t.teamName,
        displayName: t.displayName,
        projectPath: t.projectPath!,
      }));
  }, [teams, aliveTeams]);

  const handleCreateDialogClose = useCallback(() => {
    setShowCreateDialog(false);
    setCopyData(null);
  }, []);

  const handleCreateSubmit = useCallback(
    async (request: TeamCreateRequest, placement?: OrganizationPlacementSelection) => {
      await createTeam(request);
      if (placement) {
        try {
          await api.organizations.assignTeamToUnit({
            ...placement,
            teamName: request.teamName,
            label: request.displayName || request.teamName,
          });
        } catch (error) {
          console.warn('[Organizations] Failed to place created team in organization', error);
        }
      }
    },
    [createTeam]
  );

  if (!electronMode) {
    return (
      <div className="flex size-full items-center justify-center p-6">
        <div className="max-w-md text-center">
          <p className="text-sm font-medium text-[var(--color-text)]">
            {t('list.electronOnly.title')}
          </p>
          <p className="mt-2 text-xs text-[var(--color-text-muted)]">
            {t('list.electronOnly.description')}
          </p>
        </div>
      </div>
    );
  }

  const createDialogElement = showCreateDialog && (
    <Suspense
      fallback={
        <CreateTeamDialogLoadingFallback
          isCopy={copyData != null}
          onClose={handleCreateDialogClose}
        />
      }
    >
      <CreateTeamDialog
        open={showCreateDialog}
        canCreate={canCreate}
        provisioningErrorsByTeam={provisioningErrorByTeam}
        clearProvisioningError={clearProvisioningError}
        existingTeamNames={teams.map((t) => t.teamName)}
        provisioningTeamNames={provisioningTeamNames}
        activeTeams={activeTeams}
        initialData={copyData ?? undefined}
        defaultProjectPath={createTeamDefaultProjectPath}
        forceDefaultProjectSelection={copyData == null && navigationProjectPath != null}
        onClose={handleCreateDialogClose}
        onCreate={handleCreateSubmit}
        onOpenTeam={openTeamTab}
      />
    </Suspense>
  );

  const importDialogElement = showImportDialog && (
    <Suspense
      fallback={
        <div className="flex items-center justify-center p-6 text-sm text-text-muted" role="status">
          {tCommon('states.loading')}
        </div>
      }
    >
      <ImportTeamDialog
        open={showImportDialog}
        onClose={() => setShowImportDialog(false)}
        onImported={() => {
          setShowImportDialog(false);
          void fetchTeams();
        }}
      />
    </Suspense>
  );

  const launchDialogElement = launchDialogOpen && (
    <Suspense
      fallback={
        <LaunchTeamDialogLoadingFallback
          mode={launchDialogMode}
          teamName={launchDialogTeamName}
          onClose={() => setLaunchDialogOpen(false)}
        />
      }
    >
      {launchDialogMode === 'relaunch' ? (
        <LaunchTeamDialog
          mode="relaunch"
          open={launchDialogOpen}
          teamName={launchDialogTeamName}
          members={launchDialogMembers}
          defaultProjectPath={launchDialogDefaultPath}
          provisioningError={provisioningErrorByTeam[launchDialogTeamName] ?? null}
          clearProvisioningError={clearProvisioningError}
          activeTeams={activeTeams}
          onClose={() => setLaunchDialogOpen(false)}
          onRelaunch={handleRelaunchSubmit}
        />
      ) : (
        <LaunchTeamDialog
          mode="launch"
          open={launchDialogOpen}
          teamName={launchDialogTeamName}
          members={launchDialogMembers}
          defaultProjectPath={launchDialogDefaultPath}
          provisioningError={provisioningErrorByTeam[launchDialogTeamName] ?? null}
          clearProvisioningError={clearProvisioningError}
          activeTeams={activeTeams}
          onClose={() => setLaunchDialogOpen(false)}
          onLaunch={handleLaunchSubmit}
        />
      )}
    </Suspense>
  );

  const renderHeader = (): React.JSX.Element => (
    <div className="mb-4">
      <div className="flex items-center justify-between">
        <h2 className="text-base font-semibold text-[var(--color-text)]">{t('list.title')}</h2>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            className="gap-1.5"
            onClick={() =>
              openTab({ type: 'organizations', label: t('organizations.map.defaultTitle') })
            }
          >
            <Network size={13} />
            {t('list.actions.organizationMap')}
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="gap-1.5"
            disabled={!canCreate}
            onClick={() => setShowImportDialog(true)}
          >
            <Import size={13} />
            {t('list.actions.importTeam')}
          </Button>
          <Button className="gap-2" disabled={!canCreate} onClick={() => setShowCreateDialog(true)}>
            <Plus size={15} />
            {t('list.actions.createTeam')}
          </Button>
        </div>
      </div>
      {!canCreate ? (
        <p className="mt-2 text-xs text-[var(--color-text-muted)]">{t('list.localOnly')}</p>
      ) : null}

      {teamsWithProvisioning.length > 0 ? (
        <div className="mt-3 flex items-center gap-2">
          <div className="relative flex-1">
            <Search
              size={14}
              className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--color-text-muted)]"
            />
            <TeamDirectoryQueryInput
              label={t('list.searchPlaceholder')}
              query={searchQuery}
              onQueryChange={setSearchQuery}
              className="h-8 pl-8 text-xs"
            />
          </div>
          <TeamListFilterPopover
            filter={filter}
            selectedProjectPath={currentProjectPath}
            teams={teamsWithProvisioning}
            aliveTeams={aliveReadScopeKey === activeContextId ? aliveTeams : []}
            aliveReadKnown={aliveReadScopeKey === activeContextId}
            onFilterChange={setFilter}
            onProjectChange={handleProjectSelectionChange}
          />
        </div>
      ) : null}
    </div>
  );

  const renderContent = (): React.JSX.Element => {
    if (teamsLoading) {
      return (
        <div className="flex size-full items-center justify-center text-sm text-[var(--color-text-muted)]">
          {t('list.loading')}
        </div>
      );
    }

    if (teamsError) {
      return (
        <div className="flex size-full items-center justify-center p-6">
          <div className="text-center">
            <p className="text-sm font-medium text-red-400">{t('list.loadFailed')}</p>
            <p className="mt-2 text-xs text-[var(--color-text-muted)]">{teamsError}</p>
            <Button
              variant="outline"
              size="sm"
              className="mt-4"
              onClick={() => {
                void fetchTeams();
              }}
            >
              {t('list.actions.retry')}
            </Button>
          </div>
        </div>
      );
    }

    if (teamsWithProvisioning.length === 0) {
      return (
        <TeamEmptyState
          canCreate={canCreate}
          onCreateTeam={() => setShowCreateDialog(true)}
          onImportTeam={() => setShowImportDialog(true)}
        />
      );
    }

    const hasActiveFilters = filter.selectedStatuses.size > 0;
    if (filteredTeams.length === 0 && (searchQuery.trim() || hasActiveFilters)) {
      return (
        <div className="flex items-center justify-center py-12 text-sm text-[var(--color-text-muted)]">
          {t('list.noMatches')}
        </div>
      );
    }

    const activeFiltered = filteredTeams.filter((t) => !t.deletedAt);
    const deletedFiltered = filteredTeams.filter((t) => t.deletedAt);
    const shouldPageTeamSections = !searchQuery.trim() && !hasActiveFilters;
    const selectedProjectSectionKey = currentProjectPath
      ? `project:${normalizePath(currentProjectPath)}`
      : 'project';
    const otherTeamsSectionKey = currentProjectPath
      ? `other:${normalizePath(currentProjectPath)}`
      : 'other';
    const activeSections = currentProjectPath
      ? [
          {
            key: selectedProjectSectionKey,
            title: t('list.sections.projectTeams', {
              project:
                formatTeamProjectPathName(currentProjectPath) || t('list.sections.selectedProject'),
            }),
            teams: activeFiltered.filter((team) =>
              teamMatchesProjectSelection(team, currentProjectPath)
            ),
          },
          {
            key: otherTeamsSectionKey,
            title: t('list.sections.otherTeams'),
            teams: activeFiltered.filter(
              (team) => !teamMatchesProjectSelection(team, currentProjectPath)
            ),
          },
        ].filter((section) => section.teams.length > 0)
      : [
          {
            key: 'all',
            title: null,
            teams: activeFiltered,
          },
        ];

    return (
      <>
        {activeSections.map((section, sectionIndex) => (
          <section key={section.key} className={sectionIndex > 0 ? 'mt-6' : undefined}>
            {(() => {
              const paged =
                shouldPageTeamSections && section.teams.length > TEAM_SECTION_INITIAL_VISIBLE_COUNT;
              const requestedVisibleCount =
                teamSectionVisibleCountByKey[section.key] ?? TEAM_SECTION_INITIAL_VISIBLE_COUNT;
              const visibleCount = paged
                ? Math.min(section.teams.length, requestedVisibleCount)
                : section.teams.length;
              const visibleTeams = section.teams.slice(0, visibleCount);
              const canShowMore = paged && visibleCount < section.teams.length;
              const canShowLess = paged && visibleCount > TEAM_SECTION_INITIAL_VISIBLE_COUNT;

              return (
                <>
                  {section.title ? (
                    <div className="mb-2 flex items-center gap-2">
                      <h3 className="text-[11px] font-medium uppercase tracking-wider text-[var(--color-text-muted)]">
                        {section.title}
                      </h3>
                      <span className="rounded-full border border-[var(--color-border)] bg-[var(--color-surface-overlay)] px-1.5 py-0.5 text-[10px] font-medium leading-none text-[var(--color-text-secondary)]">
                        {section.teams.length}
                      </span>
                    </div>
                  ) : null}
                  <TeamDirectoryRows
                    as="div"
                    className="team-row-zebra-grid grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3"
                    rows={visibleTeams.flatMap((team) => {
                      const row = directoryView.rowByName.get(team.teamName);
                      return row ? [row] : [];
                    })}
                    renderRow={(row) => {
                      const team = directoryView.teamByName.get(row.teamName);
                      if (!team) return null;
                      const status = statusByName.get(team.teamName) ?? 'offline';
                      const teamColorSet = team.color
                        ? getTeamColorSet(team.color)
                        : nameColorSet(team.displayName);
                      const matchesCurrentProject = currentProjectPath
                        ? teamMatchesProjectSelection(team, currentProjectPath)
                        : false;
                      return (
                        <ActiveTeamCard
                          key={team.teamName}
                          team={team}
                          status={status}
                          runtimeUnknown={row.runtime === 'unknown'}
                          unknownLabel={tCommon('states.unknown')}
                          teamColorSet={teamColorSet}
                          isLight={isLight}
                          matchesCurrentProject={matchesCurrentProject}
                          currentProjectPath={currentProjectPath}
                          branchName={
                            team.projectPath
                              ? (branchByPath[normalizePath(team.projectPath)] ?? undefined)
                              : undefined
                          }
                          taskCounts={taskCountsByTeam.get(team.teamName)}
                          launchingTeamName={launchingTeamName}
                          isStopping={teamStopControl.isStopping(team.teamName)}
                          onOpenTeam={openDirectoryTeam}
                          onLaunchTeam={handleLaunchTeam}
                          onStopTeam={handleStopTeam}
                          onCopyTeam={handleCopyTeam}
                          onDeleteTeam={handleDeleteTeam}
                          t={t}
                        />
                      );
                    }}
                  />
                  {(canShowMore || canShowLess) && (
                    <div className="mt-3 flex items-center justify-center gap-3">
                      {canShowMore ? (
                        <button
                          type="button"
                          className="rounded px-2.5 py-1 text-xs font-medium text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-surface-raised)] hover:text-[var(--color-text)]"
                          onClick={() =>
                            setTeamSectionVisibleCountByKey((prev) => ({
                              ...prev,
                              [section.key]: Math.min(
                                section.teams.length,
                                visibleCount + TEAM_SECTION_PAGE_SIZE
                              ),
                            }))
                          }
                        >
                          {tCommon('actions.showMore')}
                        </button>
                      ) : null}
                      {canShowLess ? (
                        <button
                          type="button"
                          className="rounded px-2.5 py-1 text-xs text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-surface-raised)] hover:text-[var(--color-text)]"
                          onClick={() =>
                            setTeamSectionVisibleCountByKey((prev) => ({
                              ...prev,
                              [section.key]: Math.max(
                                TEAM_SECTION_INITIAL_VISIBLE_COUNT,
                                visibleCount - TEAM_SECTION_PAGE_SIZE
                              ),
                            }))
                          }
                        >
                          {tCommon('actions.showLess')}
                        </button>
                      ) : null}
                    </div>
                  )}
                </>
              );
            })()}
          </section>
        ))}

        {deletedFiltered.length > 0 && (
          <>
            <div className="my-6 flex items-center gap-3">
              <div className="h-px flex-1 bg-[var(--color-border)]" />
              <span className="text-[10px] font-medium uppercase tracking-wider text-[var(--color-text-muted)]">
                {t('list.trash', { count: deletedFiltered.length })}
              </span>
              <div className="h-px flex-1 bg-[var(--color-border)]" />
            </div>
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
              {deletedFiltered.map((team) => (
                <div
                  key={team.teamName}
                  className="group relative cursor-default overflow-hidden rounded-lg border border-[var(--color-border)] bg-zinc-800/40 p-4 opacity-60"
                >
                  <Trash2
                    size={64}
                    className="pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 text-zinc-400 opacity-[0.06]"
                  />
                  <div className="relative z-10">
                    <div className="flex items-start justify-between">
                      <div className="flex min-w-0 flex-1 items-center gap-2">
                        <h3 className="truncate text-sm font-semibold text-[var(--color-text)]">
                          {team.displayName}
                        </h3>
                        <span className="inline-flex items-center gap-1 rounded-full bg-zinc-500/15 px-2 py-0.5 text-[10px] font-medium text-zinc-500">
                          {t('list.status.deleted')}
                        </span>
                      </div>
                      <div className="flex shrink-0 gap-1">
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <button
                              type="button"
                              className="shrink-0 rounded p-1 text-[var(--color-text-muted)] opacity-0 transition-opacity hover:bg-emerald-500/10 hover:text-emerald-300 group-hover:opacity-100"
                              onClick={(e) => handleRestoreTeam(team.teamName, e)}
                              aria-label={t('list.actions.restoreTeam')}
                            >
                              <RotateCcw size={14} />
                            </button>
                          </TooltipTrigger>
                          <TooltipContent side="bottom">{t('list.actions.restore')}</TooltipContent>
                        </Tooltip>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <button
                              type="button"
                              className="shrink-0 rounded p-1 text-[var(--color-text-muted)] opacity-0 transition-opacity hover:bg-red-500/10 hover:text-red-300 group-hover:opacity-100"
                              onClick={(e) => handlePermanentlyDeleteTeam(team.teamName, e)}
                              aria-label={t('list.actions.deletePermanently')}
                            >
                              <Trash2 size={14} />
                            </button>
                          </TooltipTrigger>
                          <TooltipContent side="bottom">
                            {t('list.actions.deleteForever')}
                          </TooltipContent>
                        </Tooltip>
                      </div>
                    </div>
                    <p className="mt-2 line-clamp-2 text-xs text-[var(--color-text-muted)]">
                      {team.description || t('list.noDescription')}
                    </p>
                    {team.members && team.members.length > 0 && (
                      <div className="mt-3 flex flex-wrap items-center gap-x-6 gap-y-2">
                        {<DesktopTeamDirectoryMemberNames members={team.members} />}
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
      </>
    );
  };

  return (
    <TooltipProvider delayDuration={300}>
      <div className="size-full overflow-auto p-4">
        {renderHeader()}
        {renderContent()}
        {createDialogElement}
        {importDialogElement}
        {launchDialogElement}
      </div>
    </TooltipProvider>
  );
});
