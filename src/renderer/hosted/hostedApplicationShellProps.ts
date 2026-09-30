import type {
  HostedTeamConfigurationFetchPort,
  HostedTeamConfigurationTransport,
} from '@features/team-configuration/renderer';
import type {
  HostedWorkspaceRegistryFetchPort,
  HostedWorkspaceRegistryRendererPort,
} from '@features/workspace-registry/renderer';
import type {
  HostedTeamCoordinationEventPorts,
  HostedTeamWorkspaceProps,
} from '@renderer/components/team/HostedTeamWorkspace';
import type { BootId, DeploymentId } from '@shared/contracts/hosted';

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
    | 'createRegistry'
    | 'createAuthorityEpoch'
    | 'authEffectsAvailable'
    | 'writeEffectsAvailable'
    | 'onProtectedAuthFailure'
  >;
  readonly runtimeIdentity?: Readonly<{ deploymentId: DeploymentId; bootId: BootId }>;
  readonly dashboardFetch?: typeof fetch;
}
