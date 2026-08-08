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
