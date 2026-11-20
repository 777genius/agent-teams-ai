import { describe, expect, it, vi } from 'vitest';

import { projectDefinitionToAlias } from '../../../src/features/team-project-context/main/projectDefinitionToAlias';

function ports() {
  return {
    assertStoppedForSync: vi.fn(async (_name: string) => undefined),
    replaceMembers: vi.fn(async () => undefined),
    updateDisplayMetadata: vi.fn(async () => undefined),
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
    expect(result).toEqual({ roster: false, metadata: false });
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
    expect(result).toEqual({ roster: false, metadata: false });
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
    expect(result).toEqual({ roster: true, metadata: false });
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
    expect(result).toEqual({ roster: false, metadata: true });
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
    expect(result).toEqual({ roster: false, metadata: true });
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
    expect(result).toEqual({ roster: false, metadata: false });
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
      expect(result).toEqual({ roster: false, metadata: true });
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
      expect(result).toEqual({ roster: false, metadata: false });
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
});
