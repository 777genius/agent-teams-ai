import {
  CUSTOM_TEAM_TEMPLATE_CHANNELS,
  CUSTOM_TEAM_TEMPLATE_FILE_CHANNELS,
} from '@features/custom-team-templates/contracts';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { InternalStorageFeature } from '@features/internal-storage/main';

const ipc = vi.hoisted(() => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  return {
    handlers,
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      handlers.set(channel, handler);
    }),
    removeHandler: vi.fn((channel: string) => {
      handlers.delete(channel);
    }),
  };
});

const featureMock = vi.hoisted(() => ({
  importTemplate: { execute: vi.fn() },
  exportTemplate: { execute: vi.fn() },
  preparePreview: { execute: vi.fn() },
  saveTemplate: { execute: vi.fn() },
  recheckSave: { execute: vi.fn() },
  listTemplates: { execute: vi.fn() },
  updateTemplate: { execute: vi.fn() },
  deleteTemplate: { execute: vi.fn() },
  duplicateTemplate: { execute: vi.fn() },
  copyBuiltinTemplate: { execute: vi.fn() },
  dispose: vi.fn(),
}));

vi.mock('electron', () => ({
  ipcMain: { handle: ipc.handle, removeHandler: ipc.removeHandler },
}));

vi.mock('@features/custom-team-templates/main', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@features/custom-team-templates/main')>();
  return {
    ...actual,
    createCustomTeamTemplatesFeature: vi.fn(() => featureMock),
  };
});

import { startCustomTeamTemplatesFeature } from '@main/startCustomTeamTemplatesFeature';

function internalStorage(): InternalStorageFeature {
  return { customTeamTemplatesBackend: { workerPath: null } } as unknown as InternalStorageFeature;
}

describe('startCustomTeamTemplatesFeature', () => {
  beforeEach(() => {
    ipc.handlers.clear();
    vi.clearAllMocks();
  });

  it('registers every shared data channel and both desktop file channels at startup', () => {
    startCustomTeamTemplatesFeature(internalStorage());

    expect([...ipc.handlers.keys()].sort()).toEqual(
      [
        ...Object.values(CUSTOM_TEAM_TEMPLATE_CHANNELS),
        ...Object.values(CUSTOM_TEAM_TEMPLATE_FILE_CHANNELS),
      ].sort()
    );
    expect(ipc.handlers.size).toBe(12);
  });

  it('wires desktop import to the composed import use case', async () => {
    const startup = startCustomTeamTemplatesFeature(internalStorage());
    expect(startup.importTemplate).toBe(featureMock.importTemplate);

    const handler = ipc.handlers.get(CUSTOM_TEAM_TEMPLATE_FILE_CHANNELS.importFromFile);
    expect(handler).toBeTypeOf('function');
  });

  it('removes every handler and disposes the composed feature once', () => {
    const startup = startCustomTeamTemplatesFeature(internalStorage());
    expect(ipc.handlers.size).toBe(12);

    startup.dispose();

    expect(ipc.handlers.size).toBe(0);
    expect(ipc.removeHandler).toHaveBeenCalledTimes(12);
    expect(featureMock.dispose).toHaveBeenCalledTimes(1);
  });
});
