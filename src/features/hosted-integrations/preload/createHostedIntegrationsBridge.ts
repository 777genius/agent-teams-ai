import {
  HOSTED_INTEGRATIONS_BOOTSTRAP_WORKSPACE,
  HOSTED_INTEGRATIONS_COMPLETE_PAIRING,
  HOSTED_INTEGRATIONS_CONFIGURE,
  HOSTED_INTEGRATIONS_DISABLE_TARGET,
  HOSTED_INTEGRATIONS_DISMISS_GITHUB_SETUP,
  HOSTED_INTEGRATIONS_ENABLE_TARGET,
  HOSTED_INTEGRATIONS_GET_ACTION_STATUS,
  HOSTED_INTEGRATIONS_GET_STATE,
  HOSTED_INTEGRATIONS_LIST_AVAILABLE_REPOSITORIES,
  HOSTED_INTEGRATIONS_LIST_TARGETS,
  HOSTED_INTEGRATIONS_OPEN_SETUP_URL,
  HOSTED_INTEGRATIONS_REFRESH_CONNECTIONS,
  HOSTED_INTEGRATIONS_REFRESH_GITHUB_SETUP,
  HOSTED_INTEGRATIONS_REVOKE_SESSION,
  HOSTED_INTEGRATIONS_ROTATE_SESSION_TOKEN,
  HOSTED_INTEGRATIONS_START_GITHUB_SETUP,
  HOSTED_INTEGRATIONS_START_PAIRING,
  type HostedIntegrationsElectronApi,
} from '../contracts';

import type {
  BootstrapHostedWorkspaceRequestDto,
  CompleteHostedPairingRequestDto,
  ConfigureHostedIntegrationRequestDto,
  DisableHostedGitHubRepositoryTargetRequestDto,
  EnableHostedGitHubRepositoryTargetRequestDto,
  GetHostedGitHubActionStatusRequestDto,
  ListAvailableHostedGitHubRepositoriesRequestDto,
  OpenHostedGitHubSetupUrlRequestDto,
  RefreshGitHubSetupRequestDto,
} from '../contracts';
import type { IpcRenderer } from 'electron';

export function createHostedIntegrationsBridge(
  ipcRenderer: IpcRenderer
): HostedIntegrationsElectronApi {
  return {
    bootstrapWorkspace: (input: BootstrapHostedWorkspaceRequestDto) =>
      ipcRenderer.invoke(HOSTED_INTEGRATIONS_BOOTSTRAP_WORKSPACE, input),
    completePairing: (input: CompleteHostedPairingRequestDto) =>
      ipcRenderer.invoke(HOSTED_INTEGRATIONS_COMPLETE_PAIRING, input),
    configure: (input: ConfigureHostedIntegrationRequestDto) =>
      ipcRenderer.invoke(HOSTED_INTEGRATIONS_CONFIGURE, input),
    disableTarget: (input: DisableHostedGitHubRepositoryTargetRequestDto) =>
      ipcRenderer.invoke(HOSTED_INTEGRATIONS_DISABLE_TARGET, input),
    dismissGitHubSetup: (input: RefreshGitHubSetupRequestDto) =>
      ipcRenderer.invoke(HOSTED_INTEGRATIONS_DISMISS_GITHUB_SETUP, input),
    enableTarget: (input: EnableHostedGitHubRepositoryTargetRequestDto) =>
      ipcRenderer.invoke(HOSTED_INTEGRATIONS_ENABLE_TARGET, input),
    getActionStatus: (input: GetHostedGitHubActionStatusRequestDto) =>
      ipcRenderer.invoke(HOSTED_INTEGRATIONS_GET_ACTION_STATUS, input),
    getState: () => ipcRenderer.invoke(HOSTED_INTEGRATIONS_GET_STATE),
    listAvailableRepositories: (input: ListAvailableHostedGitHubRepositoriesRequestDto) =>
      ipcRenderer.invoke(HOSTED_INTEGRATIONS_LIST_AVAILABLE_REPOSITORIES, input),
    listTargets: () => ipcRenderer.invoke(HOSTED_INTEGRATIONS_LIST_TARGETS),
    openSetupUrl: (input: OpenHostedGitHubSetupUrlRequestDto) =>
      ipcRenderer.invoke(HOSTED_INTEGRATIONS_OPEN_SETUP_URL, input),
    refreshConnections: () => ipcRenderer.invoke(HOSTED_INTEGRATIONS_REFRESH_CONNECTIONS),
    refreshGitHubSetup: (input: RefreshGitHubSetupRequestDto) =>
      ipcRenderer.invoke(HOSTED_INTEGRATIONS_REFRESH_GITHUB_SETUP, input),
    rotateSessionToken: () => ipcRenderer.invoke(HOSTED_INTEGRATIONS_ROTATE_SESSION_TOKEN),
    revokeSession: () => ipcRenderer.invoke(HOSTED_INTEGRATIONS_REVOKE_SESSION),
    startGitHubSetup: () => ipcRenderer.invoke(HOSTED_INTEGRATIONS_START_GITHUB_SETUP),
    startPairing: () => ipcRenderer.invoke(HOSTED_INTEGRATIONS_START_PAIRING),
  };
}
