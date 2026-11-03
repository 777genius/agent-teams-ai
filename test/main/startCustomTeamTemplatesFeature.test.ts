// @vitest-environment node
import {
  CUSTOM_TEAM_TEMPLATE_CHANNELS,
  CUSTOM_TEAM_TEMPLATE_FILE_CHANNELS,
} from '@features/custom-team-templates/contracts';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => {
  const handle = vi.fn();
  const removeHandler = vi.fn();
  const featureDispose = vi.fn();
  const feature = {
    preparePreview: { kind: 'preparePreview' },
    saveTemplate: { kind: 'saveTemplate' },
    recheckSave: { kind: 'recheckSave' },
    listTemplates: { kind: 'listTemplates' },
    dispose: featureDispose,
  };
  return {
    handle,
    removeHandler,
    feature,
    featureDispose,
    createCustomTeamTemplatesFeature: vi.fn(() => feature),
  };
});

vi.mock('electron', () => ({
  ipcMain: { handle: hoisted.handle, removeHandler: hoisted.removeHandler },
}));

vi.mock('@features/custom-team-templates/main', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@features/custom-team-templates/main')>()),
  createCustomTeamTemplatesFeature: hoisted.createCustomTeamTemplatesFeature,
}));

const { startCustomTeamTemplatesFeature } = await import('@main/startCustomTeamTemplatesFeature');

import type { InternalStorageFeature } from '@features/internal-storage/main';

// Both authoritative channel definitions: the shared data channels and the two
// desktop-only file channels that startup also registers.
const CHANNELS = [
  ...Object.values(CUSTOM_TEAM_TEMPLATE_CHANNELS),
  ...Object.values(CUSTOM_TEAM_TEMPLATE_FILE_CHANNELS),
];
const BACKEND = { kind: 'templates-backend' };

function registeredChannels(): string[] {
  return hoisted.handle.mock.calls.map(([channel]) => String(channel));
}

function removedChannels(): string[] {
  return hoisted.removeHandler.mock.calls.map(([channel]) => String(channel));
}

const byChannelName = (left: string, right: string): number => left.localeCompare(right);

/** Every expected channel exactly once, with no duplicates or stragglers. */
function expectExactlyChannels(channels: string[]): void {
  expect(channels).toHaveLength(CHANNELS.length);
  expect(new Set(channels).size).toBe(CHANNELS.length);
  expect([...channels].sort(byChannelName)).toEqual([...CHANNELS].sort(byChannelName));
}

function internalStorage(): InternalStorageFeature {
  return { customTeamTemplatesBackend: BACKEND } as unknown as InternalStorageFeature;
}

beforeEach(() => {
  hoisted.handle.mockClear();
  hoisted.removeHandler.mockClear();
  hoisted.featureDispose.mockClear();
  hoisted.createCustomTeamTemplatesFeature.mockClear();
});

describe('startCustomTeamTemplatesFeature', () => {
  it('composes over the supplied storage backend and registers the IPC bridge', () => {
    const startup = startCustomTeamTemplatesFeature(internalStorage());

    expect(hoisted.createCustomTeamTemplatesFeature).toHaveBeenCalledExactlyOnceWith({
      backend: BACKEND,
    });
    expectExactlyChannels(registeredChannels());
    // The desktop file channels must be part of the actual startup surface, not
    // just the shared data channels.
    expect(registeredChannels()).toEqual(
      expect.arrayContaining(Object.values(CUSTOM_TEAM_TEMPLATE_FILE_CHANNELS))
    );
    // The startup surface is the composed feature plus a bridge-aware disposer.
    expect(startup.preparePreview).toBe(hoisted.feature.preparePreview);
    expect(startup.listTemplates).toBe(hoisted.feature.listTemplates);
  });

  it('keeps a null backend an explicit unavailable-storage composition', () => {
    startCustomTeamTemplatesFeature({
      customTeamTemplatesBackend: null,
    } as unknown as InternalStorageFeature);

    expect(hoisted.createCustomTeamTemplatesFeature).toHaveBeenCalledExactlyOnceWith({
      backend: null,
    });
  });

  it('disposes both the bridge and the retained preview state', () => {
    const startup = startCustomTeamTemplatesFeature(internalStorage());

    startup.dispose();

    expectExactlyChannels(removedChannels());
    expect(removedChannels()).toEqual(
      expect.arrayContaining(Object.values(CUSTOM_TEAM_TEMPLATE_FILE_CHANNELS))
    );
    expect(hoisted.featureDispose).toHaveBeenCalledTimes(1);
  });
});
