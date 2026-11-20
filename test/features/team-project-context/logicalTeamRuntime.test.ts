import { describe, expect, it, vi } from 'vitest';

import {
  assertLogicalStopComplete,
  listAliveRuntimeStates,
  LogicalStopIncompleteError,
  readLogicalRuntimeState,
  stopLogicalContexts,
  type ContextGroup,
  type LogicalStopPorts,
  type OwnedExecutionAliasLookup,
  type PersistedTeamWorkContext,
} from '../../../src/features/team-project-context/main';

import type { TeamRuntimeState } from '../../../src/shared/types';

const ctx = (alias: string, projectPath: string, state: 'ready' | 'reserved' = 'ready') =>
  ({ id: `id-${alias}`, projectKey: projectPath, projectPath, executionTeamName: alias, state }) as PersistedTeamWorkContext;

const progressOf = (state: string, runId = 'run-b') =>
  ({ runId, state }) as unknown as TeamRuntimeState['progress'];
const down = (teamName: string): TeamRuntimeState => ({ teamName, isAlive: false, runId: null, progress: null });
const up = (teamName: string, runId = `run-${teamName}`): TeamRuntimeState => ({
  teamName,
  isAlive: true,
  runId,
  progress: null,
});

function group(contexts: PersistedTeamWorkContext[], team = 'builders'): ContextGroup {
  return { team, contexts };
}

// One verification read, no waiting: the retry itself is tested with its own settings.
const quick = { attempts: 1, delayMs: 0 };
const stop = <Result>(
  target: ContextGroup,
  ports: LogicalStopPorts<Result>,
  verification = quick
) => stopLogicalContexts(target, ports, verification);

function runtimeOf(states: Record<string, TeamRuntimeState>) {
  return { getRuntimeState: vi.fn(async (team: string) => states[team] ?? down(team)) };
}

describe('readLogicalRuntimeState', () => {
  it('is alive when any project context is alive and names the live run and the contexts', async () => {
    const state = await readLogicalRuntimeState(
      group([ctx('ptc-a', '/p/a'), ctx('ptc-b', '/p/b')]),
      runtimeOf({ 'ptc-a': down('ptc-a'), 'ptc-b': up('ptc-b') })
    );
    expect(state).toMatchObject({ teamName: 'builders', isAlive: true, runId: 'run-ptc-b' });
    expect(state.contexts.map((c) => [c.projectPath, c.isAlive])).toEqual([
      ['/p/a', false],
      ['/p/b', true],
    ]);
  });

  it('is not alive, with no run, when every context is down', async () => {
    const state = await readLogicalRuntimeState(group([ctx('ptc-a', '/p/a')]), runtimeOf({}));
    expect(state).toMatchObject({ isAlive: false, runId: null, progress: null });
  });

  it('reports the provisioning progress of a context that is not alive yet', async () => {
    const progress = progressOf('spawning');
    const state = await readLogicalRuntimeState(
      group([ctx('ptc-a', '/p/a'), ctx('ptc-b', '/p/b', 'reserved')]),
      runtimeOf({ 'ptc-b': { teamName: 'ptc-b', isAlive: false, runId: 'run-b', progress } })
    );
    expect(state).toMatchObject({ isAlive: false, runId: 'run-b', progress });
    expect(state.contexts[1]?.state).toBe('reserved');
  });

  it('prefers a provisioning run over an earlier copy that only keeps a settled progress', async () => {
    const settled = progressOf('failed', 'run-old');
    const launching = progressOf('configuring', 'run-new');
    const state = await readLogicalRuntimeState(
      group([ctx('ptc-a', '/p/a'), ctx('ptc-b', '/p/b')]),
      runtimeOf({
        'ptc-a': { teamName: 'ptc-a', isAlive: false, runId: 'run-old', progress: settled },
        'ptc-b': { teamName: 'ptc-b', isAlive: false, runId: 'run-new', progress: launching },
      })
    );
    expect(state).toMatchObject({ runId: 'run-new', progress: launching });
  });

  it('folds the own process of a shared team that retained contexts', async () => {
    const state = await readLogicalRuntimeState(
      group([ctx('ptc-a', '/p/a')], 'old'),
      runtimeOf({ old: up('old'), 'ptc-a': down('ptc-a') })
    );
    expect(state).toMatchObject({ teamName: 'old', isAlive: true, runId: 'run-old' });
    expect(state.contexts).toHaveLength(1);
  });

  it('reports a logical team that somehow has a process of its own, like the app does', async () => {
    const state = await readLogicalRuntimeState(
      group([ctx('ptc-a', '/p/a')]),
      runtimeOf({ builders: up('builders'), 'ptc-a': down('ptc-a') })
    );
    expect(state).toMatchObject({ teamName: 'builders', isAlive: true, runId: 'run-builders' });
  });

  it('propagates a runtime read failure instead of reporting the team as stopped', async () => {
    await expect(
      readLogicalRuntimeState(group([ctx('ptc-a', '/p/a')]), {
        getRuntimeState: async () => {
          throw new Error('runtime unavailable');
        },
      })
    ).rejects.toThrow('runtime unavailable');
  });
});

describe('listAliveRuntimeStates', () => {
  const resolver = (known: Record<string, PersistedTeamWorkContext>, logical = 'builders') =>
    vi.fn(async (names: readonly string[]) => {
      const lookups = new Map<string, OwnedExecutionAliasLookup>();
      for (const name of names) {
        const context = known[name];
        lookups.set(name, { alias: context ? { logicalTeamName: logical, context } : null });
      }
      return lookups;
    });

  it('keeps native and physical entries and adds one logical entry per live team', async () => {
    const entries = await listAliveRuntimeStates(
      ['legacy', 'ptc-a', 'ptc-b'],
      runtimeOf({ legacy: up('legacy'), 'ptc-a': up('ptc-a'), 'ptc-b': up('ptc-b') }),
      resolver({ 'ptc-a': ctx('ptc-a', '/p/a'), 'ptc-b': ctx('ptc-b', '/p/b') })
    );
    expect(entries.map((e) => e.teamName)).toEqual(['legacy', 'ptc-a', 'ptc-b', 'builders']);
    const logical = entries.find((e) => e.teamName === 'builders');
    expect(logical).toMatchObject({ isAlive: true });
    expect(logical?.contexts?.map((c) => c.projectPath)).toEqual(['/p/a', '/p/b']);
  });

  it('resolves every project copy with one batch lookup and never asks for ordinary teams', async () => {
    const resolve = resolver({ 'ptc-a': ctx('ptc-a', '/p/a'), 'ptc-b': ctx('ptc-b', '/p/b') });
    await listAliveRuntimeStates(
      ['legacy', 'ptc-a', 'ptc-b'],
      runtimeOf({ legacy: up('legacy'), 'ptc-a': up('ptc-a'), 'ptc-b': up('ptc-b') }),
      resolve
    );
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(resolve.mock.calls[0]?.[0]).toEqual(['ptc-a', 'ptc-b']);

    const none = resolver({});
    await listAliveRuntimeStates(['legacy'], runtimeOf({ legacy: up('legacy') }), none);
    expect(none).not.toHaveBeenCalled();
  });

  it('merges the contexts into the entry of an alive shared team instead of listing it twice', async () => {
    const entries = await listAliveRuntimeStates(
      ['old', 'ptc-a'],
      runtimeOf({ old: up('old'), 'ptc-a': up('ptc-a') }),
      resolver({ 'ptc-a': ctx('ptc-a', '/p/a') }, 'old')
    );
    expect(entries.map((e) => e.teamName)).toEqual(['old', 'ptc-a']);
    expect(entries[0]).toMatchObject({ teamName: 'old', isAlive: true, runId: 'run-old' });
    expect(entries[0]?.contexts?.map((c) => c.projectPath)).toEqual(['/p/a']);
  });

  it('flags a copy that cannot be resolved instead of hiding or guessing it', async () => {
    const entries = await listAliveRuntimeStates(
      ['ptc-a', 'ptc-b'],
      runtimeOf({ 'ptc-a': up('ptc-a'), 'ptc-b': up('ptc-b') }),
      async () =>
        new Map<string, OwnedExecutionAliasLookup>([
          ['ptc-a', { error: new Error('Ambiguous project runtime alias') }],
          ['ptc-b', { alias: { logicalTeamName: 'builders', context: ctx('ptc-b', '/p/b') } }],
        ])
    );
    expect(entries[0]).toEqual({ ...up('ptc-a'), projectContextUnresolved: true });
    expect(entries.find((e) => e.teamName === 'builders')?.contexts).toHaveLength(1);
  });

  it('flags every copy when the whole lookup fails', async () => {
    const entries = await listAliveRuntimeStates(
      ['ptc-a'],
      runtimeOf({ 'ptc-a': up('ptc-a') }),
      async () => {
        throw new Error('teams directory unreadable');
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
      isStopped: vi.fn(async (alias: string) => !alive.has(alias)),
      listContexts: vi.fn(async () => [] as PersistedTeamWorkContext[]),
      ...overrides,
    };
  }

  it('stops every project context, not just the logical name', async () => {
    const alive = new Set(['ptc-a', 'ptc-b']);
    const p = ports(alive);
    const outcome = await stop(group([ctx('ptc-a', '/p/a'), ctx('ptc-b', '/p/b')]), p);
    expect(p.stopContext.mock.calls.map(([alias]) => alias)).toEqual(['ptc-a', 'ptc-b']);
    expect(outcome.complete).toBe(true);
    expect(() => assertLogicalStopComplete(outcome)).not.toThrow();
  });

  it('also stops the own process of a shared team that retained contexts, after its contexts', async () => {
    const alive = new Set(['old', 'ptc-a']);
    const p = ports(alive);
    const outcome = await stop(group([ctx('ptc-a', '/p/a')], 'old'), p);
    expect(p.stopContext.mock.calls.map(([alias]) => alias)).toEqual(['ptc-a', 'old']);
    expect(outcome.contexts[1]).toMatchObject({ executionTeamName: 'old', projectPath: null });
    expect(outcome.complete).toBe(true);
  });

  it('is only complete when the contexts are really down, naming the one that still runs', async () => {
    const alive = new Set(['ptc-a', 'ptc-b']);
    // The stop call "succeeds" but ptc-b stays alive: exactly the silent no-op.
    const p = ports(alive, { stopContext: vi.fn(async () => ({ ok: true })) });
    const outcome = await stop(group([ctx('ptc-a', '/p/a'), ctx('ptc-b', '/p/b')]), p);
    expect(outcome.complete).toBe(false);
    let error: unknown;
    try {
      assertLogicalStopComplete(outcome);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(LogicalStopIncompleteError);
    expect(error).toMatchObject({ statusCode: 409, code: 'LOGICAL_STOP_INCOMPLETE', outcome });
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
    const outcome = await stop(
      group([ctx('ptc-a', '/p/a'), ctx('ptc-b', '/p/b')]),
      ports(alive, { stopContext })
    );
    expect(stopContext).toHaveBeenCalledTimes(2);
    expect(outcome.contexts[0]).toMatchObject({ error: 'escalation did not confirm', stillAlive: true });
    expect(outcome.contexts[1]).toMatchObject({ stillAlive: false });
    expect(outcome.complete).toBe(false);
  });

  it('is not complete when a context appeared while the stop was running and is not down', async () => {
    const alive = new Set(['ptc-a', 'ptc-new']);
    const p = ports(alive, {
      listContexts: vi.fn(async () => [ctx('ptc-a', '/p/a'), ctx('ptc-new', '/p/new', 'reserved')]),
    });
    const outcome = await stop(group([ctx('ptc-a', '/p/a')]), p);
    expect(p.stopContext.mock.calls.map(([alias]) => alias)).toEqual(['ptc-a']);
    expect(outcome.contexts[1]).toMatchObject({
      executionTeamName: 'ptc-new',
      appearedDuringStop: true,
      stillAlive: true,
    });
    expect(outcome.complete).toBe(false);
    expect(() => assertLogicalStopComplete(outcome)).toThrow(/started while the stop was running/);
  });

  it('is not complete when the contexts cannot be re-read after the stop', async () => {
    const p = ports(new Set(), {
      listContexts: vi.fn(async () => {
        throw new Error('index unreadable');
      }),
    });
    const outcome = await stop(group([ctx('ptc-a', '/p/a')]), p);
    expect(outcome).toMatchObject({ complete: false, verificationError: 'index unreadable' });
    expect(() => assertLogicalStopComplete(outcome)).toThrow(/could not re-read the project contexts/);
  });

  it('treats a runtime that cannot be read after the stop as still running', async () => {
    const p = ports(new Set(), {
      isStopped: vi.fn(async () => {
        throw new Error('runtime unavailable');
      }),
    });
    const outcome = await stop(group([ctx('ptc-a', '/p/a')]), p);
    expect(outcome.contexts[0]).toMatchObject({ stillAlive: true, error: 'runtime unavailable' });
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
      stop(group([ctx('ptc-a', '/p/a'), ctx('ptc-b', '/p/b', 'reserved')]), p)
    ).rejects.toThrow(/pending and its owner cannot be verified: owner marker missing/);
    expect(p.stopContext).not.toHaveBeenCalled();
  });

  it('a team without contexts is trivially stopped', async () => {
    const outcome = await stop(group([]), ports(new Set()));
    expect(outcome).toMatchObject({ complete: true, contexts: [] });
  });

  it('stops the own process of a logical team that somehow has one, and leaves an idle name alone', async () => {
    const alive = new Set(['builders', 'ptc-a']);
    const p = ports(alive);
    await stop(group([ctx('ptc-a', '/p/a')]), p);
    expect(p.stopContext.mock.calls.map(([alias]) => alias)).toEqual(['ptc-a', 'builders']);

    const idle = ports(new Set(['ptc-a']));
    await stop(group([ctx('ptc-a', '/p/a')]), idle);
    expect(idle.stopContext.mock.calls.map(([alias]) => alias)).toEqual(['ptc-a']);
  });

  it('does not call a reservation that appeared during the stop a success even though it reads stopped', async () => {
    // A launch has reserved the project but no run is registered yet: it reads as down.
    const p = ports(new Set(), {
      listContexts: vi.fn(async () => [ctx('ptc-a', '/p/a'), ctx('ptc-new', '/p/new', 'reserved')]),
    });
    const outcome = await stop(group([ctx('ptc-a', '/p/a')]), p);
    expect(outcome.contexts[1]).toMatchObject({ executionTeamName: 'ptc-new', appearedDuringStop: true, stillAlive: true });
    expect(outcome.complete).toBe(false);
    // A ready copy that appeared and is down is fine.
    const ready = ports(new Set(), {
      listContexts: vi.fn(async () => [ctx('ptc-a', '/p/a'), ctx('ptc-new', '/p/new')]),
    });
    expect((await stop(group([ctx('ptc-a', '/p/a')]), ready)).complete).toBe(true);
  });

  it('waits a bounded number of reads for a stop that is still settling, then reports the truth', async () => {
    // The stop call returned, but the tracked run id is cleared a moment later.
    let reads = 0;
    const settling = ports(new Set(), {
      isStopped: vi.fn(async (alias: string) => alias === 'builders' || ++reads >= 3),
    });
    const outcome = await stop(group([ctx('ptc-a', '/p/a')]), settling, { attempts: 5, delayMs: 0 });
    expect(settling.isStopped).toHaveBeenCalledTimes(4); // 1 own-name check + 3 reads
    expect(outcome.complete).toBe(true);

    const stuck = ports(new Set(['ptc-a']), { isStopped: vi.fn(async (alias: string) => alias !== 'ptc-a') });
    const failed = await stop(group([ctx('ptc-a', '/p/a')]), stuck, { attempts: 4, delayMs: 0 });
    expect(stuck.isStopped.mock.calls.filter(([alias]) => alias === 'ptc-a')).toHaveLength(4);
    expect(failed.complete).toBe(false);
  });
});
