import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { DashboardCommandPalette, usePaletteRead } from '@features/dashboard/renderer';
import {
  buildTeamDirectoryRows,
  resolveTeamDirectoryOpenIntent,
} from '@features/team-directory/renderer';
import { Button } from '@renderer/components/ui/button';
import { FolderGit2, UsersRound } from 'lucide-react';

import type {
  HostedRecentProjectDto,
  HostedRecentProjectsResult,
} from '@features/recent-projects/contracts';
import type { OpenResult } from '@features/recent-projects/renderer/hosted';
import type { HostedTeamDirectoryRow } from '@features/team-directory/renderer';
import type { HostedTeamDirectoryReadState } from '@features/team-lifecycle/renderer';
import type { HostedWorkspaceDto } from '@features/workspace-registry/contracts';
import type { BootId, DeploymentId, TeamId, WorkspaceId } from '@shared/contracts/hosted';

export interface HostedDashboardPaletteProps {
  readonly open: boolean;
  readonly onClose: () => void;
  /** Changes whenever the principal, boot, registry admission, or grant changes. */
  readonly authorityKey: string;
  readonly authAvailable: boolean;
  readonly runtimeIdentity: Readonly<{ deploymentId: DeploymentId; bootId: BootId }> | undefined;
  readonly workspaces: readonly HostedWorkspaceDto[];
  readonly selectedWorkspaceId: WorkspaceId | null;
  /** The same directory snapshot used by the current workspace's chooser. */
  readonly directory: HostedTeamDirectoryReadState | null;
  readonly teamOpenAvailable: boolean;
  readonly loadRecent: (signal: AbortSignal) => Promise<HostedRecentProjectsResult>;
  readonly onAuthFailure?: () => void;
  readonly onSelectWorkspace: (
    workspaceId: WorkspaceId,
    expected?: HostedRecentProjectDto
  ) => Promise<OpenResult>;
  readonly onSelectTeam: (teamId: TeamId) => void;
}

interface WorkspaceRow {
  readonly kind: 'workspace';
  readonly workspace: HostedWorkspaceDto;
  readonly recent?: HostedRecentProjectDto;
  readonly authorityKey: string;
}

interface TeamRow {
  readonly kind: 'team';
  readonly row: HostedTeamDirectoryRow;
  readonly readEpoch: number;
  readonly authorityKey: string;
}

type PaletteRow = WorkspaceRow | TeamRow;

function matchesLabel(label: string, query: string): boolean {
  return label.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase());
}

const currentWorkspace = (
  expected: HostedWorkspaceDto,
  current: readonly HostedWorkspaceDto[],
  bootId: BootId | undefined
): boolean => {
  const latest = current.find((item) => item.workspaceId === expected.workspaceId);
  return (
    latest !== undefined &&
    latest.registrationRevision === expected.registrationRevision &&
    latest.mount.mountGeneration === expected.mount.mountGeneration &&
    latest.mount.bootId === bootId &&
    latest.mount.health !== 'unavailable'
  );
};

/** Hosted navigation only. It never exposes session search or agent commands. */
export const HostedDashboardPalette = ({
  open,
  onClose,
  authorityKey,
  authAvailable,
  runtimeIdentity,
  workspaces,
  selectedWorkspaceId,
  directory,
  teamOpenAvailable,
  loadRecent,
  onAuthFailure,
  onSelectWorkspace,
  onSelectTeam,
}: HostedDashboardPaletteProps): React.JSX.Element => {
  const [mode, setMode] = useState<'workspaces' | 'teams'>('workspaces');
  const [query, setQuery] = useState('');
  const [opening, setOpening] = useState(false);
  const [openError, setOpenError] = useState<string | null>(null);
  const [pendingWorkspaceId, setPendingWorkspaceId] = useState<WorkspaceId | null>(null);
  const generation = useRef(0);
  const wasOpen = useRef(false);
  const recentPort = useRef({ loadRecent, onAuthFailure });
  recentPort.current = { loadRecent, onAuthFailure };
  const current = useRef({
    authorityKey,
    authAvailable,
    runtimeIdentity,
    workspaces,
    selectedWorkspaceId,
    directory,
    teamOpenAvailable,
  });
  current.current = {
    authorityKey,
    authAvailable,
    runtimeIdentity,
    workspaces,
    selectedWorkspaceId,
    directory,
    teamOpenAvailable,
  };

  useEffect(() => {
    if (open && !wasOpen.current) {
      setMode('workspaces');
      setQuery('');
      setOpenError(null);
      setPendingWorkspaceId(null);
    }
    if (!open) {
      generation.current += 1;
      setOpening(false);
    }
    wasOpen.current = open;
  }, [open]);
  useEffect(() => {
    setOpenError(null);
  }, [authorityKey]);

  const readRecent = useCallback(
    async (signal: AbortSignal) => {
      try {
        const result = await recentPort.current.loadRecent(signal);
        if (
          result.kind !== 'recent-projects' ||
          result.deploymentId !== runtimeIdentity?.deploymentId ||
          result.bootId !== runtimeIdentity.bootId
        )
          throw new Error('source_unavailable');
        return {
          rows: result.projects,
          total: result.projects.length,
          partial: result.completeness === 'partial',
        };
      } catch (error) {
        if (
          !signal.aborted &&
          error instanceof Error &&
          error.message === 'authentication_required'
        ) {
          recentPort.current.onAuthFailure?.();
        }
        throw error;
      }
    },
    [runtimeIdentity?.bootId, runtimeIdentity?.deploymentId]
  );
  const workspaceVersion = workspaces
    .map(
      (workspace) =>
        `${workspace.workspaceId}:${workspace.registrationRevision}:${workspace.mount.mountGeneration}`
    )
    .join('|');
  const recent = usePaletteRead(
    JSON.stringify([open, authorityKey, workspaceVersion]),
    open && authAvailable && runtimeIdentity !== undefined,
    0,
    readRecent
  );

  const rows = useMemo<PaletteRow[]>(() => {
    if (!authAvailable || !runtimeIdentity) return [];
    if (mode === 'workspaces') {
      const recentById = new Map(recent.rows.map((project) => [project.workspaceId, project]));
      return [...workspaces]
        .filter(
          (workspace) =>
            currentWorkspace(workspace, workspaces, runtimeIdentity.bootId) &&
            matchesLabel(workspace.label, query)
        )
        .sort(
          (a, b) =>
            Number(recentById.has(b.workspaceId)) - Number(recentById.has(a.workspaceId)) ||
            a.label.localeCompare(b.label)
        )
        .map((workspace): WorkspaceRow => {
          const project = recentById.get(workspace.workspaceId);
          const recentProject =
            project &&
            project.registrationRevision === workspace.registrationRevision &&
            project.mountGeneration === workspace.mount.mountGeneration &&
            project.openAvailability === 'available'
              ? project
              : undefined;
          return { kind: 'workspace', workspace, recent: recentProject, authorityKey };
        });
    }
    if (
      !teamOpenAvailable ||
      selectedWorkspaceId === null ||
      (pendingWorkspaceId !== null && pendingWorkspaceId !== selectedWorkspaceId) ||
      directory?.scopeKey !== selectedWorkspaceId ||
      !directory.snapshot ||
      directory.freshness === 'failed'
    )
      return [];
    const teamRows: HostedTeamDirectoryRow[] = directory.snapshot.items.map((item) => ({
      source: 'hosted',
      scopeKey: item.workspaceId,
      targetKey: item.teamId,
      displayName: item.displayName,
      runtime: directory.runtime.byTeamId.get(item.teamId)?.runtime ?? 'unknown',
    }));
    return buildTeamDirectoryRows(teamRows, { query, selectedStatuses: new Set() }).map(
      (row): TeamRow => ({
        kind: 'team',
        row,
        readEpoch: directory.snapshot!.readEpoch,
        authorityKey,
      })
    );
  }, [
    authAvailable,
    runtimeIdentity,
    mode,
    recent.rows,
    workspaces,
    query,
    authorityKey,
    teamOpenAvailable,
    selectedWorkspaceId,
    pendingWorkspaceId,
    directory,
  ]);

  const handleSelect = useCallback(
    async (result: PaletteRow) => {
      const latest = current.current;
      if (
        opening ||
        openError ||
        !latest.authAvailable ||
        result.authorityKey !== latest.authorityKey
      )
        return;
      if (result.kind === 'team') {
        const state = latest.directory;
        if (
          !latest.teamOpenAvailable ||
          !state?.snapshot ||
          state.scopeKey !== latest.selectedWorkspaceId ||
          state.freshness === 'failed'
        )
          return;
        const teamRows: HostedTeamDirectoryRow[] = state.snapshot.items.map((item) => ({
          source: 'hosted',
          scopeKey: item.workspaceId,
          targetKey: item.teamId,
          displayName: item.displayName,
          runtime: state.runtime.byTeamId.get(item.teamId)?.runtime ?? 'unknown',
        }));
        const resolved = resolveTeamDirectoryOpenIntent(
          {
            scopeKey: result.row.scopeKey,
            targetKey: result.row.targetKey,
            readEpoch: result.readEpoch,
          },
          { scopeKey: state.scopeKey, readEpoch: state.snapshot.readEpoch, rows: teamRows }
        );
        if (!resolved) return;
        onSelectTeam(resolved.targetKey as TeamId);
        onClose();
        return;
      }
      if (!currentWorkspace(result.workspace, latest.workspaces, latest.runtimeIdentity?.bootId))
        return;
      const request = ++generation.current;
      setOpening(true);
      setOpenError(null);
      try {
        const outcome = await onSelectWorkspace(result.workspace.workspaceId, result.recent);
        if (generation.current !== request) return;
        if (outcome.kind !== 'opened' && current.current.authorityKey !== result.authorityKey)
          return;
        if (outcome.kind === 'opened') {
          setPendingWorkspaceId(result.workspace.workspaceId);
          setMode('teams');
          setQuery('');
        } else if (outcome.kind === 'failed') {
          setOpenError(outcome.message);
        } else if (outcome.kind === 'stale_target') {
          setOpenError('Workspace changed. Refresh and try again.');
        }
      } finally {
        if (generation.current === request) setOpening(false);
      }
    },
    [onClose, onSelectTeam, onSelectWorkspace, openError, opening]
  );

  return (
    <DashboardCommandPalette<PaletteRow>
      open={open}
      onClose={onClose}
      query={query}
      onQueryChange={(value) => {
        generation.current += 1;
        setOpening(false);
        setOpenError(null);
        setQuery(value);
      }}
      modeKey={mode}
      title={mode === 'workspaces' ? 'Find a workspace' : 'Find a team'}
      description={
        mode === 'workspaces'
          ? 'Select an available workspace to browse its teams.'
          : 'Select a team in the current workspace.'
      }
      modeLabel={mode === 'workspaces' ? 'Workspaces' : 'Teams'}
      placeholder={mode === 'workspaces' ? 'Search workspaces' : 'Search teams'}
      rows={openError ? [] : rows}
      getRowKey={(row) =>
        row.kind === 'workspace' ? row.workspace.workspaceId : row.row.targetKey
      }
      renderRow={(row, _index, selected, onClick) => (
        <button
          type="button"
          onClick={onClick}
          disabled={opening}
          className={`flex w-full items-center gap-3 px-4 py-3 text-left ${
            selected ? 'bg-surface-raised' : 'hover:bg-surface-raised/50'
          }`}
        >
          {row.kind === 'workspace' ? (
            <FolderGit2 className="size-4 shrink-0" aria-hidden="true" />
          ) : (
            <UsersRound className="size-4 shrink-0" aria-hidden="true" />
          )}
          <span className="min-w-0 flex-1 truncate text-sm">
            {row.kind === 'workspace' ? row.workspace.label : row.row.displayName}
          </span>
          {row.kind === 'workspace' && row.recent ? (
            <span className="text-xs text-text-muted">Recent</span>
          ) : null}
        </button>
      )}
      onSelect={(row) => {
        void handleSelect(row);
      }}
      empty={
        opening
          ? 'Opening workspace...'
          : mode === 'workspaces'
            ? query.trim()
              ? 'No matching workspaces.'
              : 'No available workspaces.'
            : !teamOpenAvailable || !directory?.snapshot
              ? 'Teams are loading or unavailable.'
              : query.trim()
                ? 'No matching teams.'
                : 'No teams in this workspace.'
      }
      error={openError}
      loading={opening || (mode === 'workspaces' && recent.loading)}
      focusInput={
        typeof window !== 'undefined' && window.matchMedia?.('(pointer: fine)').matches === true
      }
      headerAction={
        openError ? (
          <Button type="button" variant="ghost" size="sm" onClick={() => setOpenError(null)}>
            Retry
          </Button>
        ) : mode === 'teams' ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => {
              setMode('workspaces');
              setQuery('');
              setPendingWorkspaceId(null);
            }}
          >
            All workspaces
          </Button>
        ) : null
      }
      footer={
        <span>
          {mode === 'workspaces'
            ? 'Choose a workspace, then a team'
            : directory?.runtime.phase === 'incomplete'
              ? 'Some team statuses are unavailable'
              : 'Open a team in this workspace'}
          {recent.partial && mode === 'workspaces' ? ' · Recent activity is partial' : ''}
          {recent.error && mode === 'workspaces' ? ' · Recent activity is unavailable' : ''}
        </span>
      }
    />
  );
};
