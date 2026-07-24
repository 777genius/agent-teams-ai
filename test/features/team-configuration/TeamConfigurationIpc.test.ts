import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  TEAM_CREATE_CONFIG,
  TEAM_DELETE_DRAFT,
  TEAM_GET_SAVED_REQUEST,
  TEAM_UPDATE_CONFIG,
} from '../../../src/features/team-configuration/contracts';
import {
  registerTeamConfigurationIpc,
  removeTeamConfigurationIpc,
} from '../../../src/features/team-configuration/main';
import { createTeamConfigurationIpcHandlers } from '../../../src/features/team-configuration/main/adapters/input/ipc/createTeamConfigurationIpcHandlers';
import { FileSystemDraftTeamConfigGuard } from '../../../src/features/team-configuration/main/infrastructure/FileSystemDraftTeamConfigGuard';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true })));
});

function createDependencies() {
  return {
    createConfig: { execute: vi.fn(() => Promise.resolve()) },
    updateConfig: {
      execute: vi.fn(() =>
        Promise.resolve({
          name: 'Renamed',
          members: [],
        })
      ),
    },
    getSavedRequest: { execute: vi.fn(() => Promise.resolve(null)) },
    deleteDraft: { execute: vi.fn(() => Promise.resolve()) },
    logger: { error: vi.fn(), warn: vi.fn() },
  };
}

describe('team configuration IPC', () => {
  it('owns and removes all four channels', () => {
    const handlers = new Map<string, unknown>();
    const ipcMain = {
      handle: vi.fn((channel: string, handler: unknown) => handlers.set(channel, handler)),
      removeHandler: vi.fn((channel: string) => handlers.delete(channel)),
    };

    registerTeamConfigurationIpc(ipcMain as never, createDependencies());

    expect(new Set(handlers.keys())).toEqual(
      new Set([
        TEAM_CREATE_CONFIG,
        TEAM_UPDATE_CONFIG,
        TEAM_GET_SAVED_REQUEST,
        TEAM_DELETE_DRAFT,
      ])
    );

    removeTeamConfigurationIpc(ipcMain as never);
    expect(handlers.size).toBe(0);
  });

  it('normalizes create config input before invoking the use case', async () => {
    const dependencies = createDependencies();
    const handlers = createTeamConfigurationIpcHandlers(dependencies);

    await expect(
      handlers.createConfig({}, {
        teamName: '  demo-team  ',
        displayName: ' Demo ',
        members: [{ name: ' Alice ', role: ' Engineer ' }],
      })
    ).resolves.toEqual({ success: true, data: undefined });
    expect(dependencies.createConfig.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        teamName: 'demo-team',
        displayName: 'Demo',
        members: [expect.objectContaining({ name: 'Alice', role: 'Engineer' })],
      })
    );
  });

  it('preserves create validation errors without invoking application code', async () => {
    const dependencies = createDependencies();
    const handlers = createTeamConfigurationIpcHandlers(dependencies);

    await expect(
      handlers.createConfig({}, { teamName: 'demo-team', members: 'alice' })
    ).resolves.toEqual({ success: false, error: 'members must be an array' });
    expect(dependencies.createConfig.execute).not.toHaveBeenCalled();
  });

  it('returns saved request data and validates draft names', async () => {
    const dependencies = createDependencies();
    dependencies.getSavedRequest.execute.mockResolvedValueOnce({
      teamName: 'demo-team',
      members: [],
    } as never);
    const handlers = createTeamConfigurationIpcHandlers(dependencies);

    await expect(handlers.getSavedRequest({}, 'demo-team')).resolves.toMatchObject({
      success: true,
      data: { teamName: 'demo-team' },
    });
    await expect(handlers.deleteDraft({}, '../demo')).resolves.toMatchObject({ success: false });
    expect(dependencies.deleteDraft.execute).not.toHaveBeenCalled();
  });

  it('keeps application failures inside the legacy IPC result envelope', async () => {
    const dependencies = createDependencies();
    dependencies.deleteDraft.execute.mockRejectedValueOnce(new Error('draft delete failed'));
    const handlers = createTeamConfigurationIpcHandlers(dependencies);

    await expect(handlers.deleteDraft({}, 'demo-team')).resolves.toEqual({
      success: false,
      error: 'draft delete failed',
    });
    expect(dependencies.logger.error).toHaveBeenCalledWith(
      '[teams:deleteDraft] draft delete failed'
    );
  });
});

describe('FileSystemDraftTeamConfigGuard', () => {
  it('resolves the teams root lazily and permits a missing config', async () => {
    const root = await mkdtemp(join(tmpdir(), 'team-config-guard-'));
    temporaryRoots.push(root);
    const getTeamsRoot = vi.fn(() => root);
    const guard = new FileSystemDraftTeamConfigGuard(getTeamsRoot);

    await expect(guard.assertDraftCanBeDeleted('draft-team')).resolves.toBeUndefined();
    expect(getTeamsRoot).toHaveBeenCalledOnce();
  });

  it('rejects deletion when config.json exists', async () => {
    const root = await mkdtemp(join(tmpdir(), 'team-config-guard-'));
    temporaryRoots.push(root);
    const teamDir = join(root, 'saved-team');
    await mkdir(teamDir);
    await writeFile(join(teamDir, 'config.json'), '{}');
    const guard = new FileSystemDraftTeamConfigGuard(() => root);

    await expect(guard.assertDraftCanBeDeleted('saved-team')).rejects.toThrow(
      'Cannot delete draft: team has config.json (use deleteTeam instead)'
    );
  });

  it('does not treat non-ENOENT filesystem failures as a draft', async () => {
    const root = await mkdtemp(join(tmpdir(), 'team-config-guard-'));
    temporaryRoots.push(root);
    const blocker = join(root, 'not-a-directory');
    await writeFile(blocker, 'blocked');
    const guard = new FileSystemDraftTeamConfigGuard(() => blocker);

    await expect(guard.assertDraftCanBeDeleted('draft-team')).rejects.toMatchObject({
      code: 'ENOTDIR',
    });
  });
});
