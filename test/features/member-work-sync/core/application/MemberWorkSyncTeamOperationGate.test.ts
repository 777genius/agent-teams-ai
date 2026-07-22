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
});
