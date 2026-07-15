import { lazy, memo, Suspense, useCallback, useEffect, useMemo, useState } from 'react';

import { useAppTranslation } from '@features/localization/renderer';
import { recordRecentProjectOpenPaths } from '@features/recent-projects/renderer';
import { api, isElectronMode } from '@renderer/api';
import { confirm } from '@renderer/components/common/ConfirmDialog';
import { Badge } from '@renderer/components/ui/badge';
import { Button } from '@renderer/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@renderer/components/ui/dialog';
import { Input } from '@renderer/components/ui/input';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@renderer/components/ui/tooltip';
import {
  getTeamColorSet,
  getThemedBorder,
  type TeamColorSet,
} from '@renderer/constants/teamColors';
import { useBranchSync } from '@renderer/hooks/useBranchSync';
import { useTheme } from '@renderer/hooks/useTheme';
import { useStore } from '@renderer/store';
import {
  getCurrentProvisioningProgressForTeam,
  isTeamProvisioningActive,
} from '@renderer/store/slices/teamSlice';
import {
  getProjectSelectionResetState,
  getWorktreeNavigationState,
} from '@renderer/store/utils/stateResetHelpers';
import { buildMemberColorMap } from '@renderer/utils/memberHelpers';
import {
  buildTaskCountsByTeam,
  normalizePath,
  type TaskStatusCounts,
} from '@renderer/utils/pathNormalize';
import { getBaseName } from '@renderer/utils/pathUtils';
import { nameColorSet } from '@renderer/utils/projectColor';
import { buildPendingRuntimeSummaryCopy } from '@renderer/utils/teamLaunchSummaryCopy';
import { isTeamListStatusRunning, resolveTeamStatus } from '@renderer/utils/teamListStatus';
import {
  Copy,
  FolderOpen,
  GitBranch,
  Loader2,
  Network,
  Play,
  Plus,
  RotateCcw,
  Search,
  Square,
  Trash2,
  UsersRound,
} from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';

import { LaunchTeamDialogLoadingFallback } from './dialogs/LaunchTeamDialogLoadingFallback';
import { executeTeamRelaunch } from './dialogs/teamRelaunchFlow';
import { buildCopiedTeamMembers } from './teamCopyData';
import { TeamEmptyState } from './TeamEmptyState';
import { EMPTY_TEAM_FILTER, TeamListFilterPopover } from './TeamListFilterPopover';
import {
  findTeamProjectSelectionTarget,
  resolveCreateTeamDefaultProjectPath,
  resolveTeamProjectSelection,
  teamMatchesProjectSelection,
} from './teamProjectSelection';
import { TeamTaskStatusSummary } from './TeamTaskStatusSummary';

import type { ActiveTeamRef, TeamCopyData } from './dialogs/CreateTeamDialog';
import type { TeamLaunchDialogMode } from './dialogs/LaunchTeamDialog';
import type { TeamListFilterState } from './TeamListFilterPopover';
import type { OrganizationPlacementSelection } from '@features/organizations/contracts';
import type { TeamStatus } from '@renderer/utils/teamListStatus';
import type {
  ResolvedTeamMember,
  TeamCreateRequest,
  TeamLaunchRequest,
  TeamMemberSnapshot,
  TeamSummary,
  TeamSummaryMember,
} from '@shared/types';

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

interface CreateTeamDialogLoadingFallbackProps {
  readonly isCopy: boolean;
  readonly onClose: () => void;
}

const CreateTeamDialogLoadingFallback = ({
  isCopy,
  onClose,
}: CreateTeamDialogLoadingFallbackProps): React.JSX.Element => {
  const { t } = useAppTranslation('team');
  const { t: tCommon } = useAppTranslation('common');

  return (
    <Dialog
      open
      onOpenChange={(nextOpen) => {
        if (!nextOpen) {
          onClose();
        }
      }}
    >
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle className="text-sm">
            {isCopy ? t('create.title.copy') : t('create.title.create')}
          </DialogTitle>
          <DialogDescription className="sr-only" aria-live="polite">
            {tCommon('states.loading')}
          </DialogDescription>
        </DialogHeader>
        <div className="flex items-center gap-2 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-overlay)] px-3 py-2 text-xs text-[var(--color-text-muted)]">
          <Loader2 className="size-3.5 animate-spin" />
          <span>{tCommon('states.loading')}</span>
        </div>
      </DialogContent>
    </Dialog>
  );
};

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

function getRecentProjects(team: TeamSummary): string[] {
  const history = team.projectPathHistory;
  if (!history || history.length === 0) {
    return team.projectPath ? [team.projectPath] : [];
  }
  return history.slice(-3).reverse();
}

function folderName(fullPath: string): string {
  return getBaseName(fullPath) || fullPath;
}

function resolveLaunchDialogMembers(members: readonly TeamMemberSnapshot[]): ResolvedTeamMember[] {
  return members.map((member) => {
    return {
      ...member,
      status: member.currentTaskId ? 'active' : 'idle',
      messageCount: 0,
      lastActiveAt: null,
    };
  });
}

function renderMemberNames(members: TeamSummaryMember[]): React.JSX.Element {
  const teamColorMap = buildMemberColorMap(members);
  return (
    <>
      {members.map((m) => {
        const resolvedColor = teamColorMap.get(m.name);
        const memberColor = resolvedColor ? getTeamColorSet(resolvedColor) : null;
        return (
          <span key={m.name} className="inline-flex items-center gap-1">
            <span
              className="text-[10px] font-medium tracking-wide"
              style={memberColor ? { color: memberColor.text } : undefined}
            >
              {m.name}
            </span>
            {m.role ? (
              <span className="text-[9px] text-[var(--color-text-muted)]">{m.role}</span>
            ) : null}
          </span>
        );
      })}
    </>
  );
}

function renderTeamRecentPaths(
  team: TeamSummary,
  status: TeamStatus,
  matchesCurrentProject: boolean,
  isLight: boolean,
  selectedProjectPath: string | null
): React.JSX.Element | null {
  const recentPaths = getRecentProjects(team);
  const visibleRecentPaths =
    matchesCurrentProject && selectedProjectPath
      ? recentPaths.filter((path) => normalizePath(path) !== normalizePath(selectedProjectPath))
      : recentPaths;
  if (visibleRecentPaths.length === 0) return null;
  return (
    <div className="mt-2 flex items-center gap-1 text-[10px] text-[var(--color-text-muted)]">
      {matchesCurrentProject && !selectedProjectPath ? (
        <span
          className={`inline-flex items-center gap-1 truncate rounded-full px-2 py-0.5 text-[12px] font-medium ${
            isLight ? 'bg-emerald-100 text-emerald-700' : 'bg-emerald-500/15 text-emerald-400'
          }`}
        >
          <FolderOpen size={12} className="shrink-0" />
          {visibleRecentPaths.map((p, i) => (
            <span key={p} title={p}>
              {folderName(p)}
              {i < visibleRecentPaths.length - 1 ? ', ' : ''}
            </span>
          ))}
        </span>
      ) : (
        <>
          <FolderOpen size={10} className="shrink-0" />
          <span className="truncate">
            {visibleRecentPaths.map((p, i) => (
              <span key={p} title={p}>
                {i === 0 && (status === 'active' || status === 'idle') ? (
                  <span className="text-emerald-400">{folderName(p)}</span>
                ) : (
                  folderName(p)
                )}
                {i < visibleRecentPaths.length - 1 ? ', ' : ''}
              </span>
            ))}
          </span>
        </>
      )}
    </div>
  );
}

type TeamT = ReturnType<typeof useAppTranslation>['t'];

const StatusBadge = ({ status, t }: { status: TeamStatus; t: TeamT }): React.JSX.Element => {
  switch (status) {
    case 'active':
      return (
        <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] font-medium text-emerald-400">
          <span className="size-1.5 animate-pulse rounded-full bg-emerald-400" />
          {t('list.status.active')}
        </span>
      );
    case 'idle':
      return (
        <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] font-medium text-emerald-400">
          <span className="size-1.5 rounded-full bg-emerald-400" />
          {t('list.status.running')}
        </span>
      );
    case 'provisioning':
      return (
        <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-medium text-amber-400">
          <span className="size-1.5 animate-pulse rounded-full bg-amber-400" />
          {t('list.status.launching')}
        </span>
      );
    case 'offline':
      return (
        <span className="inline-flex items-center gap-1 rounded-full bg-zinc-500/15 px-2 py-0.5 text-[10px] font-medium text-zinc-500">
          <span className="size-1.5 rounded-full bg-zinc-500" />
          {t('list.status.offline')}
        </span>
      );
    case 'partial_failure':
      return (
        <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-medium text-amber-400">
          <span className="size-1.5 rounded-full bg-amber-400" />
          {t('list.status.partialFailure')}
        </span>
      );
    case 'partial_skipped':
      return (
        <span className="inline-flex items-center gap-1 rounded-full bg-sky-500/15 px-2 py-0.5 text-[10px] font-medium text-sky-300">
          <span className="size-1.5 rounded-full bg-sky-300" />
          {t('list.status.partialSkipped')}
        </span>
      );
    case 'partial_pending':
      return (
        <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-medium text-amber-300">
          <span className="size-1.5 rounded-full bg-amber-300" />
          {t('list.status.partialPending')}
        </span>
      );
  }
};

interface ActiveTeamCardProps {
  team: TeamSummary;
  status: TeamStatus;
  teamColorSet: TeamColorSet;
  isLight: boolean;
  matchesCurrentProject: boolean;
  currentProjectPath: string | null;
  branchName?: string;
  taskCounts?: TaskStatusCounts;
  launchingTeamName: string | null;
  stoppingTeamName: string | null;
  onOpenTeam: (teamName: string, projectPath?: string) => void;
  onLaunchTeam: (
    teamName: string,
    projectPath: string | undefined,
    mode: TeamLaunchDialogMode,
    event: React.MouseEvent
  ) => void;
  onStopTeam: (teamName: string, event: React.MouseEvent) => void;
  onCopyTeam: (teamName: string, event: React.MouseEvent) => void;
  onDeleteTeam: (teamName: string, pendingCreate: boolean, event: React.MouseEvent) => void;
  t: TeamT;
}

const ActiveTeamCard = ({
  team,
  status,
  teamColorSet,
  isLight,
  matchesCurrentProject,
  currentProjectPath,
  branchName,
  taskCounts,
  launchingTeamName,
  stoppingTeamName,
  onOpenTeam,
  onLaunchTeam,
  onStopTeam,
  onCopyTeam,
  onDeleteTeam,
  t,
}: Readonly<ActiveTeamCardProps>): React.JSX.Element => {
  const canLaunch =
    (status === 'offline' ||
      status === 'partial_failure' ||
      status === 'partial_skipped' ||
      status === 'partial_pending') &&
    Boolean(team.projectPath);
  const launchMode: TeamLaunchDialogMode = status === 'offline' ? 'launch' : 'relaunch';
  const launchLabel =
    launchMode === 'relaunch' ? t('list.actions.relaunchTeam') : t('list.actions.launchTeam');
  const launchTitle =
    launchingTeamName === team.teamName ? t('list.actions.launching') : launchLabel;
  const stopTitle =
    stoppingTeamName === team.teamName ? t('list.actions.stopping') : t('list.actions.stopTeam');
  const copyTitle = t('list.actions.copyTeam');
  const deleteTitle = t('list.actions.deleteTeam');

  return (
    <div
      role="button"
      tabIndex={0}
      className="team-row-zebra-card group relative flex cursor-pointer flex-col overflow-hidden rounded-lg border border-[var(--color-border)] p-4 transition-colors duration-200 hover:border-[var(--color-border-emphasis)]"
      onClick={() => onOpenTeam(team.teamName, team.projectPath ?? undefined)}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onOpenTeam(team.teamName, team.projectPath ?? undefined);
        }
      }}
    >
      <div className="flex flex-1 flex-col">
        <div className="space-y-2">
          <div className="flex min-w-0 items-start gap-2.5">
            <div className="flex size-8 shrink-0 items-center justify-center rounded-md border border-[var(--color-border)] bg-[var(--color-surface-overlay)] transition-colors group-hover:border-[var(--color-border-emphasis)]">
              <UsersRound
                className="size-4 transition-colors"
                style={{ color: getThemedBorder(teamColorSet, isLight) }}
              />
            </div>
            <h3 className="line-clamp-2 min-w-0 flex-1 break-words text-sm font-semibold leading-snug text-[var(--color-text)]">
              {team.displayName}
            </h3>
            <div className="pointer-events-none shrink-0">
              <StatusBadge status={status} t={t} />
            </div>
          </div>
          <div className="flex min-h-6 items-center justify-between gap-2">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              {branchName ? (
                <span
                  className="flex max-w-full items-center gap-1 rounded bg-[var(--color-surface-raised)] px-1.5 py-0.5 text-[10px] text-[var(--color-text-muted)]"
                  title={branchName}
                >
                  <GitBranch size={10} className="shrink-0" />
                  <span className="truncate">{branchName}</span>
                </span>
              ) : null}
            </div>
            <div className="flex shrink-0 gap-1">
              {canLaunch ? (
                <button
                  type="button"
                  className="shrink-0 rounded p-1 text-[var(--color-text-muted)] opacity-0 transition-opacity hover:bg-emerald-500/10 hover:text-emerald-300 disabled:opacity-50 group-hover:opacity-100"
                  onClick={(event) =>
                    onLaunchTeam(team.teamName, team.projectPath ?? undefined, launchMode, event)
                  }
                  disabled={launchingTeamName === team.teamName}
                  aria-label={launchTitle}
                  title={launchTitle}
                >
                  <Play size={14} fill="currentColor" />
                </button>
              ) : null}
              {status === 'active' || status === 'idle' ? (
                <button
                  type="button"
                  className="shrink-0 rounded p-1 text-[var(--color-text-muted)] opacity-0 transition-opacity hover:bg-amber-500/10 hover:text-amber-300 disabled:opacity-50 group-hover:opacity-100"
                  onClick={(event) => onStopTeam(team.teamName, event)}
                  disabled={stoppingTeamName === team.teamName}
                  aria-label={stopTitle}
                  title={stopTitle}
                >
                  <Square size={14} fill="currentColor" />
                </button>
              ) : null}
              {!team.pendingCreate ? (
                <button
                  type="button"
                  className="shrink-0 rounded p-1 text-[var(--color-text-muted)] opacity-0 transition-opacity hover:bg-blue-500/10 hover:text-blue-300 group-hover:opacity-100"
                  onClick={(event) => onCopyTeam(team.teamName, event)}
                  aria-label={copyTitle}
                  title={copyTitle}
                >
                  <Copy size={14} />
                </button>
              ) : null}
              <button
                type="button"
                className="shrink-0 rounded p-1 text-[var(--color-text-muted)] opacity-0 transition-opacity hover:bg-red-500/10 hover:text-red-300 group-hover:opacity-100"
                onClick={(event) => onDeleteTeam(team.teamName, !!team.pendingCreate, event)}
                aria-label={deleteTitle}
                title={deleteTitle}
              >
                <Trash2 size={14} />
              </button>
            </div>
          </div>
        </div>
        <div className="mt-2 flex min-h-10 items-start gap-2">
          <p className="line-clamp-2 min-w-0 flex-1 text-xs text-[var(--color-text-muted)]">
            {team.description || t('list.noDescription')}
          </p>
        </div>
        {team.teamLaunchState === 'partial_pending' ? (
          <p className="mt-2 text-[11px] text-amber-300">
            {team.runtimeProcessPendingCount && team.runtimeProcessPendingCount > 0
              ? buildPendingRuntimeSummaryCopy({
                  confirmedCount: team.confirmedCount,
                  expectedMemberCount: team.expectedMemberCount,
                  memberCount: team.memberCount,
                  runtimeProcessPendingCount: team.runtimeProcessPendingCount,
                  includePeriod: true,
                })
              : t('list.partial.pending')}
          </p>
        ) : team.partialLaunchFailure || team.teamLaunchState === 'partial_failure' ? (
          <p className="mt-2 text-[11px] text-amber-400">
            {team.missingMembers?.length
              ? t('detail.offline.partialMissing', {
                  missing: team.missingMembers.length,
                  expected: team.expectedMemberCount ?? team.missingMembers.length,
                })
              : t('detail.offline.partialFailed')}
          </p>
        ) : team.teamLaunchState === 'partial_skipped' ? (
          <p className="mt-2 text-[11px] text-sky-300">
            {team.skippedMembers?.length
              ? t('list.partial.skippedWithCount', {
                  count: team.skippedMembers.length,
                  expected: team.expectedMemberCount ?? team.skippedMembers.length,
                })
              : t('list.partial.skipped')}
          </p>
        ) : null}
        <div className="mt-3 flex flex-wrap items-center gap-x-6 gap-y-2">
          {team.members && team.members.length > 0 ? (
            renderMemberNames(team.members)
          ) : team.memberCount === 0 ? (
            <Badge variant="secondary" className="text-[10px] font-normal">
              {t('list.solo')}
            </Badge>
          ) : (
            <Badge variant="secondary" className="text-[10px] font-normal">
              {t('list.membersCount', { count: team.memberCount })}
            </Badge>
          )}
        </div>
        <div className="mt-auto">
          <TeamTaskStatusSummary counts={taskCounts} />
          {renderTeamRecentPaths(team, status, matchesCurrentProject, isLight, currentProjectPath)}
        </div>
      </div>
    </div>
  );
};

export const TeamListView = memo(function TeamListView(): React.JSX.Element {
  const { isLight } = useTheme();
  const { t } = useAppTranslation('team');
  const { t: tCommon } = useAppTranslation('common');
  const electronMode = isElectronMode();
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [showImportDialog, setShowImportDialog] = useState(false);
  const [copyData, setCopyData] = useState<TeamCopyData | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [filter, setFilter] = useState<TeamListFilterState>(EMPTY_TEAM_FILTER);
  const [teamPriorityProjectPath, setTeamPriorityProjectPath] = useState<string | null>(null);
  const [aliveTeams, setAliveTeams] = useState<string[]>([]);
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
      branchByPath: s.branchByPath,
    }))
  );
  const {
    connectionMode,
    createTeam,
    launchTeam,
    provisioningErrorByTeam,
    clearProvisioningError,
    provisioningRuns,
    provisioningSnapshotByTeam,
    currentProvisioningRunIdByTeam,
    leadActivityByTeam,
  } = useStore(
    useShallow((s) => ({
      connectionMode: s.connectionMode,
      createTeam: s.createTeam,
      launchTeam: s.launchTeam,
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
      return await api.teams.aliveList();
    } catch {
      return null;
    }
  }, [electronMode]);

  // Fetch alive teams on mount and when teams list changes.
  useEffect(() => {
    let cancelled = false;
    void fetchAliveTeams().then((list) => {
      if (!cancelled && list) {
        setAliveTeams(list);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [fetchAliveTeams, teams]);

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
      if (!cancelled && list) {
        setAliveTeams(list);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [fetchAliveTeams, readyProgressRefreshKey]);

  // Refresh alive teams when opening the create dialog so conflict warning is accurate.
  useEffect(() => {
    if (!electronMode || !showCreateDialog) return;
    let cancelled = false;
    void fetchAliveTeams().then((list) => {
      if (!cancelled && list) {
        setAliveTeams(list);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [electronMode, fetchAliveTeams, showCreateDialog]);

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
  const currentProjectPath = teamPriorityProjectPath ?? currentProjectSelection.projectPath;
  const createTeamDefaultProjectPath = resolveCreateTeamDefaultProjectPath({
    initialProjectPath: copyData?.cwd,
    selectedProjectPath: currentProjectSelection.projectPath,
    priorityProjectPath: teamPriorityProjectPath,
  });

  const filteredTeams = useMemo<TeamSummary[]>(() => {
    let result = teamsWithProvisioning;

    const q = searchQuery.trim().toLowerCase();
    if (q) {
      result = result.filter(
        (t) =>
          t.teamName.toLowerCase().includes(q) ||
          t.displayName.toLowerCase().includes(q) ||
          t.description.toLowerCase().includes(q)
      );
    }

    if (filter.selectedStatuses.size > 0) {
      result = result.filter((t) => {
        const status = resolveTeamStatus(
          t,
          t.teamName,
          aliveTeams,
          getCurrentProvisioningProgressForTeam(provisioningState, t.teamName),
          leadActivityByTeam
        );
        const isRunning = isTeamListStatusRunning(status);
        if (filter.selectedStatuses.has('running') && isRunning) return true;
        if (filter.selectedStatuses.has('offline') && !isRunning) return true;
        return false;
      });
    }

    const matchesCurrentProject = currentProjectPath
      ? (team: TeamSummary): boolean => teamMatchesProjectSelection(team, currentProjectPath)
      : null;
    const nowMs = Date.now();
    const statusForTeam = (team: TeamSummary): TeamStatus =>
      resolveTeamStatus(
        team,
        team.teamName,
        aliveTeams,
        getCurrentProvisioningProgressForTeam(provisioningState, team.teamName),
        leadActivityByTeam,
        nowMs
      );

    result = [...result].sort((a, b) => {
      // 1. Running teams first, including the short ready-before-alive-list gap.
      const runningA = isTeamListStatusRunning(statusForTeam(a)) ? 0 : 1;
      const runningB = isTeamListStatusRunning(statusForTeam(b)) ? 0 : 1;
      if (runningA !== runningB) return runningA - runningB;

      // 2. Teams related to the selected project are prioritized next
      if (matchesCurrentProject) {
        const projectA = matchesCurrentProject(a) ? 0 : 1;
        const projectB = matchesCurrentProject(b) ? 0 : 1;
        if (projectA !== projectB) return projectA - projectB;
      }

      // 3. Most recently active teams first (stable secondary sort)
      const tsA = a.lastActivity ? new Date(a.lastActivity).getTime() : 0;
      const tsB = b.lastActivity ? new Date(b.lastActivity).getTime() : 0;
      if (tsA !== tsB) return tsB - tsA;

      // 4. Fallback: alphabetical by team name for deterministic order
      return a.teamName.localeCompare(b.teamName);
    });

    return result;
  }, [
    teamsWithProvisioning,
    searchQuery,
    currentProjectPath,
    aliveTeams,
    filter,
    provisioningState,
    leadActivityByTeam,
  ]);

  const handleProjectSelectionChange = useCallback(
    (projectPath: string | null): void => {
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
            void api.teams.deleteDraft(teamName).catch(() => {});
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
          try {
            await deleteTeam(teamName);
          } catch {
            // error via store
          }
        }
      })();
    },
    [deleteTeam, t]
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
          try {
            await permanentlyDeleteTeam(teamName);
          } catch {
            // error via store
          }
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

          const savedRequest = await api.teams.getSavedRequest(teamName).catch(() => null);
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
              limitContext: savedRequest.limitContext,
              skipPermissions: savedRequest.skipPermissions,
              members: buildCopiedTeamMembers(savedRequest.members),
            });
            setShowCreateDialog(true);
            return;
          }

          const data = await api.teams.getData(teamName, {
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
    [teams]
  );

  const [stoppingTeamName, setStoppingTeamName] = useState<string | null>(null);
  const handleStopTeam = useCallback(async (teamName: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setStoppingTeamName(teamName);
    try {
      await api.teams.stop(teamName);
      setAliveTeams((prev) => prev.filter((n) => n !== teamName));
    } catch (err) {
      console.error('Failed to stop team:', err);
    } finally {
      setStoppingTeamName(null);
    }
  }, []);

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
        const data = await api.teams.getData(teamName, {
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
    []
  );

  const handleLaunchSubmit = useCallback(
    async (request: TeamLaunchRequest) => {
      setLaunchingTeamName(request.teamName);
      try {
        await launchTeam(request);
      } catch (err) {
        console.error('Failed to launch team:', err);
        throw err;
      } finally {
        setLaunchingTeamName(null);
      }
    },
    [launchTeam]
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
          stopTeam: (nextTeamName) => api.teams.stop(nextTeamName),
          replaceMembers: (nextTeamName, nextRequest) =>
            api.teams.replaceMembers(nextTeamName, nextRequest),
          launchTeam,
        });
      } catch (err) {
        console.error('Failed to relaunch team:', err);
        throw err;
      } finally {
        setLaunchingTeamName(null);
      }
    },
    [launchTeam]
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
            <FolderOpen size={13} />
            {t('list.actions.importTeam')}
          </Button>
          <Button
            size="sm"
            className="gap-1.5"
            disabled={!canCreate}
            onClick={() => setShowCreateDialog(true)}
          >
            <Plus size={13} />
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
            <Input
              type="text"
              placeholder={t('list.searchPlaceholder')}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="h-8 pl-8 text-xs"
            />
          </div>
          <TeamListFilterPopover
            filter={filter}
            selectedProjectPath={currentProjectPath}
            teams={teamsWithProvisioning}
            aliveTeams={aliveTeams}
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
              project: folderName(currentProjectPath) || t('list.sections.selectedProject'),
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
                  <div className="team-row-zebra-grid grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
                    {visibleTeams.map((team) => {
                      const status = resolveTeamStatus(
                        team,
                        team.teamName,
                        aliveTeams,
                        getCurrentProvisioningProgressForTeam(provisioningState, team.teamName),
                        leadActivityByTeam
                      );
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
                          stoppingTeamName={stoppingTeamName}
                          onOpenTeam={openTeamTab}
                          onLaunchTeam={handleLaunchTeam}
                          onStopTeam={handleStopTeam}
                          onCopyTeam={handleCopyTeam}
                          onDeleteTeam={handleDeleteTeam}
                          t={t}
                        />
                      );
                    })}
                  </div>
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
                        {renderMemberNames(team.members)}
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
