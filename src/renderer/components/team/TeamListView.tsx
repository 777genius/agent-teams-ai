import { useCallback, useEffect, useMemo, useState } from 'react';

import { api, isElectronMode } from '@renderer/api';
import { Badge } from '@renderer/components/ui/badge';
import { Button } from '@renderer/components/ui/button';
import { Input } from '@renderer/components/ui/input';
import { getTeamColorSet } from '@renderer/constants/teamColors';
import { useStore } from '@renderer/store';
import { Copy, FolderOpen, Search, Trash2 } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';

import { CreateTeamDialog } from './dialogs/CreateTeamDialog';
import { TeamEmptyState } from './TeamEmptyState';

import type { TeamCopyData } from './dialogs/CreateTeamDialog';
import type { TeamProvisioningProgress, TeamSummary } from '@shared/types';

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

type TeamStatus = 'running' | 'provisioning' | 'offline';

function getRecentProjects(team: TeamSummary): string[] {
  const history = team.projectPathHistory;
  if (!history || history.length === 0) {
    return team.projectPath ? [team.projectPath] : [];
  }
  return history.slice(-3).reverse();
}

function folderName(fullPath: string): string {
  // eslint-disable-next-line sonarjs/slow-regex -- Anchored regex on short path strings, no backtracking risk
  const parts = fullPath.replace(/\/+$/, '').split('/');
  return parts[parts.length - 1] || fullPath;
}

function resolveTeamStatus(
  teamName: string,
  aliveTeams: string[],
  provisioningRuns: Record<string, TeamProvisioningProgress>
): TeamStatus {
  if (aliveTeams.includes(teamName)) {
    return 'running';
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
    case 'running':
      return (
        <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] font-medium text-emerald-400">
          <span className="size-1.5 animate-pulse rounded-full bg-emerald-400" />
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
  const [aliveTeams, setAliveTeams] = useState<string[]>([]);
  const { teams, teamsLoading, teamsError, fetchTeams, openTeamTab, deleteTeam } = useStore(
    useShallow((s) => ({
      teams: s.teams,
      teamsLoading: s.teamsLoading,
      teamsError: s.teamsError,
      fetchTeams: s.fetchTeams,
      openTeamTab: s.openTeamTab,
      deleteTeam: s.deleteTeam,
    }))
  );
  const { connectionMode, createTeam, provisioningError, provisioningRuns } = useStore(
    useShallow((s) => ({
      connectionMode: s.connectionMode,
      createTeam: s.createTeam,
      provisioningError: s.provisioningError,
      provisioningRuns: s.provisioningRuns,
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

  const filteredTeams = useMemo<TeamSummary[]>(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return teams;
    return teams.filter(
      (t) =>
        t.teamName.toLowerCase().includes(q) ||
        t.displayName.toLowerCase().includes(q) ||
        t.description.toLowerCase().includes(q)
    );
  }, [teams, searchQuery]);

  const handleDeleteTeam = useCallback(
    (teamName: string, e: React.MouseEvent) => {
      e.stopPropagation();
      const confirmed = window.confirm(`Delete team "${teamName}"? This action is irreversible.`);
      if (!confirmed) {
        return;
      }
      void deleteTeam(teamName);
    },
    [deleteTeam]
  );

  const handleCopyTeam = useCallback(
    (teamName: string, e: React.MouseEvent) => {
      e.stopPropagation();
      void (async () => {
        try {
          const data = await api.teams.getData(teamName);
          const existingNames = teams.map((t) => t.teamName);
          const uniqueName = generateUniqueName(teamName, existingNames);
          const members = (data.config.members ?? []).map((m) => ({
            name: m.name,
            role: m.role,
          }));
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

  useEffect(() => {
    if (!electronMode) {
      return;
    }
    void fetchTeams();
  }, [electronMode, fetchTeams]);

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
      initialData={copyData ?? undefined}
      onClose={() => {
        setShowCreateDialog(false);
        setCopyData(null);
      }}
      onCreate={async (request) => {
        await createTeam(request);
      }}
      onOpenTeam={openTeamTab}
    />
  );

  const renderHeader = (): React.JSX.Element => (
    <div className="mb-4">
      <div className="flex items-center justify-between">
        <h2 className="text-base font-semibold text-[var(--color-text)]">Teams</h2>
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
        <div className="relative mt-3">
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
      ) : null}
    </div>
  );

  if (teamsLoading) {
    return (
      <div className="size-full overflow-auto p-4">
        {renderHeader()}
        <div className="flex size-full items-center justify-center text-sm text-[var(--color-text-muted)]">
          Loading teams...
        </div>
        {createDialogElement}
      </div>
    );
  }

  if (teamsError) {
    return (
      <div className="size-full overflow-auto p-4">
        {renderHeader()}
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
        {createDialogElement}
      </div>
    );
  }

  if (teams.length === 0) {
    return (
      <div className="size-full overflow-auto p-4">
        {renderHeader()}
        <TeamEmptyState />
        {createDialogElement}
      </div>
    );
  }

  return (
    <div className="size-full overflow-auto p-4">
      {renderHeader()}

      {filteredTeams.length === 0 && searchQuery.trim() ? (
        <div className="flex items-center justify-center py-12 text-sm text-[var(--color-text-muted)]">
          No teams matching &quot;{searchQuery.trim()}&quot;
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
          {filteredTeams.map((team) => {
            const status = resolveTeamStatus(team.teamName, aliveTeams, provisioningRuns);
            const teamColorSet = team.color ? getTeamColorSet(team.color) : null;
            return (
              <div
                key={team.teamName}
                role="button"
                tabIndex={0}
                className="group relative cursor-pointer overflow-hidden rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4 hover:bg-[var(--color-surface-raised)]"
                style={
                  teamColorSet
                    ? { borderLeftWidth: '3px', borderLeftColor: teamColorSet.border }
                    : undefined
                }
                onClick={() => openTeamTab(team.teamName)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    openTeamTab(team.teamName);
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
                      <button
                        type="button"
                        className="shrink-0 rounded p-1 text-[var(--color-text-muted)] opacity-0 transition-opacity hover:bg-blue-500/10 hover:text-blue-300 group-hover:opacity-100"
                        onClick={(e) => handleCopyTeam(team.teamName, e)}
                        title="Copy team"
                      >
                        <Copy size={14} />
                      </button>
                      <button
                        type="button"
                        className="shrink-0 rounded p-1 text-[var(--color-text-muted)] opacity-0 transition-opacity hover:bg-red-500/10 hover:text-red-300 group-hover:opacity-100"
                        onClick={(e) => handleDeleteTeam(team.teamName, e)}
                        title="Delete team"
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </div>
                  <p className="mt-2 line-clamp-2 min-h-10 text-xs text-[var(--color-text-muted)]">
                    {team.description || 'No description'}
                  </p>
                  <div className="mt-3 flex flex-wrap items-center gap-1.5">
                    {team.members && team.members.length > 0 ? (
                      team.members.map((m) => {
                        const memberColor = m.color ? getTeamColorSet(m.color) : null;
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
                              <span className="text-[9px] text-[var(--color-text-muted)]">
                                {m.role}
                              </span>
                            ) : null}
                          </span>
                        );
                      })
                    ) : (
                      <Badge variant="secondary" className="text-[10px] font-normal">
                        Members: {team.memberCount}
                      </Badge>
                    )}
                    <Badge variant="secondary" className="text-[10px] font-normal">
                      Tasks: {team.taskCount}
                    </Badge>
                  </div>
                  {(() => {
                    const projects = getRecentProjects(team);
                    if (projects.length === 0) return null;
                    return (
                      <div className="mt-2 flex items-center gap-1 text-[10px] text-[var(--color-text-muted)]">
                        <FolderOpen size={10} className="shrink-0" />
                        <span className="truncate">
                          {projects.map((p, i) => (
                            <span key={p} title={p}>
                              {i === 0 && status === 'running' ? (
                                <span className="text-emerald-400">{folderName(p)}</span>
                              ) : (
                                folderName(p)
                              )}
                              {i < projects.length - 1 ? ', ' : ''}
                            </span>
                          ))}
                        </span>
                      </div>
                    );
                  })()}
                </div>
              </div>
            );
          })}
        </div>
      )}
      {createDialogElement}
    </div>
  );
};
