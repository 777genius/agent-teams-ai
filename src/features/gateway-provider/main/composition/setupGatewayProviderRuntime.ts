import { registerGatewayProviderIpc } from '../adapters/input/registerGatewayProviderIpc';

import {
  createGatewayProviderFeature,
  type GatewayProviderFeatureFacade,
} from './createGatewayProviderFeature';

import type {
  GatewayModelUsage,
  GatewayUsageSourceInfo,
} from '../../core/application/usage';
import type { ApiKeyService } from '@main/services/extensions/apikeys/ApiKeyService';
import type { IpcMain } from 'electron';

export interface GatewayProviderUsageAdapter {
  listSources(): Promise<GatewayUsageSourceInfo[]>;
  readUsageDay(gatewayUsageRef: string, day: string): Promise<GatewayModelUsage[]>;
}

export interface GatewayProviderRuntime {
  feature: GatewayProviderFeatureFacade;
  /** Structurally matches the token-usage `gatewayUsage` port without a feature-to-feature import. */
  gatewayUsage: GatewayProviderUsageAdapter;
}

export function setupGatewayProviderRuntime(options: {
  ipcMain: IpcMain;
  storePath: string;
  apiKeys: Pick<ApiKeyService, 'save' | 'readValueById'>;
}): GatewayProviderRuntime {
  const feature = createGatewayProviderFeature({
    storePath: options.storePath,
    apiKeys: options.apiKeys,
  });
  registerGatewayProviderIpc(options.ipcMain, feature);
  return {
    feature,
    gatewayUsage: {
      listSources: () => feature.listGatewayUsageSources(),
      readUsageDay: (gatewayUsageRef, day) => feature.readGatewayUsageDay(gatewayUsageRef, day),
    },
  };
}
