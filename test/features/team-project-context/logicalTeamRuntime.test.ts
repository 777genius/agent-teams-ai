import { describe, expect, it, vi } from 'vitest';

import {
  assertLogicalStopComplete,
  listAliveRuntimeStates,
  LogicalStopIncompleteError,
  readLogicalRuntimeState,
  stopLogicalContexts,
  type PersistedTeamWorkContext,
  type ResolvedTeamTarget,
} from '../../../src/features/team-project-context/main';

import type { TeamRuntimeState } from '../../../src/shared/types';

type Logical = Extract<ResolvedTeamTarget, { kind: 'logical' }>;

const ctx = (alias: string, projectPath: string, state: 'ready' | 'reserved' = 'ready') =>
  ({ id: `id-${alias}`, projectKey: projectPath, projectPath, executionTeamName: alias, state }) as PersistedTeamWorkContext;

const progress = { runId: 'run-b', state: 'spawning' } as unknown as TeamRuntimeState['progress'];
const down = (teamName: string): TeamRuntimeState => ({ teamName, isAlive: false, runId: null, progress: null });
const up = (teamName: string, runId = `run-${teamName}`): TeamRuntimeState => ({
  teamName,
  isAlive: true,
  runId,
  progress: null,
});

function target(...contexts: PersistedTeamWorkContext[]): Logical {
  return { kind: 'logical', logical: 'builders', contexts };
}

function runtimeOf(states: Record<string, TeamRuntimeState>) {
  return { getRuntimeState: vi.fn(async (team: string) => states[team] ?? down(team)) };
}

describe('readLogicalRuntimeState', () => {
  it('is alive when any project context is alive and names the live run and the contexts', async () => {
    const state = await readLogicalRuntimeState(
      target(ctx('ptc-a', '/p/a'), ctx('ptc-b', '/p/b')),
      runtimeOf({ 'ptc-a': down('ptc-a'), 'ptc-b': up('ptc-b') })
    );
    expect(state).toMatchObject({ teamName: 'builders', isAlive: true, runId: 'run-ptc-b' });
    expect(state.contexts.map((c) => [c.projectPath, c.isAlive])).toEqual([
      ['/p/a', false],
      ['/p/b', true],
    ]);
  });

  it('is not alive, with no run, when every context is down', async () => {
    const state = await readLogicalRuntimeState(
      target(ctx('ptc-a', '/p/a')),
      runtimeOf({})
    );
    expect(state).toMatchObject({ isAlive: false, runId: null, progress: null });
  });

  it('reports the provisioning progress of a context that is not alive yet', async () => {
    const state = await readLogicalRuntimeState(
      target(ctx('ptc-a', '/p/a'), ctx('ptc-b', '/p/b', 'reserved')),
      runtimeOf({ 'ptc-b': { teamName: 'ptc-b', isAlive: false, runId: 'run-b', progress } })
    );
    expect(state).toMatchObject({ isAlive: false, runId: 'run-b', progress });
    expect(state.contexts[1]?.state).toBe('reserved');
  });

  it('propagates a runtime read failure instead of reporting the team as stopped', async () => {
    await expect(
      readLogicalRuntimeState(target(ctx('ptc-a', '/p/a')), {
        getRuntimeState: async () => {
          throw new Error('runtime unavailable');
        },
      })
    ).rejects.toThrow('runtime unavailable');
  });
});

describe('listAliveRuntimeStates', () => {
  const resolver = (known: Record<string, PersistedTeamWorkContext>) =>
    vi.fn(async (name: string) => {
      const context = known[name];
      return context ? { logicalTeamName: 'builders', context } : null;
    });

  it('keeps native and physical entries and adds one logical entry per live team', async () => {
    const aliveTeams = ['legacy', 'ptc-a', 'ptc-b'];
    const entries = await listAliveRuntimeStates(
      aliveTeams,
      runtimeOf({ legacy: up('legacy'), 'ptc-a': up('ptc-a'), 'ptc-b': up('ptc-b') }),
      resolver({ 'ptc-a': ctx('ptc-a', '/p/a'), 'ptc-b': ctx('ptc-b', '/p/b') })
    );
    expect(entries.map((e) => e.teamName)).toEqual(['legacy', 'ptc-a', 'ptc-b', 'builders']);
    const logical = entries.find((e) => e.teamName === 'builders');
    expect(logical).toMatchObject({ isAlive: true });
    expect(logical?.contexts?.map((c) => c.projectPath)).toEqual(['/p/a', '/p/b']);
  });

  it('only looks up project copies, never ordinary teams', async () => {
    const resolve = resolver({});
    await listAliveRuntimeStates(['legacy'], runtimeOf({ legacy: up('legacy') }), resolve);
    expect(resolve).not.toHaveBeenCalled();
  });

  it('flags a copy that cannot be resolved instead of hiding or guessing it', async () => {
    const entries = await listAliveRuntimeStates(
      ['ptc-a'],
      runtimeOf({ 'ptc-a': up('ptc-a') }),
      async () => {
        throw new Error('Ambiguous project runtime alias');
      }
    );
    expect(entries).toEqual([{ ...up('ptc-a'), projectContextUnresolved: true }]);
  });
});

describe('stopLogicalContexts', () => {
  function ports(alive: Set<string>, overrides: Record<string, unknown> = {}) {
    return {
      assertReservedStopOwnership: vi.fn(async () => undefined),
      stopContext: vi.fn(async (alias: string) => {
        alive.delete(alias);
        return { stopped: alias };
      }),
      isAlive: vi.fn((alias: string) => alive.has(alias)),
      ...overrides,
    };
  }

  it('stops every project context, not just the logical name', async () => {
    const alive = new Set(['ptc-a', 'ptc-b']);
    const p = ports(alive);
    const outcome = await stopLogicalContexts(target(ctx('ptc-a', '/p/a'), ctx('ptc-b', '/p/b')), p);
    expect(p.stopContext.mock.calls.map(([alias]) => alias)).toEqual(['ptc-a', 'ptc-b']);
    expect(outcome.complete).toBe(true);
    expect(() => assertLogicalStopComplete(outcome)).not.toThrow();
  });

  it('is only complete when the contexts are really down, naming the one that still runs', async () => {
    const alive = new Set(['ptc-a', 'ptc-b']);
    // The stop call "succeeds" but ptc-b stays alive: exactly the silent no-op.
    const p = ports(alive, { stopContext: vi.fn(async () => ({ ok: true })) });
    const outcome = await stopLogicalContexts(target(ctx('ptc-a', '/p/a'), ctx('ptc-b', '/p/b')), p);
    expect(outcome.complete).toBe(false);
    let error: unknown;
    try {
      assertLogicalStopComplete(outcome);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(LogicalStopIncompleteError);
    expect(error).toMatchObject({ statusCode: 409, code: 'LOGICAL_STOP_INCOMPLETE' });
    expect((error as Error).message).toContain('/p/a');
    expect((error as Error).message).toContain('/p/b');
    expect((error as Error).message).toContain('still running');
  });

  it('keeps stopping the other contexts when one fails and reports the failure', async () => {
    const alive = new Set(['ptc-a', 'ptc-b']);
    const stopContext = vi.fn(async (alias: string) => {
      if (alias === 'ptc-a') throw new Error('escalation did not confirm');
      alive.delete(alias);
      return {};
    });
    const outcome = await stopLogicalContexts(
      target(ctx('ptc-a', '/p/a'), ctx('ptc-b', '/p/b')),
      ports(alive, { stopContext })
    );
    expect(stopContext).toHaveBeenCalledTimes(2);
    expect(outcome.contexts[0]).toMatchObject({ error: 'escalation did not confirm', stillAlive: true });
    expect(outcome.contexts[1]).toMatchObject({ stillAlive: false });
    expect(outcome.complete).toBe(false);
  });

  it('verifies the owner of a pending context before stopping anything', async () => {
    const alive = new Set(['ptc-a', 'ptc-b']);
    const p = ports(alive, {
      assertReservedStopOwnership: vi.fn(async () => {
        throw new Error('owner marker missing');
      }),
    });
    await expect(
      stopLogicalContexts(target(ctx('ptc-a', '/p/a'), ctx('ptc-b', '/p/b', 'reserved')), p)
    ).rejects.toThrow(/pending and its owner cannot be verified: owner marker missing/);
    expect(p.stopContext).not.toHaveBeenCalled();
  });

  it('a team without contexts is trivially stopped', async () => {
    const outcome = await stopLogicalContexts(target(), ports(new Set()));
    expect(outcome).toMatchObject({ complete: true, contexts: [] });
  });
});
