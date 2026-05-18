import { lazy, memo, Suspense, useCallback, useEffect, useMemo, useState } from 'react';

import { recordRecentProjectOpenPaths } from '@features/recent-projects/renderer';
import { api, isElectronMode } from '@renderer/api';
import { confirm } from '@renderer/components/common/ConfirmDialog';
import { Badge } from '@renderer/components/ui/badge';
import { Button } from '@renderer/components/ui/button';
import { Input } from '@renderer/components/ui/input';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@renderer/components/ui/tooltip';
import {
  getTeamColorSet,
  getThemedBadge,
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
import { isLeadMember } from '@shared/utils/leadDetection';
import {
  Copy,
  FolderOpen,
  GitBranch,
  Play,
  RotateCcw,
  Search,
  Square,
  Trash2,
  UsersRound,
} from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';

import { TeamEmptyState } from './TeamEmptyState';
import { EMPTY_TEAM_FILTER, TeamListFilterPopover } from './TeamListFilterPopover';
import {
  findTeamProjectSelectionTarget,
  resolveTeamProjectSelection,
  teamMatchesProjectSelection,
} from './teamProjectSelection';
import { TeamTaskStatusSummary } from './TeamTaskStatusSummary';

import type { ActiveTeamRef, TeamCopyData } from './dialogs/CreateTeamDialog';
import type { TeamListFilterState } from './TeamListFilterPopover';
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

function renderMemberChips(members: TeamSummaryMember[], isLight: boolean): React.JSX.Element {
  const teamColorMap = buildMemberColorMap(members);
  return (
    <>
      {members.map((m) => {
        const resolvedColor = teamColorMap.get(m.name);
        const memberColor = resolvedColor ? getTeamColorSet(resolvedColor) : null;
        return (
          <span key={m.name} className="inline-flex items-center gap-1">
            <span
              className="rounded px-1.5 py-0.5 text-[10px] font-medium tracking-wide"
              style={
                memberColor
                  ? {
                      backgroundColor: getThemedBadge(memberColor, isLight),
                      color: memberColor.text,
                      border: `1px solid ${memberColor.border}40`,
                    }
                  : undefined
              }
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

const StatusBadge = ({ status }: { status: TeamStatus }): React.JSX.Element => {
  switch (status) {
    case 'active':
      return (
        <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] font-medium text-emerald-400">
          <span className="size-1.5 animate-pulse rounded-full bg-emerald-400" />
          Active
        </span>
      );
    case 'idle':
      return (
        <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] font-medium text-emerald-400">
          <span className="size-1.5 rounded-full bg-emerald-400" />
          Running
        </span>
      );
    case 'provisioning':
      return (
        <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-medium text-amber-400">
          <span className="size-1.5 animate-pulse rounded-full bg-amber-400" />
          Launching...
        </span>
      );
    case 'offline':
      return (
        <span className="inline-flex items-center gap-1 rounded-full bg-zinc-500/15 px-2 py-0.5 text-[10px] font-medium text-zinc-500">
          <span className="size-1.5 rounded-full bg-zinc-500" />
          Offline
        </span>
      );
    case 'partial_failure':
      return (
        <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-medium text-amber-400">
          <span className="size-1.5 rounded-full bg-amber-400" />
          Launch failed partway
        </span>
      );
    case 'partial_skipped':
      return (
        <span className="inline-flex items-center gap-1 rounded-full bg-sky-500/15 px-2 py-0.5 text-[10px] font-medium text-sky-300">
          <span className="size-1.5 rounded-full bg-sky-300" />
          Launch skipped member
        </span>
      );
    case 'partial_pending':
      return (
        <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-medium text-amber-300">
          <span className="size-1.5 rounded-full bg-amber-300" />
          Bootstrap pending
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
    event: React.MouseEvent
  ) => void;
  onStopTeam: (teamName: string, event: React.MouseEvent) => void;
  onCopyTeam: (teamName: string, event: React.MouseEvent) => void;
  onDeleteTeam: (teamName: string, pendingCreate: boolean, event: React.MouseEvent) => void;
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
}: Readonly<ActiveTeamCardProps>): React.JSX.Element => {
  const canLaunch =
    (status === 'offline' ||
      status === 'partial_failure' ||
      status === 'partial_skipped' ||
      status === 'partial_pending') &&
    Boolean(team.projectPath);

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
      <div className="pointer-events-none absolute right-4 top-4 z-10">
        <StatusBadge status={status} />
      </div>
      <div className="flex flex-1 flex-col">
        <div className="space-y-2">
          <div className="flex items-start gap-2.5 pr-44">
            <div className="flex size-8 shrink-0 items-center justify-center rounded-md border border-[var(--color-border)] bg-[var(--color-surface-overlay)] transition-colors group-hover:border-[var(--color-border-emphasis)]">
              <UsersRound
                className="size-4 transition-colors"
                style={{ color: getThemedBorder(teamColorSet, isLight) }}
              />
            </div>
            <h3 className="min-w-0 flex-1 break-words text-sm font-semibold leading-snug text-[var(--color-text)]">
              {team.displayName}
            </h3>
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
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      className="shrink-0 rounded p-1 text-[var(--color-text-muted)] opacity-0 transition-opacity hover:bg-emerald-500/10 hover:text-emerald-300 disabled:opacity-50 group-hover:opacity-100"
                      onClick={(event) =>
                        onLaunchTeam(team.teamName, team.projectPath ?? undefined, event)
                      }
                      disabled={launchingTeamName === team.teamName}
                      aria-label="Launch team"
                    >
                      <Play size={14} fill="currentColor" />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">
                    {launchingTeamName === team.teamName ? 'Launching…' : 'Launch team'}
                  </TooltipContent>
                </Tooltip>
              ) : null}
              {status === 'active' || status === 'idle' ? (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      className="shrink-0 rounded p-1 text-[var(--color-text-muted)] opacity-0 transition-opacity hover:bg-amber-500/10 hover:text-amber-300 disabled:opacity-50 group-hover:opacity-100"
                      onClick={(event) => onStopTeam(team.teamName, event)}
                      disabled={stoppingTeamName === team.teamName}
                      aria-label="Stop team"
                    >
                      <Square size={14} fill="currentColor" />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">
                    {stoppingTeamName === team.teamName ? 'Stopping…' : 'Stop team'}
                  </TooltipContent>
                </Tooltip>
              ) : null}
              {!team.pendingCreate ? (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      className="shrink-0 rounded p-1 text-[var(--color-text-muted)] opacity-0 transition-opacity hover:bg-blue-500/10 hover:text-blue-300 group-hover:opacity-100"
                      onClick={(event) => onCopyTeam(team.teamName, event)}
                    >
                      <Copy size={14} />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">Copy team</TooltipContent>
                </Tooltip>
              ) : null}
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    className="shrink-0 rounded p-1 text-[var(--color-text-muted)] opacity-0 transition-opacity hover:bg-red-500/10 hover:text-red-300 group-hover:opacity-100"
                    onClick={(event) => onDeleteTeam(team.teamName, !!team.pendingCreate, event)}
                  >
                    <Trash2 size={14} />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="bottom">Delete team</TooltipContent>
              </Tooltip>
            </div>
          </div>
        </div>
        <div className="mt-2 flex min-h-10 items-start gap-2">
          <p className="line-clamp-2 min-w-0 flex-1 text-xs text-[var(--color-text-muted)]">
            {team.description || 'No description'}
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
              : 'Last launch is still reconciling.'}
          </p>
        ) : team.partialLaunchFailure || team.teamLaunchState === 'partial_failure' ? (
          <p className="mt-2 text-[11px] text-amber-400">
            {team.missingMembers?.length
              ? `Last launch stopped before ${team.missingMembers.length}/${team.expectedMemberCount ?? team.missingMembers.length} teammate${team.missingMembers.length === 1 ? '' : 's'} joined.`
              : 'Last launch stopped before all teammates joined.'}
          </p>
        ) : team.teamLaunchState === 'partial_skipped' ? (
          <p className="mt-2 text-[11px] text-sky-300">
            {team.skippedMembers?.length
              ? `Last launch skipped ${team.skippedMembers.length}/${team.expectedMemberCount ?? team.skippedMembers.length} teammate${team.skippedMembers.length === 1 ? '' : 's'}.`
              : 'Last launch has skipped teammates.'}
          </p>
        ) : null}
        <div className="mt-3 flex flex-wrap items-center gap-x-6 gap-y-2">
          {team.members && team.members.length > 0 ? (
            renderMemberChips(team.members, isLight)
          ) : team.memberCount === 0 ? (
            <Badge variant="secondary" className="text-[10px] font-normal">
              Solo
            </Badge>
          ) : (
            <Badge variant="secondary" className="text-[10px] font-normal">
              Members: {team.memberCount}
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
  const electronMode = isElectronMode();
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [copyData, setCopyData] = useState<TeamCopyData | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [filter, setFilter] = useState<TeamListFilterState>(EMPTY_TEAM_FILTER);
  const [aliveTeams, setAliveTeams] = useState<string[]>([]);
  const {
    teams,
    teamsLoading,
    teamsError,
    fetchTeams,
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
  const currentProjectPath = currentProjectSelection.projectPath;

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
        useStore.setState(getProjectSelectionResetState());
        return;
      }

      const target = findTeamProjectSelectionTarget(repositoryGroups, projects, projectPath);
      if (!target) {
        console.warn('Unable to resolve selected team project path:', projectPath);
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
            title: 'Delete draft',
            message: `Delete draft team "${teamName}"? This cannot be undone.`,
            confirmLabel: 'Delete',
            cancelLabel: 'Cancel',
            variant: 'danger',
          });
          if (confirmed) {
            void api.teams.deleteDraft(teamName).catch(() => {});
          }
          return;
        }
        const confirmed = await confirm({
          title: 'Move to trash',
          message: `Move team "${teamName}" to trash? You can restore it later.`,
          confirmLabel: 'Move to trash',
          cancelLabel: 'Cancel',
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
    [deleteTeam]
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
          title: 'Delete permanently',
          message: `Delete team "${teamName}" permanently? All data will be lost.`,
          confirmLabel: 'Delete forever',
          cancelLabel: 'Cancel',
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
    [permanentlyDeleteTeam]
  );

  const handleCopyTeam = useCallback(
    (teamName: string, e: React.MouseEvent) => {
      e.stopPropagation();
      void (async () => {
        try {
          const data = await api.teams.getData(teamName, {
            includeMemberBranches: false,
          });
          const existingNames = teams.map((t) => t.teamName);
          const uniqueName = generateUniqueName(teamName, existingNames);
          const members = (data.members ?? [])
            .filter((m) => !m.removedAt && !isLeadMember(m))
            .map((m) => {
              let role = m.role;
              if (!role && m.agentType && m.agentType !== 'general-purpose') {
                role = m.agentType;
              }
              return { name: m.name, role };
            });
          setCopyData({
            teamName: uniqueName,
            description: data.config.description,
            color: data.config.color,
            members,
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
  const [launchDialogTeamName, setLaunchDialogTeamName] = useState('');
  const [launchDialogMembers, setLaunchDialogMembers] = useState<ResolvedTeamMember[]>([]);
  const [launchDialogDefaultPath, setLaunchDialogDefaultPath] = useState<string | undefined>();

  const handleLaunchTeam = useCallback(
    async (teamName: string, projectPath: string | undefined, e: React.MouseEvent) => {
      e.stopPropagation();
      if (!projectPath) return;
      try {
        const data = await api.teams.getData(teamName, {
          includeMemberBranches: false,
        });
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
    async (request: TeamCreateRequest) => {
      await createTeam(request);
    },
    [createTeam]
  );

  if (!electronMode) {
    return (
      <div className="flex size-full items-center justify-center p-6">
        <div className="max-w-md text-center">
          <p className="text-sm font-medium text-[var(--color-text)]">
            Teams is only available in Electron mode
          </p>
          <p className="mt-2 text-xs text-[var(--color-text-muted)]">
            In browser mode, access to local `~/.claude/teams` directories is not available.
          </p>
        </div>
      </div>
    );
  }

  const createDialogElement = showCreateDialog && (
    <Suspense fallback={null}>
      <CreateTeamDialog
        open={showCreateDialog}
        canCreate={canCreate}
        provisioningErrorsByTeam={provisioningErrorByTeam}
        clearProvisioningError={clearProvisioningError}
        existingTeamNames={teams.map((t) => t.teamName)}
        provisioningTeamNames={provisioningTeamNames}
        activeTeams={activeTeams}
        initialData={copyData ?? undefined}
        defaultProjectPath={currentProjectPath}
        onClose={handleCreateDialogClose}
        onCreate={handleCreateSubmit}
        onOpenTeam={openTeamTab}
      />
    </Suspense>
  );

  const launchDialogElement = launchDialogOpen && (
    <Suspense fallback={null}>
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
    </Suspense>
  );

  const renderHeader = (): React.JSX.Element => (
    <div className="mb-4">
      <div className="flex items-center justify-between">
        <h2 className="text-base font-semibold text-[var(--color-text)]">Select Team</h2>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={!canCreate}
            onClick={() => setShowCreateDialog(true)}
          >
            Create Team
          </Button>
        </div>
      </div>
      {!canCreate ? (
        <p className="mt-2 text-xs text-[var(--color-text-muted)]">
          Only available in local Electron mode.
        </p>
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
              placeholder="Search teams..."
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
          Loading teams...
        </div>
      );
    }

    if (teamsError) {
      return (
        <div className="flex size-full items-center justify-center p-6">
          <div className="text-center">
            <p className="text-sm font-medium text-red-400">Failed to load teams</p>
            <p className="mt-2 text-xs text-[var(--color-text-muted)]">{teamsError}</p>
            <Button
              variant="outline"
              size="sm"
              className="mt-4"
              onClick={() => {
                void fetchTeams();
              }}
            >
              Retry
            </Button>
          </div>
        </div>
      );
    }

    if (teamsWithProvisioning.length === 0) {
      return (
        <TeamEmptyState canCreate={canCreate} onCreateTeam={() => setShowCreateDialog(true)} />
      );
    }

    const hasActiveFilters = filter.selectedStatuses.size > 0;
    if (filteredTeams.length === 0 && (searchQuery.trim() || hasActiveFilters)) {
      return (
        <div className="flex items-center justify-center py-12 text-sm text-[var(--color-text-muted)]">
          No teams matching current filters
        </div>
      );
    }

    const activeFiltered = filteredTeams.filter((t) => !t.deletedAt);
    const deletedFiltered = filteredTeams.filter((t) => t.deletedAt);
    const activeSections = currentProjectPath
      ? [
          {
            key: 'project',
            title: `Teams for ${folderName(currentProjectPath) || 'selected project'}`,
            teams: activeFiltered.filter((team) =>
              teamMatchesProjectSelection(team, currentProjectPath)
            ),
          },
          {
            key: 'other',
            title: 'Other teams',
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
              {section.teams.map((team) => {
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
                  />
                );
              })}
            </div>
          </section>
        ))}

        {deletedFiltered.length > 0 && (
          <>
            <div className="my-6 flex items-center gap-3">
              <div className="h-px flex-1 bg-[var(--color-border)]" />
              <span className="text-[10px] font-medium uppercase tracking-wider text-[var(--color-text-muted)]">
                Trash ({deletedFiltered.length})
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
                          Deleted
                        </span>
                      </div>
                      <div className="flex shrink-0 gap-1">
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <button
                              type="button"
                              className="shrink-0 rounded p-1 text-[var(--color-text-muted)] opacity-0 transition-opacity hover:bg-emerald-500/10 hover:text-emerald-300 group-hover:opacity-100"
                              onClick={(e) => handleRestoreTeam(team.teamName, e)}
                              aria-label="Restore team"
                            >
                              <RotateCcw size={14} />
                            </button>
                          </TooltipTrigger>
                          <TooltipContent side="bottom">Restore</TooltipContent>
                        </Tooltip>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <button
                              type="button"
                              className="shrink-0 rounded p-1 text-[var(--color-text-muted)] opacity-0 transition-opacity hover:bg-red-500/10 hover:text-red-300 group-hover:opacity-100"
                              onClick={(e) => handlePermanentlyDeleteTeam(team.teamName, e)}
                              aria-label="Delete permanently"
                            >
                              <Trash2 size={14} />
                            </button>
                          </TooltipTrigger>
                          <TooltipContent side="bottom">Delete forever</TooltipContent>
                        </Tooltip>
                      </div>
                    </div>
                    <p className="mt-2 line-clamp-2 text-xs text-[var(--color-text-muted)]">
                      {team.description || 'No description'}
                    </p>
                    {team.members && team.members.length > 0 && (
                      <div className="mt-3 flex flex-wrap items-center gap-x-6 gap-y-2">
                        {renderMemberChips(team.members, isLight)}
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
        {launchDialogElement}
      </div>
    </TooltipProvider>
  );
});
