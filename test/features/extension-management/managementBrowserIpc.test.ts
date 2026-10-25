import { expect, it, vi } from 'vitest';

import { extensionManagementChannel } from '../../../src/features/extension-management/contracts';
import { createElectronExtensionManagement } from '../../../src/features/extension-management/main/composition/createElectronExtensionManagement';

import type { BrowserWindow, IpcMainInvokeEvent } from 'electron';

const { handlers } = vi.hoisted(() => ({
  handlers: new Map<string, (event: IpcMainInvokeEvent) => unknown>(),
}));
vi.mock('electron', () => ({
  app: { isPackaged: false, getAppPath: () => '/isolated-app' },
  ipcMain: {
    handle: (channel: string, handler: (event: IpcMainInvokeEvent) => unknown) =>
      handlers.set(channel, handler),
    removeHandler: (channel: string) => handlers.delete(channel),
  },
}));
vi.mock('@main/ipc/skills', () => ({ setSkillsMutationAdmission: () => () => {} }));
vi.mock(
  '../../../src/features/extension-management/main/composition/createAppExtensionManagement',
  () => ({
    createAppExtensionManagement: () => ({ feature: { close: vi.fn(async () => {}) } }),
  })
);

it('issues browser access only to the owned main frame and removes the handoff on close', async () => {
  const frame = {};
  const webContents = { mainFrame: frame };
  const grant = vi.fn(() => 'http://127.0.0.1:4141/#management-access=private-test-grant');
  const runtime = createElectronExtensionManagement({
    getMainWindow: () => ({ webContents }) as unknown as BrowserWindow,
    getManagementBrowserUrl: grant,
    isLocal: () => true,
    aliveTeams: () => [],
    savedRequest: async () => null,
    knownProjects: async () => [],
  });
  const handler = handlers.get(extensionManagementChannel('browserAccess'))!;
  for (const event of [
    { sender: {}, senderFrame: frame },
    { sender: webContents, senderFrame: {} },
    { sender: webContents, senderFrame: null },
  ])
    expect(() => handler(event as IpcMainInvokeEvent)).toThrow('owned desktop window');
  expect(grant).not.toHaveBeenCalled();
  expect(handler({ sender: webContents, senderFrame: frame } as IpcMainInvokeEvent)).toContain(
    '#management-access='
  );
  expect(grant).toHaveBeenCalledOnce();
  await runtime.feature.close();
  expect(handlers.has(extensionManagementChannel('browserAccess'))).toBe(false);
});
