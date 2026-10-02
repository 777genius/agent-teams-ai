import { initializeUpdaterHandlers, registerUpdaterHandlers } from '@main/ipc/updater';
import { describe, expect, it, vi } from 'vitest';

import type { UpdaterService } from '@main/services/infrastructure/UpdaterService';
import type { IpcMain, IpcMainInvokeEvent } from 'electron';

vi.mock('electron', () => ({}));
vi.mock('@shared/utils/logger', () => ({
  createLogger: () => ({ error: vi.fn(), info: vi.fn() }),
}));

describe('updater IPC failures', () => {
  it.each([
    ['updater:check', 'checkForUpdates'],
    ['updater:download', 'downloadUpdate'],
    ['updater:install', 'quitAndInstall'],
  ] as const)(
    'rejects %s rather than hiding an unexpected service failure',
    async (channel, operation) => {
      const failure = new Error('Updater unavailable');
      initializeUpdaterHandlers({
        [operation]: vi.fn().mockRejectedValue(failure),
      } as unknown as UpdaterService);
      const handle = vi.fn();
      registerUpdaterHandlers({ handle } as unknown as IpcMain);
      const handler = handle.mock.calls.find(([name]) => name === channel)?.[1] as (
        event: IpcMainInvokeEvent
      ) => Promise<void>;
      expect(handler).toBeDefined();
      await expect(handler({} as IpcMainInvokeEvent)).rejects.toBe(failure);
    }
  );
});
