// @vitest-environment node
import { CUSTOM_TEAM_TEMPLATE_CHANNELS } from '@features/custom-team-templates/contracts';
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

const CHANNELS = Object.values(CUSTOM_TEAM_TEMPLATE_CHANNELS);
const BACKEND = { kind: 'templates-backend' };

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
    expect(hoisted.handle.mock.calls.map(([channel]) => channel).sort()).toEqual(
      [...CHANNELS].sort()
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

    expect(hoisted.removeHandler.mock.calls.map(([channel]) => channel).sort()).toEqual(
      [...CHANNELS].sort()
    );
    expect(hoisted.featureDispose).toHaveBeenCalledTimes(1);
  });
});
