import { join } from 'node:path';

import { HostedIntegrationUseCases } from '../../core/application';
import { ControlPlaneHttpClient } from '../infrastructure/ControlPlaneHttpClient';
import { ElectronBrowserOpenPort } from '../infrastructure/ElectronBrowserOpenPort';
import { ElectronSafeStorageDesktopTokenStore } from '../infrastructure/ElectronSafeStorageDesktopTokenStore';
import { FileHostedWorkspaceBindingStore } from '../infrastructure/FileHostedWorkspaceBindingStore';
import { NodeHostedIntegrationIdGenerator } from '../infrastructure/NodeHostedIntegrationIdGenerator';

import type {
  BootstrapHostedWorkspaceRequestDto,
  CompleteHostedPairingRequestDto,
  ConfigureHostedIntegrationRequestDto,
  DisableHostedGitHubRepositoryTargetRequestDto,
  EnableHostedGitHubRepositoryTargetRequestDto,
  GetHostedGitHubActionStatusRequestDto,
  HostedGitHubActionCommandDto,
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
} from '../../contracts';

export interface CreateHostedIntegrationsFeatureOptions {
  readonly userDataPath: string;
  readonly allowLocalhostHttp?: boolean;
}

export interface HostedIntegrationsFeatureFacade {
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
  submitAgentGithubAction(
    input: HostedGitHubActionCommandDto
  ): Promise<HostedGitHubActionStatusDto>;
  getActionStatus(
    input: GetHostedGitHubActionStatusRequestDto
  ): Promise<HostedGitHubActionStatusDto>;
  rotateSessionToken(): Promise<HostedIntegrationStateDto>;
  revokeSession(): Promise<HostedIntegrationDesktopSessionDto | null>;
}

export function createHostedIntegrationsFeature(
  options: CreateHostedIntegrationsFeatureOptions
): HostedIntegrationsFeatureFacade {
  const featureDir = join(options.userDataPath, 'hosted-integrations');
  const stateStore = new FileHostedWorkspaceBindingStore(join(featureDir, 'state.json'));
  const tokenStore = new ElectronSafeStorageDesktopTokenStore(
    join(featureDir, 'desktop-token.json')
  );
  const controlPlane = new ControlPlaneHttpClient({
    allowLocalhostHttp: options.allowLocalhostHttp === true,
    getBaseUrl: async () => (await stateStore.readState()).controlPlaneBaseUrl,
  });
  const useCases = new HostedIntegrationUseCases(
    {
      actions: controlPlane,
      browserOpen: new ElectronBrowserOpenPort(),
      clock: { now: () => new Date() },
      connection: controlPlane,
      idGenerator: new NodeHostedIntegrationIdGenerator(),
      pairing: controlPlane,
      setup: controlPlane,
      stateStore,
      targets: controlPlane,
      tokenStore,
    },
    { allowLocalhostHttp: options.allowLocalhostHttp === true }
  );

  return {
    bootstrapWorkspace: (input) => useCases.bootstrapWorkspace(input),
    completePairing: (input) => useCases.completePairing(input),
    configure: (input) => useCases.configure(input),
    disableTarget: (input) => useCases.disableTarget(input),
    dismissGitHubSetup: (input) => useCases.dismissGitHubSetup(input),
    enableTarget: (input) => useCases.enableTarget(input),
    getActionStatus: (input) => useCases.getActionStatus(input),
    getState: () => useCases.getState(),
    listAvailableRepositories: (input) => useCases.listAvailableRepositories(input),
    listTargets: () => useCases.listTargets(),
    openSetupUrl: (input) => useCases.openSetupUrl(input),
    refreshConnections: () => useCases.refreshConnections(),
    refreshGitHubSetup: (input) => useCases.refreshGitHubSetup(input),
    rotateSessionToken: () => useCases.rotateSessionToken(),
    revokeSession: async () => (await useCases.revokeSession()).session ?? null,
    startGitHubSetup: () => useCases.startGitHubSetup(),
    startPairing: () => useCases.startPairing(),
    submitAgentGithubAction: (input) => useCases.submitAgentGithubAction(input),
  };
}
