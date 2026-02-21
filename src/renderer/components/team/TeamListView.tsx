import { useCallback, useEffect, useMemo, useState } from 'react';

import { isElectronMode } from '@renderer/api';
import { Badge } from '@renderer/components/ui/badge';
import { Button } from '@renderer/components/ui/button';
import { useStore } from '@renderer/store';
import { Trash2 } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';

import { CreateTeamDialog } from './dialogs/CreateTeamDialog';
import { TeamEmptyState } from './TeamEmptyState';

export const TeamListView = (): React.JSX.Element => {
  const electronMode = isElectronMode();
  const [showCreateDialog, setShowCreateDialog] = useState(false);
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
  const {
    connectionMode,
    createTeam,
    cancelProvisioning,
    provisioningRuns,
    activeProvisioningRunId,
    provisioningError,
  } = useStore(
    useShallow((s) => ({
      connectionMode: s.connectionMode,
      createTeam: s.createTeam,
      cancelProvisioning: s.cancelProvisioning,
      provisioningRuns: s.provisioningRuns,
      activeProvisioningRunId: s.activeProvisioningRunId,
      provisioningError: s.provisioningError,
    }))
  );
  const activeProgress = useMemo(
    () => (activeProvisioningRunId ? (provisioningRuns[activeProvisioningRunId] ?? null) : null),
    [activeProvisioningRunId, provisioningRuns]
  );
  const canCreate = electronMode && connectionMode === 'local';

  const handleDeleteTeam = useCallback(
    (teamName: string, e: React.MouseEvent) => {
      e.stopPropagation();
      const confirmed = window.confirm(`Удалить команду "${teamName}"? Это действие необратимо.`);
      if (!confirmed) {
        return;
      }
      void deleteTeam(teamName);
    },
    [deleteTeam]
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
            Teams доступен только в Electron-режиме
          </p>
          <p className="mt-2 text-xs text-[var(--color-text-muted)]">
            В browser mode доступ к локальным папкам `~/.claude/teams` недоступен.
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
      progress={activeProgress}
      existingTeamNames={teams.map((t) => t.teamName)}
      onClose={() => setShowCreateDialog(false)}
      onCreate={async (request) => {
        await createTeam(request);
      }}
      onCancelProvisioning={async (runId) => {
        await cancelProvisioning(runId);
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
            Обновить
          </Button>
        </div>
      </div>
      {!canCreate ? (
        <p className="mt-2 text-xs text-[var(--color-text-muted)]">
          Доступно только в local Electron-режиме.
        </p>
      ) : null}
    </div>
  );

  if (teamsLoading) {
    return (
      <div className="size-full overflow-auto p-4">
        {renderHeader()}
        <div className="flex size-full items-center justify-center text-sm text-[var(--color-text-muted)]">
          Загружаем команды...
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
            <p className="text-sm font-medium text-red-400">Не удалось загрузить команды</p>
            <p className="mt-2 text-xs text-[var(--color-text-muted)]">{teamsError}</p>
            <Button
              variant="outline"
              size="sm"
              className="mt-4"
              onClick={() => {
                void fetchTeams();
              }}
            >
              Повторить
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

      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
        {teams.map((team) => (
          <div
            key={team.teamName}
            role="button"
            tabIndex={0}
            className="group cursor-pointer rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4 hover:bg-[var(--color-surface-raised)]"
            onClick={() => openTeamTab(team.teamName)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                openTeamTab(team.teamName);
              }
            }}
          >
            <div className="flex items-start justify-between">
              <h3 className="truncate text-sm font-semibold text-[var(--color-text)]">
                {team.displayName}
              </h3>
              <button
                type="button"
                className="shrink-0 rounded p-1 text-[var(--color-text-muted)] opacity-0 transition-opacity hover:bg-red-500/10 hover:text-red-300 group-hover:opacity-100"
                onClick={(e) => handleDeleteTeam(team.teamName, e)}
                title="Удалить команду"
              >
                <Trash2 size={14} />
              </button>
            </div>
            <p className="mt-2 line-clamp-2 min-h-10 text-xs text-[var(--color-text-muted)]">
              {team.description || 'Без описания'}
            </p>
            <div className="mt-3 flex items-center gap-2">
              <Badge variant="secondary" className="text-[10px] font-normal">
                Участников: {team.memberCount}
              </Badge>
              <Badge variant="secondary" className="text-[10px] font-normal">
                Задач: {team.taskCount}
              </Badge>
            </div>
          </div>
        ))}
      </div>
      {createDialogElement}
    </div>
  );
};
