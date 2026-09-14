import {
  registerWorkspaceTrustIpc,
  removeWorkspaceTrustIpc,
} from '../adapters/input/registerWorkspaceTrustIpc';

import { createWorkspaceTrustCoordinator } from './createWorkspaceTrustCoordinator';
import {
  createWorkspaceTrustStatusFeature,
  resolveWorkspaceTrustGlobalConfigFilePath,
} from './createWorkspaceTrustStatusFeature';

export function createWorkspaceTrustFeatures(input: {
  getClaudeConfigDir: () => string;
  getAutoDetectedClaudeConfigDir: () => string;
  getHomeDir: () => string;
  env?: NodeJS.ProcessEnv;
  isLocalContext?: () => boolean;
}) {
  const globalConfigFilePath = (): string => resolveWorkspaceTrustGlobalConfigFilePath(input);
  const shared = {
    claudeConfigDir: input.getClaudeConfigDir,
    globalConfigFilePath,
  };
  const status = createWorkspaceTrustStatusFeature({
    ...shared,
    getHomeDir: input.getHomeDir,
    env: input.env,
    isLocalContext: input.isLocalContext,
  });
  return {
    coordinator: createWorkspaceTrustCoordinator(shared),
    status,
    registerIpc: (ipcMain: Parameters<typeof registerWorkspaceTrustIpc>[0]) =>
      registerWorkspaceTrustIpc(ipcMain, status),
    removeIpc: (ipcMain: Parameters<typeof removeWorkspaceTrustIpc>[0]) =>
      removeWorkspaceTrustIpc(ipcMain),
  };
}
