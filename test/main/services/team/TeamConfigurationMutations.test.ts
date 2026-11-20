import { describe, expect, it, vi } from 'vitest';

import { updateTeamConfiguration } from '../../../../src/main/services/team/TeamConfigurationMutations';

import type { TeamConfigurationMutationStores } from '../../../../src/main/services/team/TeamConfigurationMutations';
import type { TeamMetaFile } from '../../../../src/main/services/team/TeamMetaStore';

function stores(options: { config?: object | null; meta?: Partial<TeamMetaFile> | null }) {
  let meta: TeamMetaFile | null = options.meta
    ? ({ version: 1, cwd: '/p', createdAt: 1, ...options.meta } as TeamMetaFile)
    : null;
  const configReader = {
    getConfig: vi.fn(async () => options.config ?? null),
    updateConfig: vi.fn(async (_name: string, updates: object) => ({
      ...(options.config ?? {}),
      ...updates,
    })),
  };
  const teamMetaStore = {
    getMeta: vi.fn(async () => meta),
    serializeMeta: vi.fn((data: object) => JSON.stringify(data)),
    updateMeta: vi.fn(
      async (_name: string, update: (current: TeamMetaFile | null) => Omit<TeamMetaFile, 'version'>) => {
        meta = { version: 1, ...update(meta) } as TeamMetaFile;
      }
    ),
  };
  const invalidate = vi.fn();
  return {
    configReader,
    teamMetaStore,
    invalidate,
    saved: () => meta,
    all: { configReader, teamMetaStore, invalidate } as unknown as TeamConfigurationMutationStores,
  };
}

describe('updateTeamConfiguration for a per-project team definition', () => {
  it('writes name, description and color to the definition metadata when there is no config.json', async () => {
    const s = stores({
      meta: { projectContextMode: 'per_project', displayName: 'Old', description: 'Old text' },
    });
    const result = await updateTeamConfiguration(
      'builders',
      { name: '  Builders  ', description: ' New text ', color: ' green ' },
      s.all
    );
    expect(s.saved()).toMatchObject({
      projectContextMode: 'per_project',
      displayName: 'Builders',
      description: 'New text',
      color: 'green',
    });
    expect(result).toEqual({ name: 'Builders', description: 'New text', color: 'green' });
    expect(s.configReader.updateConfig).not.toHaveBeenCalled();
    expect(s.invalidate).toHaveBeenCalledWith('builders');
  });

  it('clears the description and color when they are emptied and keeps the name when blank', async () => {
    const s = stores({
      meta: {
        projectContextMode: 'per_project',
        displayName: 'Builders',
        description: 'Text',
        color: 'red',
      },
    });
    const result = await updateTeamConfiguration(
      'builders',
      { name: '   ', description: '', color: '' },
      s.all
    );
    expect(s.saved()?.displayName).toBe('Builders');
    expect(s.saved()?.description).toBeUndefined();
    expect(s.saved()?.color).toBeUndefined();
    expect(result).toEqual({ name: 'Builders' });
  });

  it('refuses a trashed definition', async () => {
    const s = stores({
      meta: { projectContextMode: 'per_project', deletedAt: '2026-01-01T00:00:00.000Z' },
    });
    await expect(updateTeamConfiguration('builders', { name: 'x' }, s.all)).rejects.toThrow(
      'TEAM_TRASHED'
    );
    expect(s.teamMetaStore.updateMeta).not.toHaveBeenCalled();
  });

  it('still reports a missing team for any config-less team that is not a per-project definition', async () => {
    const shared = stores({ meta: { projectContextMode: 'shared' } });
    await expect(updateTeamConfiguration('draft', { name: 'x' }, shared.all)).rejects.toThrow(
      'Team not found: draft'
    );
    const none = stores({ meta: null });
    await expect(updateTeamConfiguration('ghost', { name: 'x' }, none.all)).rejects.toThrow(
      'Team not found: ghost'
    );
    expect(shared.teamMetaStore.updateMeta).not.toHaveBeenCalled();
  });

  it('keeps the existing config.json path for a team that has a config', async () => {
    const s = stores({ config: { name: 'Native' }, meta: { displayName: 'Native' } });
    await updateTeamConfiguration('native', { description: 'Text' }, s.all);
    expect(s.configReader.updateConfig).toHaveBeenCalledWith('native', { description: 'Text' });
  });
});

describe('updateTeamConfiguration with lead instructions', () => {
  it('saves the prompt of a per-project definition trimmed, without creating a config', async () => {
    const s = stores({ meta: { projectContextMode: 'per_project', displayName: 'Builders' } });
    await updateTeamConfiguration('builders', { prompt: '  Be brief  ' }, s.all);
    expect(s.saved()).toMatchObject({ projectContextMode: 'per_project', prompt: 'Be brief' });
    expect(s.configReader.updateConfig).not.toHaveBeenCalled();
  });

  it('clears the saved prompt when it is emptied and keeps it when it is not part of the update', async () => {
    const s = stores({
      meta: { projectContextMode: 'per_project', displayName: 'Builders', prompt: 'Old' },
    });
    await updateTeamConfiguration('builders', { description: 'Text' }, s.all);
    expect(s.saved()?.prompt).toBe('Old');
    await updateTeamConfiguration('builders', { prompt: '   ' }, s.all);
    expect(s.saved()?.prompt).toBeUndefined();
  });

  it('keeps the prompt in team.meta.json only for a team that has a config.json', async () => {
    const s = stores({ config: { name: 'Native' }, meta: { displayName: 'Native' } });
    await updateTeamConfiguration('native', { description: 'Text', prompt: 'Lead text' }, s.all);
    expect(s.saved()?.prompt).toBe('Lead text');
    expect(s.configReader.updateConfig).toHaveBeenCalledWith('native', { description: 'Text' });
  });

  it('refuses a prompt for a team without saved launch settings instead of dropping it', async () => {
    const s = stores({ config: { name: 'Imported' }, meta: null });
    await expect(
      updateTeamConfiguration('imported', { prompt: 'Lead text' }, s.all)
    ).rejects.toThrow('no saved launch settings');
    expect(s.configReader.updateConfig).not.toHaveBeenCalled();
    expect(s.teamMetaStore.updateMeta).not.toHaveBeenCalled();
  });
});
