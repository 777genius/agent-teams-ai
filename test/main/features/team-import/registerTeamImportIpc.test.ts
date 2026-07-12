import {
  TEAM_IMPORT_CHOOSE_FOLDER_AND_PREVIEW,
  TEAM_IMPORT_CREATE_DRAFT,
} from '@features/team-import/contracts';
import {
  registerTeamImportIpc,
  removeTeamImportIpc,
} from '@features/team-import/main/adapters/input/ipc/registerTeamImportIpc';
import { describe, expect, it, vi } from 'vitest';

import type { TeamImportFeatureFacade } from '@features/team-import/main';
import type { IpcMain } from 'electron';

type Handler = (event: unknown, ...args: unknown[]) => Promise<unknown>;

function createIpcHarness() {
  const handlers = new Map<string, Handler>();
  const ipcMain = {
    handle: vi.fn((channel: string, handler: Handler) => handlers.set(channel, handler)),
    removeHandler: vi.fn((channel: string) => handlers.delete(channel)),
  } as unknown as IpcMain;
  return { handlers, ipcMain };
}

describe('team import IPC', () => {
  it('lets main own folder selection instead of forwarding a renderer path', async () => {
    const { handlers, ipcMain } = createIpcHarness();
    const feature: TeamImportFeatureFacade = {
      chooseFolderAndPreview: vi.fn(async () => null),
      createDraft: vi.fn(),
    };
    registerTeamImportIpc(ipcMain, feature);

    await handlers.get(TEAM_IMPORT_CHOOSE_FOLDER_AND_PREVIEW)?.({}, '/etc');

    expect(feature.chooseFolderAndPreview).toHaveBeenCalledWith();
  });

  it('validates create requests at the IPC boundary', async () => {
    const { handlers, ipcMain } = createIpcHarness();
    const feature: TeamImportFeatureFacade = {
      chooseFolderAndPreview: vi.fn(),
      createDraft: vi.fn(),
    };
    registerTeamImportIpc(ipcMain, feature);

    await expect(
      handlers.get(TEAM_IMPORT_CREATE_DRAFT)?.({}, { teamName: 'demo' })
    ).rejects.toThrow('review');
    expect(feature.createDraft).not.toHaveBeenCalled();
  });

  it('maps a valid create request and removes both handlers', async () => {
    const { handlers, ipcMain } = createIpcHarness();
    const feature: TeamImportFeatureFacade = {
      chooseFolderAndPreview: vi.fn(),
      createDraft: vi.fn(async (request) => ({ teamName: request.teamName })),
    };
    registerTeamImportIpc(ipcMain, feature);

    await expect(
      handlers.get(TEAM_IMPORT_CREATE_DRAFT)?.({}, { reviewId: 'review-1', teamName: 'demo' })
    ).resolves.toEqual({ teamName: 'demo' });
    expect(feature.createDraft).toHaveBeenCalledWith({ reviewId: 'review-1', teamName: 'demo' });

    removeTeamImportIpc(ipcMain);
    expect(handlers.size).toBe(0);
  });
});
