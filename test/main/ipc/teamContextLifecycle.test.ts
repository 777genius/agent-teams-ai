import { describe, expect, it, vi } from 'vitest';

import { projectAliveTeamNames, stopLogicalTeam, permanentlyDeleteLogicalTeam, restoreLogicalTeamWithContexts } from '../../../src/main/ipc/teams/teamContextLifecycle';

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

  it('stops verified physical runs before soft-deleting a per-project logical team', async () => {
    const f = fixture('per_project');
    const order: string[] = [];
    const stop = vi.fn(async (name: string) => {
      order.push('stop:' + name);
      return { success: true as const, data: undefined };
    });
    const perform = vi.fn(async () => {
      order.push('delete:builders');
      return { success: true as const, data: undefined };
    });
    const { deleteLogicalTeamWithContexts } = await import('../../../src/main/ipc/teams/teamContextLifecycle');
    const result = await deleteLogicalTeamWithContexts(
      'builders', stop,
      async (name) => { order.push('trash:' + name); },
      perform, f.meta, f.registry as never,
      async () => false
    );
    expect(result.success).toBe(true);
    expect(order).toEqual(['stop:ptc-a', 'trash:ptc-a', 'delete:builders']);
  });

  it('does not soft-delete an unfinished project context', async () => {
    const f = fixture('per_project');
    f.registry.list.mockResolvedValue([{ ...entry, state: 'reserved' }]);
    const perform = vi.fn(async () => ({ success: true as const, data: undefined }));
    const { deleteLogicalTeamWithContexts } = await import('../../../src/main/ipc/teams/teamContextLifecycle');
    const result = await deleteLogicalTeamWithContexts(
      'builders', vi.fn(), vi.fn(), perform, f.meta, f.registry as never,
      async () => false
    );
    expect(result.success).toBe(false);
    expect(perform).not.toHaveBeenCalled();
  });

  it('deletes owned physical context first and logical definition last', async () => {
    const f = fixture('per_project');
    const actions: string[] = [];
    const registry = {
      listForPermanentDeletion: vi.fn(async () => [entry]),
      forgetPermanentlyDeletedContext: vi.fn(async () => {
        actions.push('forget');
        return true;
      }),
    };
    const result = await permanentlyDeleteLogicalTeam('builders', {
      meta: f.meta,
      registry: registry as never,
      isNativePresent: vi.fn(async () => true),
      hasAnySchedules: vi.fn(async () => false),
      stopNative: vi.fn(async () => {
        actions.push('stop');
        return { success: true as const, data: undefined };
      }),
      deleteNative: vi.fn(async () => { actions.push('delete:ptc-a'); }),
      deleteLogical: vi.fn(async () => {
        actions.push('delete:builders');
        return { success: true as const, data: undefined };
      }),
    });
    expect(result.success).toBe(true);
    expect(actions).toEqual(['stop', 'delete:ptc-a', 'forget', 'delete:builders']);
  });

  it('does not purge the logical team if a physical deletion fails mid-transaction', async () => {
    const f = fixture('per_project');
    const forget = vi.fn(async () => true);
    const logical = vi.fn(async () => ({ success: true as const, data: undefined }));
    const result = await permanentlyDeleteLogicalTeam('builders', {
      meta: f.meta,
      registry: {
        listForPermanentDeletion: vi.fn(async () => [entry]),
        forgetPermanentlyDeletedContext: forget,
      } as never,
      isNativePresent: vi.fn(async () => true),
      hasAnySchedules: vi.fn(async () => false),
      stopNative: vi.fn(async () => ({ success: true as const, data: undefined })),
      deleteNative: vi.fn(async () => { throw new Error('disk busy'); }),
      deleteLogical: logical,
    });
    expect(result).toMatchObject({ success: false, error: 'disk busy' });
    expect(logical).not.toHaveBeenCalled();
    expect(forget).not.toHaveBeenCalled();
  });

  it('recovers an alias already removed by an interrupted earlier delete', async () => {
    const f = fixture('per_project');
    const del = vi.fn(async () => undefined);
    const forget = vi.fn(async () => true);
    const result = await permanentlyDeleteLogicalTeam('builders', {
      meta: f.meta,
      registry: {
        listForPermanentDeletion: vi.fn(async () => [entry]),
        forgetPermanentlyDeletedContext: forget,
      } as never,
      isNativePresent: vi.fn(async () => false),
      hasAnySchedules: vi.fn(async () => false),
      stopNative: vi.fn(),
      deleteNative: del,
      deleteLogical: vi.fn(async () => ({ success: true as const, data: undefined })),
    });
    expect(result.success).toBe(true);
    expect(del).not.toHaveBeenCalled();
    expect(forget).toHaveBeenCalledWith('builders', 'ptc-a', entry.id);
  });

  it('restores each native project before making the logical team visible', async () => {
    const f = fixture('per_project');
    const actions: string[] = [];
    const restore = vi.fn(async (name: string) => { actions.push('restore:' + name); });
    const logical = vi.fn(async () => {
      actions.push('restore:builders');
      return { success: true as const, data: undefined };
    });
    const result = await restoreLogicalTeamWithContexts(
      'builders', restore, logical, f.meta, f.registry as never
    );
    expect(result.success).toBe(true);
    expect(actions).toEqual(['restore:ptc-a', 'restore:builders']);
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
