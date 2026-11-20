import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  TeamProjectContextLaunchGate,
  TeamProjectDefinitionEditor,
} from '../../../src/features/team-project-context/main';
import {
  createProjectDefinitionEditRouting,
  PROJECT_COPY_EDIT_MESSAGE,
} from '../../../src/main/ipc/teams/teamProjectDefinitionEdit';

import type { TeamCreateRequest, TeamRuntimeState } from '../../../src/shared/types/team';

/**
 * The routing wrapper with the REAL editor and the REAL launch gate (only the
 * storage/runtime ports are fakes), so classification, the stopped check and
 * the projection are exercised together, including the lock ordering.
 */

type Context = { executionTeamName: string; state: 'ready' | 'reserved' };

function world(options: { contexts?: Context[]; unreadable?: string[] } = {}) {
  const contexts: Context[] = options.contexts ?? [
    { executionTeamName: 'ptc-a', state: 'ready' },
    { executionTeamName: 'ptc-b', state: 'ready' },
  ];
  const running = new Set<string>();
  const saved = new Map<string, Partial<TeamCreateRequest>>([
    ['builders', { teamName: 'builders', members: [{ name: 'alice', role: 'dev' }, { name: 'bob' }], description: 'D', color: 'blue', displayName: 'Builders' }],
    ['ptc-a', { teamName: 'ptc-a', members: [{ name: 'alice', role: 'dev' }], description: 'D', color: 'blue', displayName: 'Builders' }],
    ['ptc-b', { teamName: 'ptc-b', members: [{ name: 'alice', role: 'dev' }], description: 'D', color: 'blue', displayName: 'Builders' }],
  ]);
  const registry = {
    list: vi.fn(async () => contexts),
    isOwnedExecutionAlias: vi.fn(async (name: string) => contexts.some((c) => c.executionTeamName === name)),
  };
  const runtime = {
    hasProvisioningRun: vi.fn((_name: string) => false),
    getRuntimeState: vi.fn(
      async (name: string): Promise<TeamRuntimeState> =>
        ({ teamName: name, isAlive: running.has(name), runId: null, progress: null }) as TeamRuntimeState
    ),
  };
  const writes: string[] = [];
  const ports = {
    getMode: vi.fn(async (name: string) => {
      if (options.unreadable?.includes(name)) throw new Error('Team metadata is unreadable');
      return name === 'builders' ? ('per_project' as const) : ('shared' as const);
    }),
    getSavedRequest: vi.fn(async (name: string) => (saved.get(name) ?? null) as TeamCreateRequest | null),
    replaceMembers: vi.fn(async (name: string) => {
      writes.push('project:' + name);
    }),
    updateDisplayMetadata: vi.fn(async () => undefined),
  };
  const editor = new TeamProjectDefinitionEditor(
    registry,
    new TeamProjectContextLaunchGate(registry, runtime),
    ports,
    async () => undefined
  );
  // A real per-team mutual exclusion standing in for runConfigurationOperation.
  let tail: Promise<unknown> = Promise.resolve();
  const runConfigurationOperation = vi.fn(<T,>(_name: string, operation: () => Promise<T>): Promise<T> => {
    const next = tail.then(operation, operation);
    tail = next.catch(() => undefined);
    return next;
  });
  const handler = vi.fn(async (..._args: unknown[]) => {
    writes.push('logical');
    return { success: true as const, data: undefined };
  });
  const wrapped = createProjectDefinitionEditRouting(
    { data: () => ({ runConfigurationOperation }) as never, runtime: () => ({}) as never, run: () => ({}) as never },
    () => editor
  )(handler);
  return { contexts, running, wrapped, handler, writes, ports, runConfigurationOperation, runtime };
}

const event = {} as never;

describe('definition edit routing with the real editor and gate', () => {
  it('logical team: writes the definition, then refreshes every stopped project copy', async () => {
    const w = world();
    await expect(w.wrapped(event, 'builders', { members: [] })).resolves.toMatchObject({ success: true });
    expect(w.writes).toEqual(['logical', 'project:ptc-a', 'project:ptc-b']);
    expect(w.runConfigurationOperation).toHaveBeenCalledWith('builders', expect.any(Function));
  });

  it('project copy: refused with the project copy message, nothing is written', async () => {
    const w = world();
    await expect(w.wrapped(event, 'ptc-a', {})).resolves.toEqual({
      success: false,
      error: PROJECT_COPY_EDIT_MESSAGE,
    });
    expect(w.writes).toEqual([]);
  });

  it('ordinary team: the handler runs as before, outside the logical lock and without projection', async () => {
    const w = world();
    await expect(w.wrapped(event, 'legacy', { name: 'x' })).resolves.toMatchObject({ success: true });
    expect(w.handler).toHaveBeenCalledWith(event, 'legacy', { name: 'x' });
    expect(w.runConfigurationOperation).not.toHaveBeenCalled();
    expect(w.writes).toEqual(['logical']);
  });

  it('unreadable metadata fails closed, even for a name that would otherwise look ordinary', async () => {
    const w = world({ unreadable: ['broken'] });
    await expect(w.wrapped(event, 'broken', {})).resolves.toMatchObject({
      success: false,
      error: expect.stringContaining('unreadable'),
    });
    expect(w.handler).not.toHaveBeenCalled();
  });

  it('refuses while a project copy runs, is launching, or is not reconciled (stuck reservation names a way out)', async () => {
    const running = world();
    running.running.add('ptc-b');
    await expect(running.wrapped(event, 'builders', {})).resolves.toMatchObject({
      success: false,
      error: expect.stringMatching(/running in a project/i),
    });
    const launching = world();
    launching.runtime.hasProvisioningRun.mockImplementation((name) => name === 'ptc-a');
    await expect(launching.wrapped(event, 'builders', {})).resolves.toMatchObject({
      success: false,
      error: expect.stringMatching(/launching or stopping/i),
    });
    const stuck = world({ contexts: [{ executionTeamName: 'ptc-a', state: 'reserved' }] });
    await expect(stuck.wrapped(event, 'builders', {})).resolves.toMatchObject({
      success: false,
      error: expect.stringMatching(/interrupted.*launch the team there again/i),
    });
    for (const w of [running, launching, stuck]) expect(w.writes).toEqual([]);
  });

  it('a launch that takes the logical lock first is serialized before the check: the edit is refused', async () => {
    const w = world();
    // Launch admission holds the same logical-team lock while it flips the context.
    let releaseLaunch!: () => void;
    const launchStarted = new Promise<void>((resolve) => {
      void w.runConfigurationOperation('builders', async () => {
        resolve();
        await new Promise<void>((done) => {
          releaseLaunch = done;
        });
        w.running.add('ptc-a');
      });
    });
    await launchStarted;
    const edit = w.wrapped(event, 'builders', { members: [] });
    // The edit must be waiting on the lock, not already checked/written.
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(w.writes).toEqual([]);
    releaseLaunch();
    await expect(edit).resolves.toMatchObject({
      success: false,
      error: expect.stringMatching(/running in a project/i),
    });
    expect(w.writes).toEqual([]);
  });
});

describe('every team definition writer goes through the router', () => {
  const source = readFileSync(
    path.resolve(__dirname, '../../../src/main/ipc/teams.ts'),
    'utf8'
  );

  it.each([
    'TEAM_UPDATE_CONFIG',
    'TEAM_ADD_MEMBER',
    'TEAM_REPLACE_MEMBERS',
    'TEAM_REMOVE_MEMBER',
    'TEAM_RESTORE_MEMBER',
    'TEAM_UPDATE_MEMBER_ROLE',
  ])('%s is registered through the definition edit router', (channel) => {
    expect(source).toMatch(
      new RegExp(`ipcMain\\.handle\\(${channel}, projectEdit\\.route\\(`)
    );
  });
});
