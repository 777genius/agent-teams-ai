import { describe, expect, it } from 'vitest';

import { createTeamProvisioningMemberLifecycleOperationUseCases } from '../TeamProvisioningMemberLifecycleOperationUseCases';

import type { TeamProvisioningMemberLifecycleOperationRunner } from '../TeamProvisioningMemberLifecycleOperationRunner';

type RunMemberLifecycleOperationKind = Parameters<
  TeamProvisioningMemberLifecycleOperationRunner['runMemberLifecycleOperation']
>[2];

describe('TeamProvisioningMemberLifecycleOperationUseCases', () => {
  it('keeps the operation runner behind a dedicated lifecycle use case port', async () => {
    const operationCalls: string[] = [];
    const operationRunner = {
      marker: 'runner-bound',
      async runMemberLifecycleOperation<T>(
        this: { marker: string },
        teamName: string,
        memberName: string,
        kind: RunMemberLifecycleOperationKind,
        operation: () => Promise<T>
      ): Promise<T> {
        operationCalls.push(`${this.marker}:${teamName}:${memberName}:${kind}`);
        return await operation();
      },
    } as Pick<TeamProvisioningMemberLifecycleOperationRunner, 'runMemberLifecycleOperation'> & {
      marker: string;
    };

    const useCases = createTeamProvisioningMemberLifecycleOperationUseCases({
      operationRunner,
    });

    expect(Object.keys(useCases)).toEqual(['runMemberLifecycleOperation']);
    await expect(
      useCases.runMemberLifecycleOperation('team-a', 'Worker', 'manual_restart', async () => 'done')
    ).resolves.toBe('done');

    expect(operationCalls).toEqual(['runner-bound:team-a:Worker:manual_restart']);
  });
});
