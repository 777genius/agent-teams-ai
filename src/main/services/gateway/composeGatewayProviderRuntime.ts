import { join } from 'node:path';

import {
  type GatewayProviderRuntime,
  setupGatewayProviderRuntime,
} from '@features/gateway-provider/main';
import { OpenCodeLocalProviderConnector } from '@features/runtime-provider-management/main';
import { getTeamsBasePath } from '@main/utils/pathDecoder';
import { createLogger } from '@shared/utils/logger';

import { createGatewayLaunchRuntime } from './createGatewayLaunchRuntime';
import { isGatewayMemberSaved } from './GatewayDraftRoster';

import type { ApiKeyService } from '@main/services/extensions/apikeys/ApiKeyService';
import type { TeamDataService } from '@main/services/team/TeamDataService';
import type { IpcMain } from 'electron';

/** App-shell composition of gateway IPC, native launch metadata and OpenCode artifacts. */
export async function composeGatewayProviderRuntime(deps: {
  ipcMain: IpcMain;
  apiKeys: Pick<ApiKeyService, 'save' | 'readValueById'>;
  appDataPath: string;
  configuration: Pick<TeamDataService, 'runConfigurationOperation'>;
}) {
  const logger = createLogger('GatewayBindings');
  const gatewayProviderRuntime: GatewayProviderRuntime = setupGatewayProviderRuntime({
    ipcMain: deps.ipcMain,
    storePath: join(deps.appDataPath, 'gateway-provider', 'store.json'),
    apiKeys: deps.apiKeys,
    drafts: {
      isMemberSaved: (team, member) => isGatewayMemberSaved(getTeamsBasePath(), team, member),
      hasSourceHistory: (ref) => gatewayLaunchRuntime.hasSourceHistory(ref),
      onRecoveryFailure: () =>
        logger.warn('Gateway draft recovery deferred: saved team evidence is unavailable.'),
      configurationOperation: (team, operation) =>
        deps.configuration.runConfigurationOperation(team, operation),
    },
    onBindingsChanged: () => {
      void gatewayLaunchRuntime.retireStoppedArtifacts().catch((error: unknown) => {
        logger.warn(`Could not reconcile retired gateway artifacts: ${String(error)}`);
      });
    },
  });
  const gatewayProviderConnector = new OpenCodeLocalProviderConnector();
  const gatewayLaunchRuntime = createGatewayLaunchRuntime({
    feature: gatewayProviderRuntime.feature,
    connector: gatewayProviderConnector,
    runsPath: join(deps.appDataPath, 'gateway-provider', 'runs.json'),
    onRetirementFailure: () => logger.warn('Could not retire an owned gateway artifact.'),
  });
  await gatewayProviderRuntime.feature.recoverGatewayDraftBindings().catch((error: unknown) => {
    logger.warn('Could not recover gateway drafts; their saved ownership is preserved.', error);
  });
  return { gatewayProviderRuntime, gatewayProviderConnector, gatewayLaunchRuntime };
}
