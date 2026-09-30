import { Button } from '@renderer/components/ui/button';

import type { HostedWorkspaceDto } from '@features/workspace-registry/contracts';
import type { WorkspaceId } from '@shared/contracts/hosted';

export interface HostedShellHeaderProps {
  readonly page: 'dashboard' | 'chooser' | 'team';
  readonly selectedWorkspaceId: WorkspaceId | null;
  readonly workspaces: readonly HostedWorkspaceDto[];
  readonly selectingWorkspaceId: WorkspaceId | null;
  readonly loading: boolean;
  readonly error: string | null;
  readonly accessError: string | null;
  readonly teamAdmissionError: boolean;
  readonly authBlocked: boolean;
  readonly onNavigate: (page: 'dashboard' | 'chooser' | 'team') => void;
  readonly onSelectWorkspace: (workspaceId: WorkspaceId) => void;
  readonly onRefreshWorkspaces: () => void;
  readonly onRetryAuth: () => void;
  readonly onRetryProjection: () => void;
  readonly onRetryTeamAdmission: () => void;
}

export const HostedShellHeader = ({
  page,
  selectedWorkspaceId,
  workspaces,
  selectingWorkspaceId,
  loading,
  error,
  accessError,
  teamAdmissionError,
  authBlocked,
  onNavigate,
  onSelectWorkspace,
  onRefreshWorkspaces,
  onRetryAuth,
  onRetryProjection,
  onRetryTeamAdmission,
}: HostedShellHeaderProps): React.JSX.Element => (
  <header className="border-b border-[var(--color-border)] p-3">
    <div className="flex flex-wrap items-center gap-2">
      <h1 className="mr-2 text-base font-semibold">Hosted team workspace</h1>
      <Button
        type="button"
        size="sm"
        variant={page === 'dashboard' ? 'default' : 'outline'}
        onClick={() => onNavigate('dashboard')}
      >
        Dashboard
      </Button>
      <Button
        type="button"
        size="sm"
        variant={page === 'chooser' ? 'default' : 'outline'}
        onClick={() => onNavigate('chooser')}
      >
        All workspaces
      </Button>
      {selectedWorkspaceId && (
        <Button
          type="button"
          size="sm"
          variant={page === 'team' ? 'default' : 'outline'}
          onClick={() => onNavigate('team')}
        >
          Teams
        </Button>
      )}
      {workspaces.map((workspace) => (
        <Button
          key={workspace.workspaceId}
          type="button"
          size="sm"
          variant={selectedWorkspaceId === workspace.workspaceId ? 'default' : 'outline'}
          aria-pressed={selectedWorkspaceId === workspace.workspaceId}
          disabled={
            authBlocked || workspace.mount.health === 'unavailable' || selectingWorkspaceId !== null
          }
          onClick={() => onSelectWorkspace(workspace.workspaceId)}
        >
          {workspace.label}
        </Button>
      ))}
      <Button
        type="button"
        size="sm"
        variant="ghost"
        disabled={loading || authBlocked}
        onClick={onRefreshWorkspaces}
      >
        Refresh workspaces
      </Button>
    </div>
    {loading && (
      <p role="status" className="mt-2 text-sm">
        Loading registered workspaces…
      </p>
    )}
    {!loading && workspaces.length === 0 && error === null && (
      <p role="status" className="mt-2 text-sm">
        No registered workspaces are available.
      </p>
    )}
    {error && (
      <p role="alert" className="mt-2 text-sm">
        {error}
      </p>
    )}
    {authBlocked && (
      <div role="alert" className="mt-2 flex items-center gap-2 text-sm">
        <span>Access must be checked before more team actions.</span>
        <Button type="button" size="sm" variant="outline" onClick={onRetryAuth}>
          Retry access
        </Button>
      </div>
    )}
    {accessError && (
      <div role="alert" className="mt-2 flex items-center gap-2 text-sm">
        <span>{accessError}</span>
        <Button type="button" size="sm" variant="outline" onClick={onRetryProjection}>
          Retry workspace access
        </Button>
      </div>
    )}
    {teamAdmissionError && (
      <div role="alert" className="mt-2 flex items-center gap-2 text-sm">
        <span>Team access could not be checked.</span>
        <Button type="button" size="sm" variant="outline" onClick={onRetryTeamAdmission}>
          Retry team access
        </Button>
      </div>
    )}
  </header>
);
