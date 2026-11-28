// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest';

import {
  registerDesktopAgentBackend,
  removeDesktopAgentBackendHandlers,
  shutdownDesktopAgentBackend,
} from '../../../src/main/ipc/agentBackend';
import {
  initializeCliInstallerHandlers,
  registerCliInstallerHandlers,
  removeCliInstallerHandlers,
} from '../../../src/main/ipc/cliInstaller';
import {
  CLI_INSTALLER_GET_PROVIDER_STATUS,
  CLI_INSTALLER_GET_STATUS,
  CLI_INSTALLER_VERIFY_PROVIDER_MODELS,
} from '../../../src/preload/constants/ipcChannels';

import type { CliInstallerService } from '../../../src/main/services/infrastructure/CliInstallerService';
import type { CliInstallationStatus } from '../../../src/shared/types';
import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from 'electron';

const cleanups: (() => void)[] = [];
afterEach(async () => {
  await shutdownDesktopAgentBackend();
  removeDesktopAgentBackendHandlers();
  for (const cleanup of cleanups.splice(0)) cleanup();
});
function fixture() {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const ipc = {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) =>
      handlers.set(channel, handler),
    removeHandler: (channel: string) => handlers.delete(channel),
  } as unknown as IpcMain;
  const url = 'file:///TEST/native-status/renderer.html',
    frame = { url };
  const contents = { mainFrame: frame, isDestroyed: () => false, getURL: () => url };
  const window = { webContents: contents, isDestroyed: () => false } as unknown as BrowserWindow;
  const event = { sender: contents, senderFrame: frame } as unknown as IpcMainInvokeEvent;
  let contextId = 'TEST-A';
  registerDesktopAgentBackend({
    ipc,
    getMainWindow: () => window,
    getActiveContextId: () => contextId,
    captureActiveSelection: () => {
      const captured = contextId;
      return { contextId: captured, isCurrent: () => contextId === captured };
    },
    rendererIndexPath: '/TEST/native-status/renderer.html',
    userDataPath: '/TEST/native-status-never-initialized',
    env: {
      AGENT_TEAMS_BACKEND_DESCRIPTOR_PATH: '/TEST/missing-descriptor',
      AGENT_TEAMS_BACKEND_DESCRIPTOR_SHA256: 'a'.repeat(64),
    },
  });
  const status: CliInstallationStatus = {
    flavor: 'agent_teams_orchestrator',
    displayName: 'TEST Native',
    supportsSelfUpdate: false,
    showVersionDetails: false,
    showBinaryPath: false,
    installed: true,
    installedVersion: 'TEST',
    binaryPath: null,
    latestVersion: null,
    updateAvailable: false,
    authLoggedIn: false,
    authStatusChecking: false,
    authMethod: null,
    providers: [],
  };
  const source = {
    usesNativeStatus: () => true,
    getStatus: vi.fn(async () => status),
    getProviderStatus: vi.fn(async () => null),
    verifyProviderModels: vi.fn(async () => null),
    getLatestStatusSnapshot: vi.fn(() => {
      throw new Error('TEST Native must not consult unscoped cache');
    }),
  };
  initializeCliInstallerHandlers(source as unknown as CliInstallerService);
  registerCliInstallerHandlers(ipc);
  cleanups.push(() => removeCliInstallerHandlers(ipc));
  return {
    source,
    status,
    event,
    handlers,
    switchContext: () => {
      contextId = 'TEST-B';
    },
    invoke: (channel: string, ...args: unknown[]) =>
      Promise.resolve(handlers.get(channel)!(event, ...args)),
  };
}

it('Native status refuses forged/iframe senders before invoking any source, without internal-error logging', async () => {
  const f = fixture();
  for (const [channel, args] of [
    [CLI_INSTALLER_GET_STATUS, []],
    [CLI_INSTALLER_GET_PROVIDER_STATUS, ['opencode']],
    [CLI_INSTALLER_VERIFY_PROVIDER_MODELS, ['opencode']],
  ] as const) {
    for (const event of [
      {},
      { ...f.event, senderFrame: { url: 'file:///TEST/native-status/renderer.html' } },
    ])
      expect(await f.handlers.get(channel)!(event, ...args)).toMatchObject({
        success: false,
        error: 'Native status request is not authorized',
      });
  }
  expect(f.source.getStatus).not.toHaveBeenCalled();
  expect(f.source.getProviderStatus).not.toHaveBeenCalled();
  expect(f.source.verifyProviderModels).not.toHaveBeenCalled();
  expect(console.warn).toHaveBeenCalledExactlyOnceWith(
    '[IPC:AgentBackend]',
    'Captured backend sender refused',
    {
      windowAvailable: true,
      mainSender: false,
      frameAvailable: false,
      mainFrame: false,
      frameUrl: false,
      contentsUrl: true,
    }
  );
  // Consume only the exact, finite denial diagnostic checked above; setup still rejects other logs.
  vi.mocked(console.warn).mockClear();
});

it('Native reads bypass the legacy TTL/snapshot cache and discard a reply after a foreground context switch', async () => {
  const f = fixture();
  expect(await f.invoke(CLI_INSTALLER_GET_STATUS)).toMatchObject({ success: true });
  expect(await f.invoke(CLI_INSTALLER_GET_STATUS)).toMatchObject({ success: true });
  expect(f.source.getStatus).toHaveBeenCalledTimes(2);
  let release!: (value: CliInstallationStatus) => void;
  f.source.getStatus.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve;
      })
  );
  const pending = f.invoke(CLI_INSTALLER_GET_STATUS);
  f.switchContext();
  release(f.status);
  expect(await pending).toEqual({ success: false, error: 'Native status context changed' });
  expect(f.source.getLatestStatusSnapshot).not.toHaveBeenCalled();
});
