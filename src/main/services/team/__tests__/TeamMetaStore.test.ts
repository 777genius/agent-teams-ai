import * as fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const atomicWriteAsync = vi.hoisted(() =>
  vi.fn(async (_path: string, _content: string) => undefined)
);

vi.mock('../atomicWrite', () => ({ atomicWriteAsync }));

import { TeamMetaStore } from '../TeamMetaStore';

import type { TeamMetaFile } from '../TeamMetaStore';
import type { ProviderModelLaunchIdentity, TeamProviderBackendId } from '@shared/types';

const initialMeta: TeamMetaFile = {
  version: 1,
  cwd: '/sandbox/team',
  model: 'old-model',
  effort: 'low',
  createdAt: 1,
};

function launchIdentity(providerBackendId: TeamProviderBackendId): ProviderModelLaunchIdentity {
  return {
    providerId: 'codex',
    providerBackendId,
    selectedModel: 'gpt-5',
    selectedModelKind: 'explicit',
    resolvedLaunchModel: 'gpt-5',
    catalogId: 'gpt-5',
    catalogSource: 'runtime',
    catalogFetchedAt: null,
    selectedEffort: 'high',
    resolvedEffort: 'high',
  };
}

describe('TeamMetaStore', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('serializes writes behind an in-flight metadata read-modify-write', async () => {
    const updatingStore = new TeamMetaStore();
    const writingStore = new TeamMetaStore();
    vi.spyOn(updatingStore, 'getMeta').mockResolvedValue(initialMeta);
    let releaseUpdate!: () => void;
    const updateGate = new Promise<void>((resolve) => {
      releaseUpdate = resolve;
    });
    let updateRead!: () => void;
    const updateReadSignal = new Promise<void>((resolve) => {
      updateRead = resolve;
    });
    const update = updatingStore.updateMeta('alpha', async (current) => {
      updateRead();
      await updateGate;
      if (!current) throw new Error('missing metadata');
      return { ...current, model: 'new-model', effort: 'high' };
    });
    await updateReadSignal;

    const write = writingStore.writeMeta('alpha', {
      cwd: '/sandbox/team',
      model: 'other-model',
      effort: 'medium',
      createdAt: 1,
    });
    await Promise.resolve();
    expect(atomicWriteAsync).not.toHaveBeenCalled();

    releaseUpdate();
    await Promise.all([update, write]);

    expect(atomicWriteAsync).toHaveBeenCalledTimes(2);
    expect(JSON.parse(atomicWriteAsync.mock.calls[0]?.[1])).toMatchObject({
      model: 'new-model',
      effort: 'high',
    });
    expect(JSON.parse(atomicWriteAsync.mock.calls[1]?.[1])).toMatchObject({
      model: 'other-model',
      effort: 'medium',
    });
  });

  it.each(['auto', 'adapter', 'api', 'codex-native'] as const)(
    'round-trips current-schema root and launch identity backend %s across restart',
    async (providerBackendId) => {
      const store = new TeamMetaStore();
      await store.writeMeta('alpha', {
        cwd: '/sandbox/team',
        providerId: 'codex',
        providerBackendId,
        launchIdentity: launchIdentity(providerBackendId),
        createdAt: 1,
      });
      const raw = atomicWriteAsync.mock.calls[0]?.[1];
      if (!raw) throw new Error('expected metadata write');
      expect(JSON.parse(raw)).toMatchObject({
        version: 2,
        providerBackendId,
        launchIdentity: { providerBackendId },
      });

      vi.spyOn(fs.promises, 'stat').mockResolvedValue({
        isFile: () => true,
        size: raw.length,
      } as fs.Stats);
      vi.spyOn(fs.promises, 'readFile').mockResolvedValue(raw);
      await expect(new TeamMetaStore().getMeta('alpha')).resolves.toMatchObject({
        version: 2,
        providerBackendId,
        launchIdentity: { providerBackendId },
      });
    }
  );

  it('round-trips lead Default provenance while old metadata remains readable without it', async () => {
    const store = new TeamMetaStore();
    await store.writeMeta('alpha', {
      cwd: '/sandbox/team',
      providerId: 'codex',
      providerBackendId: 'codex-native',
      model: 'gpt-5',
      effort: 'high',
      leadRuntimeSelectionProvenance: {
        version: 1,
        providerBackendId: 'default',
        model: 'default',
        effort: 'default',
      },
      createdAt: 1,
    });
    const raw = atomicWriteAsync.mock.calls[0]?.[1];
    if (!raw) throw new Error('expected metadata write');

    vi.spyOn(fs.promises, 'stat').mockResolvedValue({
      isFile: () => true,
      size: raw.length,
    } as fs.Stats);
    const read = vi.spyOn(fs.promises, 'readFile');
    read.mockResolvedValueOnce(raw);
    await expect(store.getMeta('alpha')).resolves.toMatchObject({
      model: 'gpt-5',
      leadRuntimeSelectionProvenance: {
        model: 'default',
        effort: 'default',
      },
    });

    read.mockResolvedValueOnce(
      JSON.stringify({ version: 1, cwd: '/sandbox/team', model: 'gpt-5', createdAt: 1 })
    );
    await expect(store.getMeta('alpha')).resolves.toMatchObject({
      model: 'gpt-5',
      leadRuntimeSelectionProvenance: undefined,
    });
  });

  it.each(['auto', 'adapter', 'api', 'codex-native'] as const)(
    'migrates legacy root and launch identity backend %s conservatively',
    async (providerBackendId) => {
      vi.spyOn(fs.promises, 'stat').mockResolvedValue({
        isFile: () => true,
        size: 256,
      } as fs.Stats);
      vi.spyOn(fs.promises, 'readFile').mockResolvedValue(
        JSON.stringify({
          ...initialMeta,
          providerId: 'codex',
          providerBackendId,
          launchIdentity: launchIdentity(providerBackendId),
        })
      );

      await expect(new TeamMetaStore().getMeta('alpha')).resolves.toMatchObject({
        version: 1,
        providerBackendId: 'codex-native',
        launchIdentity: { providerBackendId: 'codex-native' },
      });
    }
  );

  it('accepts missing-version legacy metadata and rejects an unknown version', async () => {
    vi.spyOn(fs.promises, 'stat').mockResolvedValue({
      isFile: () => true,
      size: 128,
    } as fs.Stats);
    const read = vi.spyOn(fs.promises, 'readFile');
    read.mockResolvedValueOnce(
      JSON.stringify({ cwd: '/sandbox/team', providerId: 'codex', providerBackendId: 'api' })
    );
    await expect(new TeamMetaStore().getMeta('alpha')).resolves.toMatchObject({
      version: 1,
      providerBackendId: 'codex-native',
    });

    read.mockResolvedValueOnce(
      JSON.stringify({
        version: 999,
        cwd: '/sandbox/team',
        providerId: 'codex',
        providerBackendId: 'api',
      })
    );
    await expect(new TeamMetaStore().getMeta('alpha')).resolves.toBeNull();
  });

  it('keeps an incompatible identity provider atomic while degrading its backend to unknown', async () => {
    vi.spyOn(fs.promises, 'stat').mockResolvedValue({
      isFile: () => true,
      size: 512,
    } as fs.Stats);
    vi.spyOn(fs.promises, 'readFile').mockResolvedValue(
      JSON.stringify({
        version: 2,
        cwd: '/sandbox/team',
        providerId: 'codex',
        providerBackendId: 'api',
        launchIdentity: {
          ...launchIdentity('codex-native'),
          providerId: 'gemini',
          providerBackendId: 'codex-native',
        },
        createdAt: 1,
      })
    );

    await expect(new TeamMetaStore().getMeta('alpha')).resolves.toMatchObject({
      providerId: 'codex',
      providerBackendId: 'api',
      launchIdentity: { providerId: 'gemini', providerBackendId: null },
    });
  });

  it('does not replace a corrupt Codex identity backend with a valid Gemini root backend', async () => {
    vi.spyOn(fs.promises, 'stat').mockResolvedValue({
      isFile: () => true,
      size: 512,
    } as fs.Stats);
    vi.spyOn(fs.promises, 'readFile').mockResolvedValue(
      JSON.stringify({
        version: 2,
        cwd: '/sandbox/team',
        providerId: 'gemini',
        providerBackendId: 'api',
        launchIdentity: {
          ...launchIdentity('codex-native'),
          providerId: 'codex',
          providerBackendId: 'opencode-cli',
        },
        createdAt: 1,
      })
    );

    await expect(new TeamMetaStore().getMeta('alpha')).resolves.toMatchObject({
      providerId: 'gemini',
      providerBackendId: 'api',
      launchIdentity: { providerId: 'codex', providerBackendId: null },
    });
  });
});
