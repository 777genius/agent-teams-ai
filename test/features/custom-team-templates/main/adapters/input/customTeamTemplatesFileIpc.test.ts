import { CUSTOM_TEAM_TEMPLATE_FILE_CHANNELS } from '@features/custom-team-templates/contracts';
import {
  registerCustomTeamTemplatesFileIpc,
  removeCustomTeamTemplatesFileIpc,
} from '@features/custom-team-templates/main/adapters/input/ipc/registerCustomTeamTemplatesFileIpc';
import { describe, expect, it, vi } from 'vitest';

import type { CustomTeamTemplateDesktopFileService } from '@features/custom-team-templates/main/services/CustomTeamTemplateDesktopFileService';
import type { IpcMain } from 'electron';

interface FakeIpcMain {
  handle(channel: string, handler: (event: unknown, request?: unknown) => unknown): void;
  removeHandler(channel: string): void;
  removeHandlerCalls: string[];
  invoke(channel: string, request?: unknown): Promise<unknown>;
  channels(): string[];
}

function fakeIpcMain(): FakeIpcMain {
  const handlers = new Map<string, (event: unknown, request?: unknown) => unknown>();
  const removeHandlerCalls: string[] = [];
  return {
    handle: (channel, handler) => {
      handlers.set(channel, handler);
    },
    removeHandler: (channel) => {
      removeHandlerCalls.push(channel);
      handlers.delete(channel);
    },
    removeHandlerCalls,
    invoke: (channel, request) => {
      const handler = handlers.get(channel);
      if (!handler) throw new Error(`no IPC handler registered for ${channel}`);
      return Promise.resolve(handler({}, request));
    },
    channels: () => [...handlers.keys()].sort((left, right) => left.localeCompare(right)),
  };
}

describe('custom-team-templates desktop file IPC', () => {
  it('registers exactly the two desktop file channels', () => {
    const ipc = fakeIpcMain();
    const service = {
      importFromFile: vi.fn(),
      exportToFile: vi.fn(),
    } as unknown as CustomTeamTemplateDesktopFileService;

    registerCustomTeamTemplatesFileIpc(ipc as unknown as IpcMain, service);

    expect(ipc.channels()).toEqual(
      Object.values(CUSTOM_TEAM_TEMPLATE_FILE_CHANNELS).sort((left, right) =>
        left.localeCompare(right)
      )
    );
  });

  it('forwards import with no arguments and export with only the request payload', async () => {
    const ipc = fakeIpcMain();
    const service = {
      importFromFile: vi.fn().mockResolvedValue({ status: 'cancelled' }),
      exportToFile: vi.fn().mockResolvedValue({ status: 'exported' }),
    } as unknown as CustomTeamTemplateDesktopFileService;
    registerCustomTeamTemplatesFileIpc(ipc as unknown as IpcMain, service);

    await expect(ipc.invoke(CUSTOM_TEAM_TEMPLATE_FILE_CHANNELS.importFromFile)).resolves.toEqual({
      status: 'cancelled',
    });
    expect(service.importFromFile).toHaveBeenCalledWith();

    const request = { templateId: 'tmpl-1' };
    await expect(
      ipc.invoke(CUSTOM_TEAM_TEMPLATE_FILE_CHANNELS.exportToFile, request)
    ).resolves.toEqual({ status: 'exported' });
    expect(service.exportToFile).toHaveBeenCalledWith(request);
  });

  it('never accepts a filesystem path as a separate argument', async () => {
    const ipc = fakeIpcMain();
    const service = {
      importFromFile: vi.fn().mockResolvedValue({ status: 'cancelled' }),
      exportToFile: vi.fn().mockResolvedValue({ status: 'cancelled' }),
    } as unknown as CustomTeamTemplateDesktopFileService;
    registerCustomTeamTemplatesFileIpc(ipc as unknown as IpcMain, service);

    await ipc.invoke(CUSTOM_TEAM_TEMPLATE_FILE_CHANNELS.importFromFile, 'C:\\Windows\\System32');
    expect(service.importFromFile).toHaveBeenCalledWith();

    await ipc.invoke(CUSTOM_TEAM_TEMPLATE_FILE_CHANNELS.exportToFile, {
      templateId: 'tmpl-1',
      path: '/etc/passwd',
    });
    // The transport forwards the single request object; the service reads only
    // the template id and the path never reaches the file gateway.
    expect(service.exportToFile).toHaveBeenCalledWith({
      templateId: 'tmpl-1',
      path: '/etc/passwd',
    });
  });

  it('removes exactly the file handlers on shutdown', () => {
    const ipc = fakeIpcMain();
    const service = {
      importFromFile: vi.fn(),
      exportToFile: vi.fn(),
    } as unknown as CustomTeamTemplateDesktopFileService;
    registerCustomTeamTemplatesFileIpc(ipc as unknown as IpcMain, service);

    removeCustomTeamTemplatesFileIpc(ipc as unknown as IpcMain);

    expect(ipc.channels()).toEqual([]);
    expect([...ipc.removeHandlerCalls].sort((left, right) => left.localeCompare(right))).toEqual(
      Object.values(CUSTOM_TEAM_TEMPLATE_FILE_CHANNELS).sort((left, right) =>
        left.localeCompare(right)
      )
    );
  });
});
