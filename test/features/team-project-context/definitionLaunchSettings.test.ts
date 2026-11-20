import { describe, expect, it, vi } from 'vitest';

import {
  changedDefinitionLaunchSettings,
  pickDefinitionLaunchSettings,
  recordLaunchSettings,
} from '../../../src/features/team-project-context/main/definitionLaunchSettings';

describe('pickDefinitionLaunchSettings', () => {
  it('takes only team-level settings and never trust, place, prompt or run identity', () => {
    const picked = pickDefinitionLaunchSettings({
      providerId: 'codex',
      model: 'm',
      skipPermissions: true,
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

describe('recordLaunchSettings', () => {
  it('saves what the launch stated into the logical team', async () => {
    const store = { save: vi.fn(async () => undefined) };
    const saved = await recordLaunchSettings(store, 'builders', {
      providerId: 'codex',
      model: 'm',
      limitContext: true,
      skipPermissions: true,
    } as never);
    expect(saved).toBe(true);
    expect(store.save).toHaveBeenCalledWith('builders', {
      providerId: 'codex',
      model: 'm',
      limitContext: true,
    });
  });

  it('saves nothing for a launch that states no team-level setting', async () => {
    const store = { save: vi.fn(async () => undefined) };
    expect(await recordLaunchSettings(store, 'builders', { skipPermissions: true } as never)).toBe(
      false
    );
    expect(store.save).not.toHaveBeenCalled();
  });
});
