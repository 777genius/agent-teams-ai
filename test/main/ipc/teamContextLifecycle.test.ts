import { describe, expect, it, vi } from 'vitest';

import { projectAliveTeamNames, stopLogicalTeam } from '../../../src/main/ipc/teams/teamContextLifecycle';

import type { TeamMetaFile } from '../../../src/main/services/team/TeamMetaStore';
import type { TeamSummary } from '../../../src/shared/types/team';

const owner: TeamMetaFile = {
  version: 1,
  cwd: '/TEST/A',
  createdAt: 1,
  projectContextMode: 'per_project',
};
const entry = {
  id: '11111111-1111-4111-8111-111111111111',
  executionTeamName: 'ptc-a',
  projectKey: '/TEST/A',
  projectPath: '/TEST/A',
  state: 'ready' as const,
};

function fixture(mode?: 'shared' | 'per_project') {
  const meta = {
    getMeta: vi.fn(async () => mode === undefined ? null : { ...owner, projectContextMode: mode }),
    metadataFileExists: vi.fn(async () => false),
  };
  const registry = { list: vi.fn(async () => [entry]) };
  return { meta, registry };
}

describe('project team lifecycle projection', () => {
  it('keeps the original native name for existing shared teams', async () => {
    const f = fixture();
    const stopNative = vi.fn(async () => ({ success: true as const, data: undefined }));
    await expect(stopLogicalTeam('legacy', stopNative, f.meta, f.registry as never))
      .resolves.toMatchObject({ success: true });
    expect(stopNative).toHaveBeenCalledExactlyOnceWith('legacy');
    expect(f.registry.list).not.toHaveBeenCalled();
  });

  it('stops every ready verified project before acknowledging logical stop', async () => {
    const f = fixture('per_project');
    const stops: string[] = [];
    const stop = vi.fn(async (name: string) => {
      stops.push(name);
      return { success: true as const, data: undefined };
    });
    const result = await stopLogicalTeam('builders', stop, f.meta, f.registry as never);
    expect(result.success).toBe(true);
    expect(stops).toEqual(['ptc-a', 'builders']);
  });

  it('fails closed on a reserved or unowned context rather than falsely stopping', async () => {
    const f = fixture('per_project');
    f.registry.list.mockResolvedValue([{ ...entry, state: 'reserved' }]);
    const stop = vi.fn(async () => ({ success: true as const, data: undefined }));
    const result = await stopLogicalTeam('builders', stop, f.meta, f.registry as never);
    expect(result.success).toBe(false);
    expect(stop).not.toHaveBeenCalled();
  });

  it('never reports logical stop when a physical stop fails', async () => {
    const f = fixture('per_project');
    const stop = vi.fn(async (name: string) =>
      name === 'ptc-a'
        ? { success: false as const, error: 'unresolved' }
        : { success: true as const, data: undefined }
    );
    const result = await stopLogicalTeam('builders', stop, f.meta, f.registry as never);
    expect(result).toMatchObject({ success: false, error: 'unresolved' });
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it('projects only verified native aliases to the logical team in the UI alive list', async () => {
    const f = fixture('per_project');
    const teams = [{ teamName: 'builders' }] as TeamSummary[];
    const projected = await projectAliveTeamNames(
      ['ptc-a', 'ptc-unowned', 'other-team'], teams, f.meta, f.registry as never
    );
    expect(projected).toEqual(expect.arrayContaining([
      'builders', 'ptc-unowned', 'other-team',
    ]));
    expect(projected).not.toContain('ptc-a');
  });
});
