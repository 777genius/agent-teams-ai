import { InternalStorageOperationInterruptedError } from '@features/internal-storage/main';
import {
  MemberWorkSyncTeamOperationGate,
  MemberWorkSyncTeamQuiescedError,
} from '@features/member-work-sync/core/application/MemberWorkSyncTeamOperationGate';
import { TeamWorkSyncRestoreAttemptOwner } from '@main/services/team/TeamWorkSyncRestoreAttemptOwner';
import { describe, expect, it, vi } from 'vitest';

function deferred() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function setup() {
  const gate = new MemberWorkSyncTeamOperationGate();
  const tails = new Map<string, Promise<void>>();
  const held = new Set<string>();
  const withIdentityFence = vi.fn((team: string, operation: () => Promise<void>) => {
    const previous = tails.get(team) ?? Promise.resolve();
    const result = previous.then(async () => {
      held.add(team);
      try {
        await operation();
      } finally {
        held.delete(team);
      }
    });
    tails.set(
      team,
      result.then(
        () => undefined,
        () => undefined
      )
    );
    return result;
  });
  const owner = new TeamWorkSyncRestoreAttemptOwner({ operationGate: gate, withIdentityFence });
  return { gate, owner, withIdentityFence, held };
}

const blocked = (gate: MemberWorkSyncTeamOperationGate) =>
  expect(gate.run('team-a', async () => undefined)).rejects.toBeInstanceOf(
    MemberWorkSyncTeamQuiescedError
  );

describe('TeamWorkSyncRestoreAttemptOwner (preparatory A6 module)', () => {
  it('closes synchronously and drains physical tails before acquiring the fence', async () => {
    const { gate, owner, withIdentityFence, held } = setup();
    const physical = deferred();
    await gate.run('team-a', async (admission) => {
      admission.trackSettling(physical.promise);
    });
    const operation = vi.fn(async () => {
      expect(held.has('TEAM-A')).toBe(true);
    });
    const run = owner.run(' TEAM-A ', operation);
    await blocked(gate);
    expect(withIdentityFence).not.toHaveBeenCalled();
    await expect(gate.run('team-b', async () => 'available')).resolves.toBe('available');
    // The old writer can still acquire the fence in order to retire.
    await withIdentityFence('team-a', async () => physical.resolve());
    await run;
    expect(operation).toHaveBeenCalledOnce();
    expect(withIdentityFence).toHaveBeenLastCalledWith('TEAM-A', expect.any(Function));
    expect(held.size).toBe(0);
    await expect(gate.run('team-a', async () => 'open')).resolves.toBe('open');
  });

  it('reuses a failed closure and releases only its own handle on retry', async () => {
    const { gate, owner } = setup();
    const begin = vi.spyOn(gate, 'beginOwnedTeamQuiesce');
    const failure = new Error('pending clear failed');
    await expect(
      owner.run('team-a', async () => {
        throw failure;
      })
    ).rejects.toBe(failure);
    await blocked(gate);
    const deletion = gate.beginOwnedTeamQuiesce('team-a');
    await owner.run('TEAM-A', async () => undefined);
    expect(begin).toHaveBeenCalledTimes(2);
    await blocked(gate);
    deletion.release();
    await expect(gate.run('team-a', async () => undefined)).resolves.toBeUndefined();
  });

  it('coalesces concurrent normalized-team requests without running the second callback', async () => {
    const { gate, owner } = setup();
    const finish = deferred();
    const second = vi.fn(async () => undefined);
    const first = owner.run('team-a', () => finish.promise);
    expect(owner.run(' TEAM-A ', second)).toBe(first);
    await blocked(gate);
    finish.resolve();
    await first;
    expect(second).not.toHaveBeenCalled();
    await owner.run('team-a', second);
    expect(second).toHaveBeenCalledOnce();
  });

  it('holds the fence after interruption until physical retirement, before deletion enters', async () => {
    const { gate, owner, withIdentityFence, held } = setup();
    const physical = deferred();
    const entered = deferred();
    const failure = new InternalStorageOperationInterruptedError(
      'unknown',
      'unknown',
      physical.promise
    );
    const run = owner.run('team-a', async () => {
      entered.resolve();
      throw failure;
    });
    const rejection = expect(run).rejects.toBe(failure);
    await entered.promise;
    const deletion = vi.fn(async () => undefined);
    const next = withIdentityFence('team-a', deletion);
    const second = vi.fn(async () => undefined);
    expect(owner.run('team-a', second)).toBe(run);
    await blocked(gate);
    expect(held.has('team-a')).toBe(true);
    expect(deletion).not.toHaveBeenCalled();
    physical.resolve();
    await rejection;
    await next;
    expect(deletion).toHaveBeenCalledOnce();
    expect(second).not.toHaveBeenCalled();
    await blocked(gate);
  });

  it('retains admission closure when physical settlement rejects', async () => {
    const { gate, owner } = setup();
    const physical = deferred();
    const entered = deferred();
    const error = new InternalStorageOperationInterruptedError('unknown', 'unknown', physical.promise);
    const run = owner.run('team-a', async () => {
      entered.resolve();
      throw error;
    });
    const rejection = expect(run).rejects.toBeInstanceOf(AggregateError);
    await entered.promise;
    physical.reject(new Error('settlement failed'));
    await rejection;
    await blocked(gate);
  });

  it('releases after fence exit and retains closure if the fence fails after its callback', async () => {
    const gate = new MemberWorkSyncTeamOperationGate();
    const outside = deferred();
    const callbackDone = deferred();
    const owner = new TeamWorkSyncRestoreAttemptOwner({
      operationGate: gate,
      withIdentityFence: async (_team, operation) => {
        await operation();
        callbackDone.resolve();
        await outside.promise;
      },
    });
    const run = owner.run('team-a', async () => undefined);
    const rejection = expect(run).rejects.toThrow('fence failed');
    await callbackDone.promise;
    await blocked(gate);
    outside.reject(new Error('fence failed'));
    await rejection;
    await blocked(gate);
  });
});
