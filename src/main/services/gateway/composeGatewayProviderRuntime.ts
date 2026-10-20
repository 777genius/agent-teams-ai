import { join } from 'node:path';

import { setupGatewayProviderRuntime } from '@features/gateway-provider/main';
import { OpenCodeLocalProviderConnector } from '@features/runtime-provider-management/main';

import { createGatewayLaunchRuntime } from './createGatewayLaunchRuntime';

import type { ApiKeyService } from '@main/services/extensions/apikeys/ApiKeyService';
import type { IpcMain } from 'electron';

/** App-shell composition of gateway IPC, native launch metadata and OpenCode artifacts. */
export function composeGatewayProviderRuntime(deps: {
  ipcMain: IpcMain;
  apiKeys: Pick<ApiKeyService, 'save' | 'readValueById'>;
  appDataPath: string;
}) {
  const gatewayProviderRuntime = setupGatewayProviderRuntime({
    ipcMain: deps.ipcMain,
    storePath: join(deps.appDataPath, 'gateway-provider', 'store.json'),
    apiKeys: deps.apiKeys,
  });
  const gatewayProviderConnector = new OpenCodeLocalProviderConnector();
  const gatewayLaunchRuntime = createGatewayLaunchRuntime({
    feature: gatewayProviderRuntime.feature,
    connector: gatewayProviderConnector,
    runsPath: join(deps.appDataPath, 'gateway-provider', 'runs.json'),
  });
  return { gatewayProviderRuntime, gatewayProviderConnector, gatewayLaunchRuntime };
}
