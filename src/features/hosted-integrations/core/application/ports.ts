import type {
  BootstrapHostedWorkspaceRequestDto,
  CompleteHostedPairingRequestDto,
  DisableHostedGitHubRepositoryTargetRequestDto,
  EnableHostedGitHubRepositoryTargetRequestDto,
  HostedGitHubActionCommandDto,
  HostedGitHubActionRequestEnvelopeDto,
  HostedGitHubActionStatusDto,
  HostedGitHubAvailableRepositoryDto,
  HostedGitHubConnectionDto,
  HostedGitHubRepositoryTargetDto,
  HostedGitHubSetupSessionDto,
  HostedIntegrationDesktopSessionDto,
  HostedIntegrationStateDto,
  ListAvailableHostedGitHubRepositoriesRequestDto,
  OpenHostedGitHubSetupUrlRequestDto,
  StartHostedPairingResponseDto,
} from '../../contracts';
import type { NormalizedControlPlaneBaseUrl } from '../domain';

export interface HostedIntegrationClockPort {
  now(): Date;
}

export interface HostedWorkspaceBindingStorePort {
  readState(): Promise<HostedIntegrationStateDto>;
  saveControlPlaneBaseUrl(baseUrl: NormalizedControlPlaneBaseUrl): Promise<void>;
  saveSession(session: HostedIntegrationDesktopSessionDto): Promise<void>;
  saveSetupSession(setup: HostedGitHubSetupSessionDto | null): Promise<void>;
  saveConnections(connections: readonly HostedGitHubConnectionDto[]): Promise<void>;
  saveTargets(targets: readonly HostedGitHubRepositoryTargetDto[]): Promise<void>;
  saveActionStatus(status: HostedGitHubActionStatusDto): Promise<void>;
  markSessionRevoked(): Promise<HostedIntegrationDesktopSessionDto | null>;
}

export interface DesktopSecureTokenStorePort {
  isAvailable(): Promise<boolean>;
  readToken(): Promise<string | null>;
  writeToken(token: string): Promise<void>;
  clearToken(): Promise<void>;
}

export interface DesktopBrowserOpenPort {
  openExternal(url: URL): Promise<void>;
}

export interface ControlPlaneConnectionPort {
  getMe(token: string): Promise<HostedIntegrationDesktopSessionDto>;
  bootstrapWorkspace(
    input: BootstrapHostedWorkspaceRequestDto
  ): Promise<{ session: HostedIntegrationDesktopSessionDto; token: string }>;
  rotateSessionToken(
    token: string,
    desktopClientId: string,
    rotationRequestId: string
  ): Promise<{ token: string }>;
  revokeSession(token: string, desktopClientId: string): Promise<void>;
}

export interface ControlPlanePairingPort {
  startPairing(token: string): Promise<StartHostedPairingResponseDto>;
  completePairing(
    input: CompleteHostedPairingRequestDto
  ): Promise<{ session: HostedIntegrationDesktopSessionDto; token: string }>;
}

export interface ControlPlaneGithubSetupPort {
  startGitHubSetup(token: string): Promise<HostedGitHubSetupSessionDto>;
  getGitHubSetupStatus(token: string, setupSessionId: string): Promise<HostedGitHubSetupSessionDto>;
}

export interface ControlPlaneGithubTargetsPort {
  listConnections(token: string): Promise<readonly HostedGitHubConnectionDto[]>;
  listAvailableRepositories(
    token: string,
    input: ListAvailableHostedGitHubRepositoriesRequestDto
  ): Promise<readonly HostedGitHubAvailableRepositoryDto[]>;
  listTargets(token: string): Promise<readonly HostedGitHubRepositoryTargetDto[]>;
  enableTarget(
    token: string,
    input: EnableHostedGitHubRepositoryTargetRequestDto
  ): Promise<HostedGitHubRepositoryTargetDto>;
  disableTarget(
    token: string,
    input: DisableHostedGitHubRepositoryTargetRequestDto
  ): Promise<HostedGitHubRepositoryTargetDto>;
}

export interface ControlPlaneAgentActionPort {
  submitAgentGithubAction(
    token: string,
    envelope: HostedGitHubActionRequestEnvelopeDto
  ): Promise<HostedGitHubActionStatusDto>;
  getAgentGithubActionStatus(
    token: string,
    actionRequestId: string
  ): Promise<HostedGitHubActionStatusDto>;
}

export interface HostedIntegrationIdGeneratorPort {
  stableActionRequestId(input: HostedGitHubActionCommandDto): Promise<string>;
}

export interface HostedIntegrationUseCasePorts {
  readonly browserOpen: DesktopBrowserOpenPort;
  readonly clock: HostedIntegrationClockPort;
  readonly connection: ControlPlaneConnectionPort;
  readonly idGenerator: HostedIntegrationIdGeneratorPort;
  readonly pairing: ControlPlanePairingPort;
  readonly setup: ControlPlaneGithubSetupPort;
  readonly stateStore: HostedWorkspaceBindingStorePort;
  readonly targets: ControlPlaneGithubTargetsPort;
  readonly tokenStore: DesktopSecureTokenStorePort;
  readonly actions: ControlPlaneAgentActionPort;
}

export type { OpenHostedGitHubSetupUrlRequestDto };
