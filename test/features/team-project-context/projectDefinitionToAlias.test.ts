import { describe, expect, it, vi } from 'vitest';

import { projectDefinitionToAlias } from '../../../src/features/team-project-context/main/projectDefinitionToAlias';

function ports() {
  return {
    assertStoppedForSync: vi.fn(async (_name: string) => undefined),
    replaceMembers: vi.fn(async () => undefined),
    updateDisplayMetadata: vi.fn(async () => undefined),
    launchSettings: { save: vi.fn(async () => undefined) },
  };
}

const alias = (patch: object = {}) => ({
  teamName: 'ptc-a',
  members: [{ name: 'alice', role: 'dev' }],
  description: 'Old',
  color: 'blue',
  ...patch,
});

describe('projectDefinitionToAlias', () => {
  it('does nothing, and does not even demand a stopped runtime, when nothing differs', async () => {
    const p = ports();
    const result = await projectDefinitionToAlias(
      p,
      { members: [{ name: 'alice', role: 'dev' }], description: 'Old', color: 'blue' },
      alias()
    );
    expect(result).toEqual({ roster: false, metadata: false, launchSettings: false });
    expect(p.assertStoppedForSync).not.toHaveBeenCalled();
    expect(p.replaceMembers).not.toHaveBeenCalled();
    expect(p.updateDisplayMetadata).not.toHaveBeenCalled();
  });

  it('ignores runtime-only member fields and whitespace-only metadata differences', async () => {
    const p = ports();
    const result = await projectDefinitionToAlias(
      p,
      { members: [{ name: 'alice', role: 'dev' }], description: ' Old ', color: 'blue ' },
      alias({ members: [{ name: 'alice', role: 'dev', cwd: '/generated/worktree' }] })
    );
    expect(result).toEqual({ roster: false, metadata: false, launchSettings: false });
    expect(p.replaceMembers).not.toHaveBeenCalled();
  });

  it('projects a changed roster with the logical members and keeps metadata alone', async () => {
    const p = ports();
    const members = [{ name: 'alice', role: 'lead dev' }, { name: 'bob' }];
    const result = await projectDefinitionToAlias(
      p,
      { members, description: 'Old', color: 'blue' },
      alias()
    );
    expect(result).toEqual({ roster: true, metadata: false, launchSettings: false });
    expect(p.assertStoppedForSync).toHaveBeenCalledWith('ptc-a');
    expect(p.replaceMembers).toHaveBeenCalledWith('ptc-a', { members });
    expect(p.updateDisplayMetadata).not.toHaveBeenCalled();
  });

  it('projects changed description and color, clearing them when the logical team has none', async () => {
    const p = ports();
    const result = await projectDefinitionToAlias(
      p,
      { members: [{ name: 'alice', role: 'dev' }], description: undefined, color: 'green' },
      alias()
    );
    expect(result).toEqual({ roster: false, metadata: true, launchSettings: false });
    expect(p.updateDisplayMetadata).toHaveBeenCalledWith('ptc-a', {
      description: '',
      color: 'green',
    });
    expect(p.replaceMembers).not.toHaveBeenCalled();
  });

  it('refuses to write anything when the project runtime is not confirmed stopped', async () => {
    const p = ports();
    p.assertStoppedForSync.mockRejectedValue(new Error('Stop this project runtime'));
    await expect(
      projectDefinitionToAlias(
        p,
        { members: [{ name: 'bob' }], description: 'New', color: 'red' },
        alias()
      )
    ).rejects.toThrow('Stop this project runtime');
    expect(p.replaceMembers).not.toHaveBeenCalled();
    expect(p.updateDisplayMetadata).not.toHaveBeenCalled();
  });

  it('projects a renamed team: the runtime reads the name of the copy, its directory identity stays', async () => {
    const p = ports();
    const result = await projectDefinitionToAlias(
      p,
      { members: [{ name: 'alice', role: 'dev' }], displayName: ' New name ', description: 'Old', color: 'blue' },
      alias({ displayName: 'Old name' })
    );
    expect(result).toEqual({ roster: false, metadata: true, launchSettings: false });
    expect(p.updateDisplayMetadata).toHaveBeenCalledWith('ptc-a', {
      name: 'New name',
      description: 'Old',
      color: 'blue',
    });
  });

  it('never blanks the name of a copy when the definition has no name', async () => {
    const p = ports();
    const result = await projectDefinitionToAlias(
      p,
      { members: [{ name: 'alice', role: 'dev' }], displayName: '  ', description: 'Old', color: 'blue' },
      alias({ displayName: 'Kept' })
    );
    expect(result).toEqual({ roster: false, metadata: false, launchSettings: false });
  });

  describe('saved lead instructions', () => {
    const logicalBase = { members: [{ name: 'alice', role: 'dev' }], description: 'Old', color: 'blue' };

    it('projects a changed prompt with the other metadata, and only when it differs', async () => {
      const p = ports();
      const result = await projectDefinitionToAlias(
        p,
        { ...logicalBase, prompt: ' Be brief ' },
        alias({ prompt: 'Old prompt' })
      );
      expect(result).toEqual({ roster: false, metadata: true, launchSettings: false });
      expect(p.assertStoppedForSync).toHaveBeenCalledWith('ptc-a');
      expect(p.updateDisplayMetadata).toHaveBeenCalledWith('ptc-a', {
        description: 'Old',
        color: 'blue',
        prompt: 'Be brief',
      });
      expect(p.replaceMembers).not.toHaveBeenCalled();
    });

    it('clears the prompt of a copy when the definition has none', async () => {
      const p = ports();
      await projectDefinitionToAlias(p, logicalBase, alias({ prompt: 'Stale launch prompt' }));
      expect(p.updateDisplayMetadata).toHaveBeenCalledWith('ptc-a', {
        description: 'Old',
        color: 'blue',
        prompt: '',
      });
    });

    it('does nothing, and does not demand a stopped runtime, when the prompts only differ by whitespace', async () => {
      const p = ports();
      const result = await projectDefinitionToAlias(
        p,
        { ...logicalBase, prompt: ' Same ' },
        alias({ prompt: 'Same' })
      );
      expect(result).toEqual({ roster: false, metadata: false, launchSettings: false });
      expect(p.assertStoppedForSync).not.toHaveBeenCalled();
      expect(p.updateDisplayMetadata).not.toHaveBeenCalled();
    });

    it('refuses to change the prompt of a copy that is not confirmed stopped', async () => {
      const p = ports();
      p.assertStoppedForSync.mockRejectedValue(new Error('Stop this project runtime'));
      await expect(
        projectDefinitionToAlias(p, { ...logicalBase, prompt: 'New' }, alias({ prompt: 'Old' }))
      ).rejects.toThrow('Stop this project runtime');
      expect(p.updateDisplayMetadata).not.toHaveBeenCalled();
    });
  });

  describe('team-level launch settings', () => {
    const base = { members: [{ name: 'alice', role: 'dev' }], description: 'Old', color: 'blue' };

    it('projects only the launch settings that differ, into a copy confirmed stopped', async () => {
      const p = ports();
      const result = await projectDefinitionToAlias(
        p,
        { ...base, providerId: 'codex', model: 'gpt-x', effort: 'high', limitContext: true },
        alias({ providerId: 'codex', model: 'gpt-old', effort: 'high', limitContext: false })
      );
      expect(result).toEqual({ roster: false, metadata: false, launchSettings: true });
      expect(p.launchSettings.save).toHaveBeenCalledWith('ptc-a', { model: 'gpt-x', limitContext: true });
      expect(p.assertStoppedForSync).toHaveBeenCalledOnce();
      expect(p.replaceMembers).not.toHaveBeenCalled();
      expect(p.updateDisplayMetadata).not.toHaveBeenCalled();
    });

    it('clears a setting of the copy when the definition has gone back to the default', async () => {
      const p = ports();
      await projectDefinitionToAlias(
        p,
        { ...base, providerId: 'codex', effort: undefined },
        alias({ providerId: 'codex', effort: 'high' })
      );
      expect(p.launchSettings.save).toHaveBeenCalledWith('ptc-a', { effort: undefined });
    });

    it('does nothing when the copy already has the definition settings', async () => {
      const p = ports();
      const result = await projectDefinitionToAlias(
        p,
        { ...base, providerId: 'codex', model: 'm' },
        alias({ providerId: 'codex', model: 'm' })
      );
      expect(result.launchSettings).toBe(false);
      expect(p.launchSettings.save).not.toHaveBeenCalled();
      expect(p.assertStoppedForSync).not.toHaveBeenCalled();
    });

    it('skips a copy that is not confirmed stopped, silently, and still projects nothing else', async () => {
      const p = ports();
      p.assertStoppedForSync.mockRejectedValue(new Error('Stop this project runtime'));
      const result = await projectDefinitionToAlias(
        p,
        { ...base, providerId: 'codex', model: 'new' },
        alias({ providerId: 'codex', model: 'old' })
      );
      expect(result).toEqual({ roster: false, metadata: false, launchSettings: false });
      expect(p.launchSettings.save).not.toHaveBeenCalled();
    });

    it('never takes per-project trust, runtime arguments or place from the definition', async () => {
      const p = ports();
      const logical = {
        ...base,
        providerId: 'codex' as const,
        skipPermissions: true,
        worktree: 'wt',
        extraCliArgs: '--add-dir /a',
        cwd: '/a',
      };
      const result = await projectDefinitionToAlias(
        p,
        logical,
        alias({
          providerId: 'codex',
          skipPermissions: false,
          worktree: undefined,
          extraCliArgs: undefined,
          cwd: '/b',
        })
      );
      expect(result.launchSettings).toBe(false);
      expect(p.launchSettings.save).not.toHaveBeenCalled();
    });

    it('does not clear the provider of a copy when the definition has none', async () => {
      const p = ports();
      await projectDefinitionToAlias(
        p,
        { ...base, providerId: undefined, providerBackendId: 'b' as never, model: 'm' },
        alias({ providerId: 'codex', model: 'old' })
      );
      expect(p.launchSettings.save).toHaveBeenCalledWith('ptc-a', { model: 'm' });
    });

    it('still refuses a roster change on a running copy and writes no launch settings then', async () => {
      const p = ports();
      p.assertStoppedForSync.mockRejectedValue(new Error('Stop this project runtime'));
      await expect(
        projectDefinitionToAlias(
          p,
          { ...base, members: [{ name: 'bob' }], model: 'new' },
          alias({ model: 'old' })
        )
      ).rejects.toThrow('Stop this project runtime');
      expect(p.launchSettings.save).not.toHaveBeenCalled();
    });
  });
});
