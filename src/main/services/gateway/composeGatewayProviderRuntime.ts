import { join } from 'node:path';

import {
  type GatewayProviderRuntime,
  setupGatewayProviderRuntime,
} from '@features/gateway-provider/main';
import { OpenCodeLocalProviderConnector } from '@features/runtime-provider-management/main';
import { createLogger } from '@shared/utils/logger';

import { createGatewayLaunchRuntime } from './createGatewayLaunchRuntime';

import type { ApiKeyService } from '@main/services/extensions/apikeys/ApiKeyService';
import type { IpcMain } from 'electron';

/** App-shell composition of gateway IPC, native launch metadata and OpenCode artifacts. */
export function composeGatewayProviderRuntime(deps: {
  ipcMain: IpcMain;
  apiKeys: Pick<ApiKeyService, 'save' | 'readValueById'>;
  appDataPath: string;
}) {
  const logger = createLogger('GatewayBindings');
  const gatewayProviderRuntime: GatewayProviderRuntime = setupGatewayProviderRuntime({
    ipcMain: deps.ipcMain,
    storePath: join(deps.appDataPath, 'gateway-provider', 'store.json'),
    apiKeys: deps.apiKeys,
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
  return { gatewayProviderRuntime, gatewayProviderConnector, gatewayLaunchRuntime };
}
