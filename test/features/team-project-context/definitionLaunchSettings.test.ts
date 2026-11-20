import { describe, expect, it, vi } from 'vitest';

import {
  changedDefinitionLaunchSettings,
  DEFINITION_LAUNCH_SETTING_KEYS,
  pickDefinitionLaunchSettings,
  recordLaunchSettings,
  resolveLaunchSettings,
  TEAM_META_FIELD_OWNER,
} from '../../../src/features/team-project-context/main/definitionLaunchSettings';

import type { DefinitionLaunchSettingsStore } from '../../../src/features/team-project-context/main/definitionLaunchSettings';

function store(saved: Awaited<ReturnType<DefinitionLaunchSettingsStore['read']>> = {}) {
  return {
    read: vi.fn(async () => saved),
    save: vi.fn(async (_team: string, _settings: object) => undefined),
  };
}

describe('who owns the saved fields', () => {
  it('keeps trust, runtime arguments, place and run identity with the project copy', () => {
    for (const key of ['skipPermissions', 'extraCliArgs', 'worktree', 'cwd', 'launchIdentity'] as const) {
      expect(TEAM_META_FIELD_OWNER[key]).toBe('project');
      expect(DEFINITION_LAUNCH_SETTING_KEYS).not.toContain(key);
    }
  });

  it('shares the runtime and model choice of the team', () => {
    expect([...DEFINITION_LAUNCH_SETTING_KEYS].sort()).toEqual(
      [
        'effort',
        'fastMode',
        'limitContext',
        'model',
        'providerBackendId',
        'providerId',
        'syncModelsWithLead',
      ].sort()
    );
  });
});

describe('pickDefinitionLaunchSettings', () => {
  it('takes only team-level settings and never trust, place, prompt or run identity', () => {
    const picked = pickDefinitionLaunchSettings({
      providerId: 'codex',
      model: 'm',
      skipPermissions: true,
      extraCliArgs: '--add-dir /x',
      worktree: 'wt',
      cwd: '/a',
      prompt: 'p',
      launchIdentity: { x: 1 },
      teamName: 'ptc-a',
    } as never);
    expect(picked).toEqual({ providerId: 'codex', model: 'm' });
  });

  it('keeps an omitted key out and an explicit undefined in, so a launch can go back to the default', () => {
    const picked = pickDefinitionLaunchSettings({ providerId: 'codex', effort: undefined });
    expect(Object.keys(picked).sort()).toEqual(['effort', 'providerId']);
  });

  it('never clears the provider and drops the backend that belongs to it', () => {
    expect(
      pickDefinitionLaunchSettings({ providerId: undefined, providerBackendId: 'api', model: 'm' })
    ).toEqual({ model: 'm' });
  });
});

describe('changedDefinitionLaunchSettings', () => {
  it('returns only the differing keys of the definition', () => {
    expect(
      changedDefinitionLaunchSettings(
        { providerId: 'codex', model: 'new', fastMode: 'on' },
        { providerId: 'codex', model: 'old', fastMode: 'on' }
      )
    ).toEqual({ model: 'new' });
  });

  it('is empty for a definition that states nothing', () => {
    expect(changedDefinitionLaunchSettings({}, { model: 'x' })).toEqual({});
  });
});

describe('resolveLaunchSettings', () => {
  const saved = { providerId: 'codex' as const, model: 'gpt-x', effort: 'high' as const, limitContext: true };

  it('keeps what the launch did not state when the provider is the same', () => {
    expect(resolveLaunchSettings({ providerId: 'codex', model: 'gpt-y' }, saved)).toEqual({
      providerId: 'codex',
      model: 'gpt-y',
    });
  });

  it('drops what belonged to the old provider on a provider change, like the native launch', () => {
    const resolved = resolveLaunchSettings({ providerId: 'anthropic' }, saved);
    expect(resolved).toEqual({
      providerId: 'anthropic',
      providerBackendId: undefined,
      model: undefined,
      effort: undefined,
      fastMode: undefined,
      limitContext: undefined,
    });
    expect(Object.keys(resolved)).toContain('model');
  });

  it('keeps what the launch states again on a provider change, and the team-wide setting', () => {
    expect(
      resolveLaunchSettings({ providerId: 'anthropic', model: 'opus', syncModelsWithLead: false }, saved)
    ).toMatchObject({ providerId: 'anthropic', model: 'opus', effort: undefined, syncModelsWithLead: false });
  });
});

describe('recordLaunchSettings', () => {
  const target = { definition: 'builders', copy: 'ptc-a' };

  it('saves what the launch stated into the team and the launched copy', async () => {
    const s = store({ providerId: 'codex' });
    const result = await recordLaunchSettings(s, target, {
      providerId: 'codex',
      model: 'm',
      limitContext: true,
      skipPermissions: true,
    } as never);
    expect(result).toEqual({ recorded: true });
    const settings = { providerId: 'codex', model: 'm', limitContext: true };
    expect(s.save.mock.calls).toEqual([
      ['builders', settings],
      ['ptc-a', settings],
    ]);
  });

  it('resets the settings of the old provider on a provider change', async () => {
    const s = store({ providerId: 'codex', model: 'gpt-x' });
    await recordLaunchSettings(s, target, { providerId: 'anthropic' });
    expect(s.save).toHaveBeenCalledWith('builders', expect.objectContaining({ providerId: 'anthropic', model: undefined }));
  });

  it('saves nothing for a launch that states no team-level setting', async () => {
    const s = store();
    expect(await recordLaunchSettings(s, target, { skipPermissions: true } as never)).toEqual({
      recorded: false,
    });
    expect(s.save).not.toHaveBeenCalled();
    expect(s.read).not.toHaveBeenCalled();
  });

  it('throws when the definition cannot be saved and never touches the copy then', async () => {
    const s = store();
    s.save.mockRejectedValueOnce(new Error('disk full'));
    await expect(recordLaunchSettings(s, target, { model: 'm' })).rejects.toThrow('disk full');
    expect(s.save).toHaveBeenCalledOnce();
  });

  it('reports a copy that could not be saved: the definition is already right', async () => {
    const s = store();
    s.save.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('copy locked'));
    const result = await recordLaunchSettings(s, target, { model: 'm' });
    expect(result.recorded).toBe(true);
    expect(String(result.copyFailure)).toContain('copy locked');
  });
});
