import { beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => {
  const files = new Map<string, string>();

  // Normalize path separators so tests pass on Windows (backslash → forward slash)
  const norm = (p: string): string => p.replace(/\\/g, '/');

  const readFile = vi.fn(async (filePath: string) => {
    const data = files.get(norm(filePath));
    if (data === undefined) {
      const error = new Error('ENOENT') as NodeJS.ErrnoException;
      error.code = 'ENOENT';
      throw error;
    }
    return data;
  });
  const atomicWrite = vi.fn(async (filePath: string, data: string) => {
    files.set(norm(filePath), data);
  });
  return { files, readFile, atomicWrite };
});

vi.mock('fs', () => ({
  promises: {
    readFile: hoisted.readFile,
  },
}));

vi.mock('../../../../src/main/utils/pathDecoder', () => ({
  getTeamsBasePath: () => '/mock/teams',
}));

vi.mock('../../../../src/main/services/team/atomicWrite', () => ({
  atomicWriteAsync: hoisted.atomicWrite,
}));

import { TeamKanbanManager } from '../../../../src/main/services/team/TeamKanbanManager';

describe('TeamKanbanManager', () => {
  const manager = new TeamKanbanManager();
  const statePath = '/mock/teams/my-team/kanban-state.json';

  beforeEach(() => {
    hoisted.files.clear();
    hoisted.readFile.mockClear();
    hoisted.atomicWrite.mockClear();
  });

  it('returns default state on ENOENT', async () => {
    const result = await manager.getState('my-team');
    expect(result).toEqual({
      teamName: 'my-team',
      reviewers: [],
      tasks: {},
    });
  });

  it('returns default state on corrupted JSON', async () => {
    hoisted.files.set(statePath, '{bad-json');
    const result = await manager.getState('my-team');
    expect(result).toEqual({
      teamName: 'my-team',
      reviewers: [],
      tasks: {},
    });
  });

  it('writes review state with movedAt on set_column', async () => {
    await manager.updateTask('my-team', '12', { op: 'set_column', column: 'review' });
    const persisted = JSON.parse(hoisted.files.get(statePath) ?? '{}') as {
      tasks?: Record<string, { column: string; movedAt: string }>;
    };

    expect(persisted.tasks?.['12']?.column).toBe('review');
    expect(typeof persisted.tasks?.['12']?.movedAt).toBe('string');
    expect(hoisted.atomicWrite).toHaveBeenCalledTimes(1);
  });

  it('removes task state on remove', async () => {
    hoisted.files.set(
      statePath,
      JSON.stringify({
        teamName: 'my-team',
        reviewers: [],
        tasks: {
          '12': { column: 'review', movedAt: '2026-01-01T00:00:00.000Z' },
        },
      })
    );

    await manager.updateTask('my-team', '12', { op: 'remove' });
    const persisted = JSON.parse(hoisted.files.get(statePath) ?? '{}') as {
      tasks?: Record<string, unknown>;
    };
    expect(persisted.tasks).toEqual({});
  });

  it('garbageCollect removes only stale tasks', async () => {
    hoisted.files.set(
      statePath,
      JSON.stringify({
        teamName: 'my-team',
        reviewers: [],
        tasks: {
          '12': { column: 'review', movedAt: '2026-01-01T00:00:00.000Z' },
          '13': { column: 'approved', movedAt: '2026-01-01T00:00:00.000Z' },
        },
      })
    );

    await manager.garbageCollect('my-team', new Set(['12']));
    const persisted = JSON.parse(hoisted.files.get(statePath) ?? '{}') as {
      tasks?: Record<string, unknown>;
    };
    expect(Object.keys(persisted.tasks ?? {})).toEqual(['12']);
  });

  it('garbageCollect does not write when nothing to remove', async () => {
    hoisted.files.set(
      statePath,
      JSON.stringify({
        teamName: 'my-team',
        reviewers: [],
        tasks: {
          '12': { column: 'review', movedAt: '2026-01-01T00:00:00.000Z' },
        },
      })
    );

    await manager.garbageCollect('my-team', new Set(['12']));
    expect(hoisted.atomicWrite).not.toHaveBeenCalled();
  });
});
