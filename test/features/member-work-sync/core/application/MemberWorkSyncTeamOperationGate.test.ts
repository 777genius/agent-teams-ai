import {
  MemberWorkSyncTeamOperationGate,
  MemberWorkSyncTeamQuiescedError,
} from '@features/member-work-sync/core/application/MemberWorkSyncTeamOperationGate';
import { describe, expect, it, vi } from 'vitest';

function createDeferred<T = void>(): {
  promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe('MemberWorkSyncTeamOperationGate', () => {
  it('fences synchronously, drains only admitted operations for that team, and resumes', async () => {
    const gate = new MemberWorkSyncTeamOperationGate();
    const teamAWork = createDeferred<string>();
    const teamBWork = createDeferred<string>();
    const teamAOperation = vi.fn(() => teamAWork.promise);
    const rejectedOperation = vi.fn(async () => 'must-not-run');

    const teamARun = gate.run('Team-A', teamAOperation);
    const teamBRun = gate.run('team-b', () => teamBWork.promise);
    gate.beginTeamQuiesce(' team-a ');

    await expect(gate.run('TEAM-A', rejectedOperation)).rejects.toEqual(
      new MemberWorkSyncTeamQuiescedError('TEAM-A')
    );
    expect(rejectedOperation).not.toHaveBeenCalled();

    let teamAIdle = false;
    const teamAIdlePromise = gate.awaitTeamIdle('team-a').then(() => {
      teamAIdle = true;
    });
    await Promise.resolve();
    expect(teamAIdle).toBe(false);

    teamAWork.resolve('team-a-complete');
    await expect(teamARun).resolves.toBe('team-a-complete');
    await teamAIdlePromise;
    expect(teamAIdle).toBe(true);

    // team-b is still running, proving the drain is scoped to the exact team.
    teamBWork.resolve('team-b-complete');
    await expect(teamBRun).resolves.toBe('team-b-complete');

    gate.resumeTeam('TEAM-A');
    await expect(gate.run('team-a', async () => 'fresh-work')).resolves.toBe('fresh-work');
    expect(teamAOperation).toHaveBeenCalledTimes(1);
  });

  it('releases failed operations from the team drain', async () => {
    const gate = new MemberWorkSyncTeamOperationGate();
    const failure = new Error('operation failed');

    const run = gate.run('team-a', async () => {
      throw failure;
    });
    gate.beginTeamQuiesce('team-a');

    await expect(run).rejects.toBe(failure);
    await expect(gate.awaitTeamIdle('team-a')).resolves.toBeUndefined();
  });

  it('drains settling side effects which outlive an admitted operation result', async () => {
    const gate = new MemberWorkSyncTeamOperationGate();
    const sideEffect = createDeferred<void>();
    let sideEffectSettled = false;

    await gate.run('team-a', (admission) => {
      admission.trackSettling(
        sideEffect.promise.then(() => {
          sideEffectSettled = true;
        })
      );
      return Promise.resolve('operation-result');
    });
    gate.beginTeamQuiesce('TEAM-A');

    let drained = false;
    const drain = gate.awaitTeamIdle(' team-a ').then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(drained).toBe(false);

    sideEffect.resolve();
    await drain;
    expect(sideEffectSettled).toBe(true);
  });
});


it('releasing one restore cannot reopen another restore or deletion closure', async () => {
  const gate = new MemberWorkSyncTeamOperationGate();
  const first = gate.beginOwnedTeamQuiesce('Team-A');
  const second = gate.beginOwnedTeamQuiesce(' team-a ');
  gate.beginTeamQuiesce('TEAM-A');
  first.release();
  first.release();
  gate.resumeTeam('team-a');
  await expect(gate.run('team-a', async () => 'unsafe')).rejects.toBeInstanceOf(MemberWorkSyncTeamQuiescedError);
  gate.beginTeamQuiesce('team-a');
  second.release();
  await expect(gate.run('team-a', async () => 'unsafe')).rejects.toBeInstanceOf(MemberWorkSyncTeamQuiescedError);
  gate.resumeTeam('team-a');
  await expect(gate.run('team-a', async () => 'safe')).resolves.toBe('safe');
  const third = gate.beginOwnedTeamQuiesce('team-a');
  first.release();
  second.release();
  await expect(gate.run('team-a', async () => 'unsafe')).rejects.toBeInstanceOf(MemberWorkSyncTeamQuiescedError);
  third.release();
  await expect(gate.run('team-a', async () => 'safe')).resolves.toBe('safe');
});

it('owned restore drain retains early-return physical work and leaves another team runnable', async () => {
  const gate = new MemberWorkSyncTeamOperationGate();
  const tail = createDeferred<void>();
  await gate.run('team-a', async admission => { admission.trackSettling(tail.promise); });
  const restore = gate.beginOwnedTeamQuiesce('team-a');
  let drained = false;
  const drain = gate.awaitTeamIdle('team-a').then(() => { drained = true; });
  try {
    await gate.run('team-b', async () => undefined);
    expect(drained).toBe(false);
    await expect(gate.run('team-a', async () => 'unsafe')).rejects.toBeInstanceOf(MemberWorkSyncTeamQuiescedError);
  } finally { tail.resolve(); await drain; restore.release(); }
  expect(drained).toBe(true);
  await expect(gate.run('team-a', async () => 'safe')).resolves.toBe('safe');
});

it('closes all admission and drains remaining operations', async () => {
  const gate = new MemberWorkSyncTeamOperationGate();
  const admitted = createDeferred<string>();
  const admittedRun = gate.run('team-a', () => admitted.promise);
  gate.close();

  await expect(gate.run('team-b', async () => 'must-not-run')).rejects.toEqual(
    new MemberWorkSyncTeamQuiescedError('team-b')
  );

  let idle = false;
  const idlePromise = gate.awaitIdle().then(() => {
    idle = true;
  });
  await Promise.resolve();
  expect(idle).toBe(false);

  admitted.resolve('done');
  await expect(admittedRun).resolves.toBe('done');
  await idlePromise;
  expect(idle).toBe(true);
  await expect(gate.run('team-a', async () => 'reopened')).rejects.toBeInstanceOf(
    MemberWorkSyncTeamQuiescedError
  );
});
