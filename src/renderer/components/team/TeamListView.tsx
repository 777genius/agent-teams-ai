import { useCallback, useEffect, useMemo, useState } from 'react';

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
import { getTeamColorSet } from '@renderer/constants/teamColors';
import { useBranchSync } from '@renderer/hooks/useBranchSync';
import { useStore } from '@renderer/store';
import { buildMemberColorMap } from '@renderer/utils/memberHelpers';
import { buildTaskCountsByTeam, normalizePath } from '@renderer/utils/pathNormalize';
import { getBaseName } from '@renderer/utils/pathUtils';
import { nameColorSet } from '@renderer/utils/projectColor';
import {
  CheckCircle,
  Clock,
  Copy,
  FolderOpen,
  GitBranch,
  Play,
  RotateCcw,
  Search,
  Square,
  Trash2,
} from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';

import { CreateTeamDialog } from './dialogs/CreateTeamDialog';
import { TeamEmptyState } from './TeamEmptyState';
import { EMPTY_TEAM_FILTER, TeamListFilterPopover } from './TeamListFilterPopover';

import type { ActiveTeamRef, TeamCopyData } from './dialogs/CreateTeamDialog';
import type { TeamListFilterState } from './TeamListFilterPopover';
import type {
  TeamCreateRequest,
  TeamProvisioningProgress,
  TeamSummary,
  TeamSummaryMember,
} from '@shared/types';

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

type TeamStatus = 'active' | 'idle' | 'provisioning' | 'offline';

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

function renderMemberChips(members: TeamSummaryMember[]): React.JSX.Element {
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
                      backgroundColor: memberColor.badge,
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

function renderTeamRecentPaths(team: TeamSummary, status: TeamStatus): React.JSX.Element | null {
  const recentPaths = getRecentProjects(team);
  if (recentPaths.length === 0) return null;
  return (
    <div className="mt-2 flex items-center gap-1 text-[10px] text-[var(--color-text-muted)]">
      <FolderOpen size={10} className="shrink-0" />
      <span className="truncate">
        {recentPaths.map((p, i) => (
          <span key={p} title={p}>
            {i === 0 && (status === 'active' || status === 'idle') ? (
              <span className="text-emerald-400">{folderName(p)}</span>
            ) : (
              folderName(p)
            )}
            {i < recentPaths.length - 1 ? ', ' : ''}
          </span>
        ))}
      </span>
    </div>
  );
}

function resolveTeamStatus(
  teamName: string,
  aliveTeams: string[],
  provisioningRuns: Record<string, TeamProvisioningProgress>,
  leadActivityByTeam: Record<string, string>
): TeamStatus {
  if (aliveTeams.includes(teamName)) {
    return leadActivityByTeam[teamName] === 'active' ? 'active' : 'idle';
  }
  const activeStates = new Set(['validating', 'spawning', 'monitoring', 'verifying']);
  for (const run of Object.values(provisioningRuns)) {
    if (run.teamName === teamName && activeStates.has(run.state)) {
      return 'provisioning';
    }
  }
  return 'offline';
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
  }
};

export const TeamListView = (): React.JSX.Element => {
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
    projects,
    globalTasks,
    fetchAllTasks,
    viewMode,
    repositoryGroups,
    selectedRepositoryId,
    selectedWorktreeId,
    activeProjectId,
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
      viewMode: s.viewMode,
      repositoryGroups: s.repositoryGroups,
      selectedRepositoryId: s.selectedRepositoryId,
      selectedWorktreeId: s.selectedWorktreeId,
      activeProjectId: s.activeProjectId,
    }))
  );
  const { connectionMode, createTeam, provisioningError, provisioningRuns, leadActivityByTeam } =
    useStore(
      useShallow((s) => ({
        connectionMode: s.connectionMode,
        createTeam: s.createTeam,
        provisioningError: s.provisioningError,
        provisioningRuns: s.provisioningRuns,
        leadActivityByTeam: s.leadActivityByTeam,
      }))
    );
  const canCreate = electronMode && connectionMode === 'local';

  // Fetch alive teams on mount and when teams list changes
  useEffect(() => {
    if (!electronMode) return;
    let cancelled = false;
    const fetchAlive = async (): Promise<void> => {
      try {
        const list = await api.teams.aliveList();
        if (!cancelled) setAliveTeams(list);
      } catch {
        // best-effort
      }
    };
    void fetchAlive();
    return () => {
      cancelled = true;
    };
  }, [electronMode, teams]);

  const currentProjectPath = useMemo(() => {
    if (viewMode === 'grouped') {
      const repo = repositoryGroups.find((r) => r.id === selectedRepositoryId);
      const worktree = repo?.worktrees.find((w) => w.id === selectedWorktreeId);
      const path = worktree?.path ?? null;
      return path ? normalizePath(path) : null;
    }
    const project = projects.find((p) => p.id === activeProjectId);
    return project ? normalizePath(project.path) : null;
  }, [
    viewMode,
    repositoryGroups,
    selectedRepositoryId,
    selectedWorktreeId,
    projects,
    activeProjectId,
  ]);

  const filteredTeams = useMemo<TeamSummary[]>(() => {
    let result = teams;

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
          t.teamName,
          aliveTeams,
          provisioningRuns,
          leadActivityByTeam
        );
        const isRunning = status !== 'offline';
        if (filter.selectedStatuses.has('running') && isRunning) return true;
        if (filter.selectedStatuses.has('offline') && !isRunning) return true;
        return false;
      });
    }

    if (filter.selectedProjects.size > 0) {
      result = result.filter(
        (t) => t.projectPath != null && filter.selectedProjects.has(t.projectPath.trim())
      );
    }

    const aliveSet = new Set(aliveTeams);
    const matchesProject = currentProjectPath
      ? (t: TeamSummary): boolean => {
          if (t.projectPath && normalizePath(t.projectPath) === currentProjectPath) return true;
          return (
            t.projectPathHistory?.some((p) => normalizePath(p) === currentProjectPath) ?? false
          );
        }
      : null;

    result = [...result].sort((a, b) => {
      // 1. Alive (running) teams first
      const aliveA = aliveSet.has(a.teamName) ? 0 : 1;
      const aliveB = aliveSet.has(b.teamName) ? 0 : 1;
      if (aliveA !== aliveB) return aliveA - aliveB;

      // 2. Matching current project second
      if (matchesProject) {
        const projA = matchesProject(a) ? 0 : 1;
        const projB = matchesProject(b) ? 0 : 1;
        if (projA !== projB) return projA - projB;
      }

      return 0;
    });

    return result;
  }, [
    teams,
    searchQuery,
    currentProjectPath,
    aliveTeams,
    filter,
    provisioningRuns,
    leadActivityByTeam,
  ]);

  // Fetch branches once for all visible team project paths (no live polling)
  const teamPaths = useMemo(
    () => filteredTeams.map((t) => t.projectPath?.trim()).filter(Boolean) as string[],
    [filteredTeams]
  );
  useBranchSync(teamPaths, { live: false });
  const branchByPath = useStore((s) => s.branchByPath);

  const restoreTeam = useStore((s) => s.restoreTeam);
  const permanentlyDeleteTeam = useStore((s) => s.permanentlyDeleteTeam);

  const handleDeleteTeam = useCallback(
    (teamName: string, e: React.MouseEvent) => {
      e.stopPropagation();
      void (async () => {
        const confirmed = await confirm({
          title: 'Move to trash',
          message: `Move team "${teamName}" to trash? You can restore it later.`,
          confirmLabel: 'Move to trash',
          cancelLabel: 'Cancel',
          variant: 'danger',
        });
        if (confirmed) {
          void deleteTeam(teamName);
        }
      })();
    },
    [deleteTeam]
  );

  const handleRestoreTeam = useCallback(
    (teamName: string, e: React.MouseEvent) => {
      e.stopPropagation();
      void restoreTeam(teamName);
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
          void permanentlyDeleteTeam(teamName);
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
          const data = await api.teams.getData(teamName);
          const existingNames = teams.map((t) => t.teamName);
          const uniqueName = generateUniqueName(teamName, existingNames);
          const members = (data.members ?? [])
            .filter((m) => !m.removedAt && m.agentType !== 'team-lead')
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

  const createDialogElement = (
    <CreateTeamDialog
      open={showCreateDialog}
      canCreate={canCreate}
      provisioningError={provisioningError}
      existingTeamNames={teams.map((t) => t.teamName)}
      activeTeams={activeTeams}
      initialData={copyData ?? undefined}
      defaultProjectPath={currentProjectPath}
      onClose={handleCreateDialogClose}
      onCreate={handleCreateSubmit}
      onOpenTeam={openTeamTab}
    />
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
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              void fetchTeams();
            }}
          >
            Refresh
          </Button>
        </div>
      </div>
      {!canCreate ? (
        <p className="mt-2 text-xs text-[var(--color-text-muted)]">
          Only available in local Electron mode.
        </p>
      ) : null}

      {teams.length > 0 ? (
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
            teams={teams}
            aliveTeams={aliveTeams}
            onFilterChange={setFilter}
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

    if (teams.length === 0) {
      return <TeamEmptyState />;
    }

    const hasActiveFilters = filter.selectedStatuses.size > 0 || filter.selectedProjects.size > 0;
    if (filteredTeams.length === 0 && (searchQuery.trim() || hasActiveFilters)) {
      return (
        <div className="flex items-center justify-center py-12 text-sm text-[var(--color-text-muted)]">
          No teams matching current filters
        </div>
      );
    }

    const activeFiltered = filteredTeams.filter((t) => !t.deletedAt);
    const deletedFiltered = filteredTeams.filter((t) => t.deletedAt);

    return (
      <>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
          {activeFiltered.map((team) => {
            const status = resolveTeamStatus(
              team.teamName,
              aliveTeams,
              provisioningRuns,
              leadActivityByTeam
            );
            const teamColorSet = team.color
              ? getTeamColorSet(team.color)
              : nameColorSet(team.displayName);
            const matchesCurrentProject =
              !!currentProjectPath &&
              ((team.projectPath
                ? normalizePath(team.projectPath) === currentProjectPath
                : false) ||
                (team.projectPathHistory?.some((p) => normalizePath(p) === currentProjectPath) ??
                  false));
            return (
              <div
                key={team.teamName}
                role="button"
                tabIndex={0}
                className={`group relative cursor-pointer overflow-hidden rounded-lg border bg-[var(--color-surface)] p-4 hover:bg-[var(--color-surface-raised)] ${
                  matchesCurrentProject
                    ? 'border-emerald-500/70 ring-1 ring-emerald-500/30'
                    : 'border-[var(--color-border)]'
                }`}
                style={
                  teamColorSet
                    ? { borderLeftWidth: '3px', borderLeftColor: teamColorSet.border }
                    : undefined
                }
                onClick={() => openTeamTab(team.teamName, team.projectPath)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    openTeamTab(team.teamName, team.projectPath);
                  }
                }}
              >
                {teamColorSet ? (
                  <div
                    className="pointer-events-none absolute inset-0 z-0 rounded-lg"
                    style={{ backgroundColor: teamColorSet.badge }}
                  />
                ) : null}
                <div className={teamColorSet ? 'relative z-10' : undefined}>
                  <div className="flex items-start justify-between">
                    <div className="flex min-w-0 flex-1 items-center gap-2">
                      <h3 className="truncate text-sm font-semibold text-[var(--color-text)]">
                        {team.displayName}
                      </h3>
                      <StatusBadge status={status} />
                    </div>
                    <div className="flex shrink-0 gap-1">
                      {(status === 'active' || status === 'idle') && (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <button
                              type="button"
                              className="shrink-0 rounded p-1 text-[var(--color-text-muted)] opacity-0 transition-opacity hover:bg-amber-500/10 hover:text-amber-300 disabled:opacity-50 group-hover:opacity-100"
                              onClick={(e) => handleStopTeam(team.teamName, e)}
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
                      )}
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <button
                            type="button"
                            className="shrink-0 rounded p-1 text-[var(--color-text-muted)] opacity-0 transition-opacity hover:bg-blue-500/10 hover:text-blue-300 group-hover:opacity-100"
                            onClick={(e) => handleCopyTeam(team.teamName, e)}
                          >
                            <Copy size={14} />
                          </button>
                        </TooltipTrigger>
                        <TooltipContent side="bottom">Copy team</TooltipContent>
                      </Tooltip>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <button
                            type="button"
                            className="shrink-0 rounded p-1 text-[var(--color-text-muted)] opacity-0 transition-opacity hover:bg-red-500/10 hover:text-red-300 group-hover:opacity-100"
                            onClick={(e) => handleDeleteTeam(team.teamName, e)}
                          >
                            <Trash2 size={14} />
                          </button>
                        </TooltipTrigger>
                        <TooltipContent side="bottom">Delete team</TooltipContent>
                      </Tooltip>
                    </div>
                  </div>
                  <div className="mt-2 flex min-h-10 items-start gap-2">
                    <p className="line-clamp-2 min-w-0 flex-1 text-xs text-[var(--color-text-muted)]">
                      {team.description || 'No description'}
                    </p>
                    {team.projectPath &&
                      (() => {
                        const branch = branchByPath[normalizePath(team.projectPath)];
                        if (!branch) return null;
                        return (
                          <span
                            className="flex shrink-0 items-center gap-1 rounded bg-[var(--color-surface-raised)] px-1.5 py-0.5 text-[10px] text-[var(--color-text-muted)]"
                            title={branch}
                          >
                            <GitBranch size={10} />
                            <span className="max-w-24 truncate">{branch}</span>
                          </span>
                        );
                      })()}
                  </div>
                  <div className="mt-3 flex flex-wrap items-center gap-1.5">
                    {team.members && team.members.length > 0 ? (
                      renderMemberChips(team.members)
                    ) : team.memberCount === 0 ? (
                      <Badge variant="secondary" className="text-[10px] font-normal">
                        Solo
                      </Badge>
                    ) : (
                      <Badge variant="secondary" className="text-[10px] font-normal">
                        Members: {team.memberCount}
                      </Badge>
                    )}
                    {(() => {
                      const tc = taskCountsByTeam.get(team.teamName);
                      const pending = tc?.pending ?? 0;
                      const inProgress = tc?.inProgress ?? 0;
                      const completed = tc?.completed ?? 0;
                      const totalTasks = pending + inProgress + completed;
                      const completedRatio = totalTasks > 0 ? completed / totalTasks : 0;
                      return (
                        <div className="mt-2 w-full space-y-1.5">
                          <div className="flex items-center gap-2">
                            <div
                              className="h-1.5 flex-1 overflow-hidden rounded-full bg-[var(--color-surface-raised)]"
                              role="progressbar"
                              aria-valuenow={completed}
                              aria-valuemin={0}
                              aria-valuemax={totalTasks}
                              aria-label={`Tasks ${completed}/${totalTasks} completed`}
                            >
                              <div
                                className="h-full rounded-full bg-emerald-500 transition-all duration-200"
                                style={{ width: `${Math.round(completedRatio * 100)}%` }}
                              />
                            </div>
                            <span className="shrink-0 text-[10px] font-medium tracking-tight text-[var(--color-text-muted)]">
                              {completed}/{totalTasks}
                            </span>
                          </div>
                          {totalTasks > 0 && (
                            <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[10px] text-[var(--color-text-muted)]">
                              {inProgress > 0 && (
                                <span className="inline-flex items-center gap-1">
                                  <Play size={10} className="shrink-0 text-blue-400" />
                                  {inProgress} in_progress
                                </span>
                              )}
                              {pending > 0 && (
                                <span className="inline-flex items-center gap-1">
                                  <Clock size={10} className="shrink-0 text-amber-400" />
                                  {pending} pending
                                </span>
                              )}
                              {completed > 0 && (
                                <span className="inline-flex items-center gap-1">
                                  <CheckCircle size={10} className="shrink-0 text-emerald-400" />
                                  {completed} completed
                                </span>
                              )}
                            </div>
                          )}
                        </div>
                      );
                    })()}
                  </div>
                  {renderTeamRecentPaths(team, status)}
                </div>
              </div>
            );
          })}
        </div>

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
                      <div className="mt-3 flex flex-wrap items-center gap-1.5">
                        {renderMemberChips(team.members)}
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
      </div>
    </TooltipProvider>
  );
};
