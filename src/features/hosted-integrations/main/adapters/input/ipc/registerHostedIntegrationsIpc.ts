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
} from '../../../../contracts';

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
} from '../../../../contracts';
import type { HostedIntegrationsFeatureFacade } from '../../../composition/createHostedIntegrationsFeature';
import type { IpcMain } from 'electron';

export function registerHostedIntegrationsIpc(
  ipcMain: IpcMain,
  feature: HostedIntegrationsFeatureFacade
): void {
  ipcMain.handle(HOSTED_INTEGRATIONS_GET_STATE, () => feature.getState());
  ipcMain.handle(
    HOSTED_INTEGRATIONS_CONFIGURE,
    (_event, input: ConfigureHostedIntegrationRequestDto) => feature.configure(input)
  );
  ipcMain.handle(
    HOSTED_INTEGRATIONS_BOOTSTRAP_WORKSPACE,
    (_event, input: BootstrapHostedWorkspaceRequestDto) => feature.bootstrapWorkspace(input)
  );
  ipcMain.handle(HOSTED_INTEGRATIONS_START_PAIRING, () => feature.startPairing());
  ipcMain.handle(
    HOSTED_INTEGRATIONS_COMPLETE_PAIRING,
    (_event, input: CompleteHostedPairingRequestDto) => feature.completePairing(input)
  );
  ipcMain.handle(HOSTED_INTEGRATIONS_START_GITHUB_SETUP, () => feature.startGitHubSetup());
  ipcMain.handle(
    HOSTED_INTEGRATIONS_REFRESH_GITHUB_SETUP,
    (_event, input: RefreshGitHubSetupRequestDto) => feature.refreshGitHubSetup(input)
  );
  ipcMain.handle(
    HOSTED_INTEGRATIONS_DISMISS_GITHUB_SETUP,
    (_event, input: RefreshGitHubSetupRequestDto) => feature.dismissGitHubSetup(input)
  );
  ipcMain.handle(
    HOSTED_INTEGRATIONS_OPEN_SETUP_URL,
    (_event, input: OpenHostedGitHubSetupUrlRequestDto) => feature.openSetupUrl(input)
  );
  ipcMain.handle(HOSTED_INTEGRATIONS_REFRESH_CONNECTIONS, () => feature.refreshConnections());
  ipcMain.handle(
    HOSTED_INTEGRATIONS_LIST_AVAILABLE_REPOSITORIES,
    (_event, input: ListAvailableHostedGitHubRepositoriesRequestDto) =>
      feature.listAvailableRepositories(input)
  );
  ipcMain.handle(HOSTED_INTEGRATIONS_LIST_TARGETS, () => feature.listTargets());
  ipcMain.handle(
    HOSTED_INTEGRATIONS_ENABLE_TARGET,
    (_event, input: EnableHostedGitHubRepositoryTargetRequestDto) => feature.enableTarget(input)
  );
  ipcMain.handle(
    HOSTED_INTEGRATIONS_DISABLE_TARGET,
    (_event, input: DisableHostedGitHubRepositoryTargetRequestDto) => feature.disableTarget(input)
  );
  ipcMain.handle(
    HOSTED_INTEGRATIONS_GET_ACTION_STATUS,
    (_event, input: GetHostedGitHubActionStatusRequestDto) => feature.getActionStatus(input)
  );
  ipcMain.handle(HOSTED_INTEGRATIONS_ROTATE_SESSION_TOKEN, () => feature.rotateSessionToken());
  ipcMain.handle(HOSTED_INTEGRATIONS_REVOKE_SESSION, () => feature.revokeSession());
}

export function removeHostedIntegrationsIpc(ipcMain: IpcMain): void {
  for (const channel of [
    HOSTED_INTEGRATIONS_GET_STATE,
    HOSTED_INTEGRATIONS_CONFIGURE,
    HOSTED_INTEGRATIONS_BOOTSTRAP_WORKSPACE,
    HOSTED_INTEGRATIONS_START_PAIRING,
    HOSTED_INTEGRATIONS_COMPLETE_PAIRING,
    HOSTED_INTEGRATIONS_START_GITHUB_SETUP,
    HOSTED_INTEGRATIONS_REFRESH_GITHUB_SETUP,
    HOSTED_INTEGRATIONS_DISMISS_GITHUB_SETUP,
    HOSTED_INTEGRATIONS_OPEN_SETUP_URL,
    HOSTED_INTEGRATIONS_REFRESH_CONNECTIONS,
    HOSTED_INTEGRATIONS_LIST_AVAILABLE_REPOSITORIES,
    HOSTED_INTEGRATIONS_LIST_TARGETS,
    HOSTED_INTEGRATIONS_ENABLE_TARGET,
    HOSTED_INTEGRATIONS_DISABLE_TARGET,
    HOSTED_INTEGRATIONS_GET_ACTION_STATUS,
    HOSTED_INTEGRATIONS_ROTATE_SESSION_TOKEN,
    HOSTED_INTEGRATIONS_REVOKE_SESSION,
  ]) {
    ipcMain.removeHandler(channel);
  }
}
