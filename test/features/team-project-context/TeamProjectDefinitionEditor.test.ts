import { describe, expect, it, vi } from 'vitest';

import { TeamProjectDefinitionEditor } from '../../../src/features/team-project-context/main/TeamProjectDefinitionEditor';

import type { TeamCreateRequest, TeamProjectContextMode } from '../../../src/shared/types/team';

type Saved = Partial<TeamCreateRequest> & { teamName: string };

function fixture(options: {
  modes?: Record<string, TeamProjectContextMode | Error>;
  aliases?: string[];
  contexts?: { executionTeamName: string; state: 'ready' | 'reserved' }[];
  saved?: Record<string, Saved>;
}) {
  const registry = {
    list: vi.fn(async () => options.contexts ?? []),
    isOwnedExecutionAlias: vi.fn(async (name: string) => (options.aliases ?? []).includes(name)),
  };
  const gate = { assertAllContextsStopped: vi.fn(async (_name: string) => undefined) };
  const ports = {
    getMode: vi.fn(async (name: string) => {
      const mode = options.modes?.[name] ?? 'shared';
      if (mode instanceof Error) throw mode;
      return mode;
    }),
    getSavedRequest: vi.fn(
      async (name: string) => (options.saved?.[name] ?? null) as TeamCreateRequest | null
    ),
    replaceMembers: vi.fn(async () => undefined),
    updateDisplayMetadata: vi.fn(async () => undefined),
  };
  const assertAliasStopped = vi.fn(async (_name: string) => undefined);
  return {
    registry,
    gate,
    ports,
    assertAliasStopped,
    editor: new TeamProjectDefinitionEditor(registry, gate, ports, assertAliasStopped),
  };
}

describe('TeamProjectDefinitionEditor', () => {
  it('classifies a per-project team as logical, an owned project copy as alias, the rest as native', async () => {
    const f = fixture({ modes: { builders: 'per_project' }, aliases: ['ptc-a'] });
    await expect(f.editor.classify('builders')).resolves.toBe('logical');
    await expect(f.editor.classify('ptc-a')).resolves.toBe('alias');
    await expect(f.editor.classify('legacy')).resolves.toBe('native');
  });

  it('keeps the native behavior when the metadata cannot be read', async () => {
    const f = fixture({ modes: { broken: new Error('unreadable') }, aliases: ['broken'] });
    await expect(f.editor.classify('broken')).resolves.toBe('native');
    expect(f.registry.isOwnedExecutionAlias).not.toHaveBeenCalled();
  });

  it('is editable only when the gate confirms every project context is stopped', async () => {
    const f = fixture({ modes: { builders: 'per_project' } });
    await expect(f.editor.assertEditable('builders')).resolves.toBeUndefined();
    expect(f.gate.assertAllContextsStopped).toHaveBeenCalledWith('builders');
    f.gate.assertAllContextsStopped.mockRejectedValue(new Error('running in a project'));
    await expect(f.editor.assertEditable('builders')).rejects.toThrow('running in a project');
  });

  it('refreshes each ready project copy from the logical definition and nothing else', async () => {
    const f = fixture({
      modes: { builders: 'per_project' },
      contexts: [
        { executionTeamName: 'ptc-a', state: 'ready' },
        { executionTeamName: 'ptc-b', state: 'ready' },
        { executionTeamName: 'ptc-c', state: 'reserved' },
      ],
      saved: {
        builders: {
          teamName: 'builders',
          members: [{ name: 'alice', role: 'new' }],
          description: 'New',
          color: 'red',
        },
        'ptc-a': {
          teamName: 'ptc-a',
          members: [{ name: 'alice', role: 'old' }],
          description: 'Old',
          color: 'blue',
        },
        'ptc-b': {
          teamName: 'ptc-b',
          members: [{ name: 'alice', role: 'new' }],
          description: 'New',
          color: 'red',
        },
      },
    });
    const report = await f.editor.projectToAliases('builders');
    expect(report.failed).toEqual([]);
    expect(f.ports.replaceMembers).toHaveBeenCalledOnce();
    expect(f.ports.replaceMembers).toHaveBeenCalledWith('ptc-a', {
      members: [{ name: 'alice', role: 'new' }],
    });
    expect(f.ports.updateDisplayMetadata).toHaveBeenCalledOnce();
    expect(f.ports.updateDisplayMetadata).toHaveBeenCalledWith('ptc-a', {
      description: 'New',
      color: 'red',
    });
    // The reserved context has no native files yet: it is built from the definition at launch.
    expect(f.ports.getSavedRequest).not.toHaveBeenCalledWith('ptc-c');
  });

  it('reports a copy that cannot be refreshed and still refreshes the others', async () => {
    const f = fixture({
      modes: { builders: 'per_project' },
      contexts: [
        { executionTeamName: 'ptc-a', state: 'ready' },
        { executionTeamName: 'ptc-b', state: 'ready' },
      ],
      saved: {
        builders: { teamName: 'builders', members: [{ name: 'bob' }] },
        'ptc-a': { teamName: 'ptc-a', members: [{ name: 'alice' }] },
        'ptc-b': { teamName: 'ptc-b', members: [{ name: 'alice' }] },
      },
    });
    f.assertAliasStopped.mockImplementation(async (name) => {
      if (name === 'ptc-a') throw new Error('Stop this project runtime');
    });
    const report = await f.editor.projectToAliases('builders');
    expect(report.failed).toEqual([
      { executionTeamName: 'ptc-a', message: 'Stop this project runtime' },
    ]);
    expect(f.ports.replaceMembers).toHaveBeenCalledOnce();
    expect(f.ports.replaceMembers).toHaveBeenCalledWith('ptc-b', { members: [{ name: 'bob' }] });
  });

  it('does nothing when the logical definition is missing', async () => {
    const f = fixture({
      modes: { builders: 'per_project' },
      contexts: [{ executionTeamName: 'ptc-a', state: 'ready' }],
    });
    await expect(f.editor.projectToAliases('builders')).resolves.toEqual({ failed: [] });
    expect(f.registry.list).not.toHaveBeenCalled();
    expect(f.ports.replaceMembers).not.toHaveBeenCalled();
  });
});
