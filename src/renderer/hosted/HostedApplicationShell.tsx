import { useEffect, useMemo, useRef, useState } from 'react';

import { getHostedCsrfToken } from '@features/hosted-access/renderer';
import { createHostedTeamConfigurationTransport } from '@features/team-configuration/renderer';
import {
  createHostedWorkspaceRegistryTransport,
  HostedWorkspaceRegistryTransportError,
} from '@features/workspace-registry/renderer';
import { HostedTeamWorkspace } from '@renderer/components/team/HostedTeamWorkspace';
import { Button } from '@renderer/components/ui/button';
import { HostedProductionOperatorPanel } from '@renderer/hosted/HostedProductionOperatorPanel';
import { createHostedBrowserTeamCoordinationEventPorts } from '@renderer/hosted/hostedTeamCoordinationEventPorts';

import type {
  HostedTeamConfigurationFetchPort,
  HostedTeamConfigurationTransport,
} from '@features/team-configuration/renderer';
import type { HostedWorkspaceDto } from '@features/workspace-registry/contracts';
import type {
  HostedWorkspaceRegistryFetchPort,
  HostedWorkspaceRegistryRendererPort,
} from '@features/workspace-registry/renderer';
import type {
  HostedTeamCoordinationEventPorts,
  HostedTeamWorkspaceProps,
} from '@renderer/components/team/HostedTeamWorkspace';
import type { BootId, DeploymentId, TeamId, WorkspaceId } from '@shared/contracts/hosted';

export interface HostedApplicationShellProps {
  readonly workspaceTransport?: HostedWorkspaceRegistryRendererPort;
  readonly workspaceFetch?: HostedWorkspaceRegistryFetchPort;
  readonly configurationTransport?: HostedTeamConfigurationTransport;
  readonly configurationFetch?: HostedTeamConfigurationFetchPort;
  readonly getCsrfToken?: () => string | null;
  readonly coordinationEvents?: HostedTeamCoordinationEventPorts;
  readonly teamWorkspaceProps?: Omit<
    HostedTeamWorkspaceProps,
    | 'workspaceId'
    | 'configurationTransport'
    | 'configurationFetch'
    | 'getCsrfToken'
    | 'coordinationEvents'
  >;
  readonly runtimeIdentity?: Readonly<{ deploymentId: DeploymentId; bootId: BootId }>;
}

const workspaceFetch: HostedWorkspaceRegistryFetchPort = (input, init) => fetch(input, init);
const configurationFetch: HostedTeamConfigurationFetchPort = (input, init) => fetch(input, init);

function loadErrorText(error: unknown): string {
  return error instanceof HostedWorkspaceRegistryTransportError &&
    error.code === 'request_cancelled'
    ? 'Workspace loading was cancelled.'
    : 'Registered workspaces could not be loaded.';
}

export const HostedApplicationShell = ({
  workspaceTransport: providedWorkspaceTransport,
  workspaceFetch: providedWorkspaceFetch = workspaceFetch,
  configurationTransport: providedConfigurationTransport,
  configurationFetch: providedConfigurationFetch = configurationFetch,
  getCsrfToken = getHostedCsrfToken,
  coordinationEvents: providedCoordinationEvents,
  teamWorkspaceProps,
  runtimeIdentity,
}: HostedApplicationShellProps): React.JSX.Element => {
  const [workspaces, setWorkspaces] = useState<readonly HostedWorkspaceDto[]>([]);
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<WorkspaceId | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectingWorkspaceId, setSelectingWorkspaceId] = useState<WorkspaceId | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedTeamId, setSelectedTeamId] = useState<TeamId | null>(null);
  const requestGeneration = useRef(0);
  const activeRequest = useRef<AbortController | null>(null);
  const workspaceTransport = useMemo(
    () =>
      providedWorkspaceTransport ??
      createHostedWorkspaceRegistryTransport({
        fetch: providedWorkspaceFetch,
        getCsrfToken,
      }),
    [getCsrfToken, providedWorkspaceFetch, providedWorkspaceTransport]
  );
  const configurationTransport = useMemo(
    () =>
      providedConfigurationTransport ??
      createHostedTeamConfigurationTransport({
        fetch: providedConfigurationFetch,
        getCsrfToken,
      }),
    [getCsrfToken, providedConfigurationFetch, providedConfigurationTransport]
  );
  const coordinationEvents = useMemo(
    () => providedCoordinationEvents ?? createHostedBrowserTeamCoordinationEventPorts(getCsrfToken),
    [getCsrfToken, providedCoordinationEvents]
  );

  const loadWorkspaces = (): void => {
    activeRequest.current?.abort();
    const controller = new AbortController();
    const generation = ++requestGeneration.current;
    activeRequest.current = controller;
    setLoading(true);
    setSelectingWorkspaceId(null);
    setError(null);
    void workspaceTransport
      .list(controller.signal)
      .then((result) => {
        if (controller.signal.aborted || requestGeneration.current !== generation) return;
        setWorkspaces(result.workspaces);
        setSelectedWorkspaceId((current) =>
          current !== null && result.workspaces.some((item) => item.workspaceId === current)
            ? current
            : null
        );
        setSelectedTeamId(null);
      })
      .catch((caught) => {
        if (controller.signal.aborted || requestGeneration.current !== generation) return;
        setError(loadErrorText(caught));
      })
      .finally(() => {
        if (!controller.signal.aborted && requestGeneration.current === generation)
          setLoading(false);
      });
  };

  useEffect(() => {
    loadWorkspaces();
    return () => activeRequest.current?.abort();
    // The transport identity is the complete load dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceTransport]);

  const selectWorkspace = (workspaceId: WorkspaceId): void => {
    setSelectedTeamId(null);
    activeRequest.current?.abort();
    const controller = new AbortController();
    const generation = ++requestGeneration.current;
    activeRequest.current = controller;
    setSelectingWorkspaceId(workspaceId);
    setError(null);
    void workspaceTransport
      .select(workspaceId, controller.signal)
      .then((result) => {
        if (controller.signal.aborted || requestGeneration.current !== generation) return;
        setSelectedWorkspaceId(result.workspace.workspaceId);
      })
      .catch((caught) => {
        if (controller.signal.aborted || requestGeneration.current !== generation) return;
        setError(loadErrorText(caught));
      })
      .finally(() => {
        if (!controller.signal.aborted && requestGeneration.current === generation) {
          setSelectingWorkspaceId(null);
        }
      });
  };

  return (
    <main className="grid size-full min-h-0 grid-rows-[auto_minmax(0,1fr)]">
      <header className="border-b border-[var(--color-border)] p-3">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="mr-2 text-base font-semibold">Hosted team workspace</h1>
          {workspaces.map((workspace) => (
            <Button
              key={workspace.workspaceId}
              type="button"
              size="sm"
              variant={selectedWorkspaceId === workspace.workspaceId ? 'default' : 'outline'}
              aria-pressed={selectedWorkspaceId === workspace.workspaceId}
              disabled={workspace.mount.health === 'unavailable' || selectingWorkspaceId !== null}
              onClick={() => selectWorkspace(workspace.workspaceId)}
            >
              {workspace.label}
            </Button>
          ))}
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={loading}
            onClick={loadWorkspaces}
          >
            Refresh workspaces
          </Button>
        </div>
        {loading ? (
          <p role="status" className="mt-2 text-sm">
            Loading registered workspaces…
          </p>
        ) : null}
        {!loading && workspaces.length === 0 && error === null ? (
          <p role="status" className="mt-2 text-sm">
            No registered workspaces are available.
          </p>
        ) : null}
        {error === null ? null : (
          <p role="alert" className="mt-2 text-sm">
            {error}
          </p>
        )}
      </header>

      {selectedWorkspaceId === null ? (
        <div className="flex items-center justify-center p-6 text-center">
          <p role="status" className="text-sm text-[var(--color-text-muted)]">
            Select a registered workspace to create or configure a team.
          </p>
        </div>
      ) : (
        <HostedTeamWorkspace
          key={selectedWorkspaceId}
          {...teamWorkspaceProps}
          workspaceId={selectedWorkspaceId}
          configurationTransport={configurationTransport}
          coordinationEvents={coordinationEvents}
          getCsrfToken={getCsrfToken}
          selectedTeamId={selectedTeamId}
          onSelectedTeamIdChange={setSelectedTeamId}
          operatorPanel={
            runtimeIdentity === undefined || selectedTeamId === null ? undefined : (
              <HostedProductionOperatorPanel
                key={`${selectedWorkspaceId}:${selectedTeamId}`}
                teamId={selectedTeamId}
                workspaceId={selectedWorkspaceId}
                runtimeIdentity={runtimeIdentity}
                getCsrfToken={getCsrfToken}
              />
            )
          }
        />
      )}
    </main>
  );
};
