import type {
  BootstrapHostedWorkspaceRequestDto,
  CompleteHostedPairingRequestDto,
  ConfigureHostedIntegrationRequestDto,
  DisableHostedGitHubRepositoryTargetRequestDto,
  EnableHostedGitHubRepositoryTargetRequestDto,
  GetHostedGitHubActionStatusRequestDto,
  HostedGitHubActionStatusDto,
  HostedGitHubAvailableRepositoryDto,
  HostedGitHubConnectionDto,
  HostedGitHubRepositoryTargetDto,
  HostedGitHubSetupSessionDto,
  HostedIntegrationDesktopSessionDto,
  HostedIntegrationStateDto,
  ListAvailableHostedGitHubRepositoriesRequestDto,
  OpenHostedGitHubSetupUrlRequestDto,
  RefreshGitHubSetupRequestDto,
  StartHostedPairingResponseDto,
} from './dto';

export interface HostedIntegrationsElectronApi {
  getState(): Promise<HostedIntegrationStateDto>;
  configure(input: ConfigureHostedIntegrationRequestDto): Promise<HostedIntegrationStateDto>;
  bootstrapWorkspace(input: BootstrapHostedWorkspaceRequestDto): Promise<HostedIntegrationStateDto>;
  startPairing(): Promise<StartHostedPairingResponseDto>;
  completePairing(input: CompleteHostedPairingRequestDto): Promise<HostedIntegrationStateDto>;
  startGitHubSetup(): Promise<HostedGitHubSetupSessionDto>;
  refreshGitHubSetup(input: RefreshGitHubSetupRequestDto): Promise<HostedGitHubSetupSessionDto>;
  dismissGitHubSetup(input: RefreshGitHubSetupRequestDto): Promise<HostedIntegrationStateDto>;
  openSetupUrl(input: OpenHostedGitHubSetupUrlRequestDto): Promise<{ opened: boolean }>;
  refreshConnections(): Promise<readonly HostedGitHubConnectionDto[]>;
  listAvailableRepositories(
    input: ListAvailableHostedGitHubRepositoriesRequestDto
  ): Promise<readonly HostedGitHubAvailableRepositoryDto[]>;
  listTargets(): Promise<readonly HostedGitHubRepositoryTargetDto[]>;
  enableTarget(
    input: EnableHostedGitHubRepositoryTargetRequestDto
  ): Promise<HostedGitHubRepositoryTargetDto>;
  disableTarget(
    input: DisableHostedGitHubRepositoryTargetRequestDto
  ): Promise<HostedGitHubRepositoryTargetDto>;
  getActionStatus(
    input: GetHostedGitHubActionStatusRequestDto
  ): Promise<HostedGitHubActionStatusDto>;
  rotateSessionToken(): Promise<HostedIntegrationStateDto>;
  revokeSession(): Promise<HostedIntegrationDesktopSessionDto | null>;
}
