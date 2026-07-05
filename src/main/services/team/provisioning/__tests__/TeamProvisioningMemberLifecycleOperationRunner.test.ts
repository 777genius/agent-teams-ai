import { describe, expect, it, vi } from 'vitest';

import { getMemberLifecycleOperationKey } from '../TeamProvisioningMemberLifecycleKeys';
import {
  createTeamProvisioningMemberLifecycleOperationRunner,
  type MemberLifecycleOperation,
} from '../TeamProvisioningMemberLifecycleOperationRunner';

function createRunnerHarness(initialOperations?: Iterable<[string, MemberLifecycleOperation]>) {
  const memberLifecycleOperations = new Map(initialOperations);
  const invalidatedTeams: string[] = [];
  const nowMs = vi.fn(() => 1_234);
  const runner = createTeamProvisioningMemberLifecycleOperationRunner({
    memberLifecycleOperations,
    invalidateRuntimeSnapshotCaches: (teamName) => {
      invalidatedTeams.push(teamName);
    },
    nowMs,
  });

  return {
    invalidatedTeams,
    memberLifecycleOperations,
    nowMs,
    runner,
  };
}

describe('TeamProvisioningMemberLifecycleOperationRunner', () => {
  it('tracks one member lifecycle operation and clears it after success', async () => {
    const harness = createRunnerHarness();
    let activeDuringOperation = false;

    const result = await harness.runner.runMemberLifecycleOperation(
      'team-a',
      'Dev',
      'manual_restart',
      async () => {
        activeDuringOperation = harness.runner.isMemberLifecycleOperationActive('TEAM-A', ' dev ');
        expect(
          harness.memberLifecycleOperations.get(getMemberLifecycleOperationKey('team-a', 'Dev'))
        ).toMatchObject({
          kind: 'manual_restart',
          startedAtMs: 1_234,
        });
        return 'ok';
      }
    );

    expect(result).toBe('ok');
    expect(activeDuringOperation).toBe(true);
    expect(harness.runner.isMemberLifecycleOperationActive('team-a', 'Dev')).toBe(false);
    expect(harness.memberLifecycleOperations.size).toBe(0);
    expect(harness.invalidatedTeams).toEqual(['team-a', 'team-a']);
  });

  it('clears lifecycle operations after failed work', async () => {
    const harness = createRunnerHarness();

    await expect(
      harness.runner.runMemberLifecycleOperation('team-a', 'Dev', 'primary_member_updated', () =>
        Promise.reject(new Error('launch failed'))
      )
    ).rejects.toThrow('launch failed');

    expect(harness.memberLifecycleOperations.size).toBe(0);
    expect(harness.invalidatedTeams).toEqual(['team-a', 'team-a']);
  });

  it('rejects overlapping operations for the same normalized member key', async () => {
    const existingToken = Symbol('existing');
    const harness = createRunnerHarness([
      [
        getMemberLifecycleOperationKey('team-a', 'Dev'),
        {
          kind: 'manual_restart',
          token: existingToken,
          startedAtMs: 1,
        },
      ],
    ]);
    const operation = vi.fn(async () => undefined);

    await expect(
      harness.runner.runMemberLifecycleOperation(
        ' TEAM-A ',
        ' dev ',
        'primary_member_updated',
        operation
      )
    ).rejects.toThrow('Lifecycle operation for teammate " dev " is already in progress');

    expect(operation).not.toHaveBeenCalled();
    expect(
      harness.memberLifecycleOperations.get(getMemberLifecycleOperationKey('team-a', 'Dev'))
    ).toEqual({
      kind: 'manual_restart',
      token: existingToken,
      startedAtMs: 1,
    });
    expect(harness.invalidatedTeams).toEqual([]);
  });
});
