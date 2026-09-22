import { LocalFileSystemProvider } from './services/infrastructure/LocalFileSystemProvider';

import type { SshConnectionManager } from './services/infrastructure/SshConnectionManager';
import type { UpdaterService } from './services/infrastructure/UpdaterService';

/** No-op updater stub because auto-updates require Electron. */
export const updaterServiceStub = {
  checkForUpdates: async () => {},
  downloadUpdate: async () => {},
  quitAndInstall: async () => {},
  setMainWindow: () => {},
} as unknown as UpdaterService;

/** No-op SSH stub because standalone mode manages no per-user SSH session. */
export const sshConnectionManagerStub = {
  getStatus: () => ({
    state: 'disconnected' as const,
    host: null,
    error: null,
    remoteProjectsPath: null,
  }),
  getProvider: () => new LocalFileSystemProvider(),
  isRemote: () => false,
  connect: async () => {},
  disconnect: () => {},
  testConnection: async () => ({
    success: false,
    error: 'SSH not available in standalone mode',
  }),
  getConfigHosts: async () => [],
  resolveHostConfig: async () => null,
  dispose: () => {},
  on: () => sshConnectionManagerStub,
  off: () => sshConnectionManagerStub,
  emit: () => false,
} as unknown as SshConnectionManager;
