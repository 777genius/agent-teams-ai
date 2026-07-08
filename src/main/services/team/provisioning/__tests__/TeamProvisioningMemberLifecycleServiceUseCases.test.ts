import { describe, expect, it } from 'vitest';

import { createTeamProvisioningMemberLifecycleServiceUseCases } from '../TeamProvisioningMemberLifecycleServiceUseCases';

import type { DirectProcessRuntimeEventInput } from '../TeamProvisioningAppendDirectProcessRuntimeEventUseCase';
import type { TeamProvisioningMemberLifecycleOperationRunner } from '../TeamProvisioningMemberLifecycleOperationRunner';

type RunMemberLifecycleOperationKind = Parameters<
  TeamProvisioningMemberLifecycleOperationRunner['runMemberLifecycleOperation']
>[2];

describe('TeamProvisioningMemberLifecycleServiceUseCases', () => {
  it('creates only the service-owned lifecycle use case ports', async () => {
    const sentMessages: Array<{ teamName: string; message: Record<string, unknown> }> = [];
    const runtimeEvents: DirectProcessRuntimeEventInput[] = [];
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

    const useCases = createTeamProvisioningMemberLifecycleServiceUseCases({
      persistSentMessage: (teamName, message) => {
        sentMessages.push({ teamName, message });
      },
      appendDirectProcessRuntimeEvent: async (input) => {
        runtimeEvents.push(input);
      },
      operationRunner,
      nowIso: () => '2026-07-06T17:00:00.000Z',
      randomUUID: () => 'uuid-1',
    });

    expect(Object.keys(useCases).sort()).toEqual([
      'appendDirectProcessRuntimeEvent',
      'persistOpenCodeMemberRestartSystemMessage',
      'runMemberLifecycleOperation',
    ]);

    useCases.persistOpenCodeMemberRestartSystemMessage({
      teamName: 'team-a',
      leadName: 'Lead',
      leadSessionId: 'lead-session-1',
      displayName: 'Team A',
      member: { name: 'Worker', role: 'Developer', providerId: 'opencode' },
      reason: 'manual_restart',
    });
    await useCases.appendDirectProcessRuntimeEvent({
      type: 'process_spawned',
      eventsPath: 'team-a/runtime/events.jsonl',
      pid: 123,
      teamName: 'team-a',
      agentName: 'Worker',
      agentId: 'worker@team-a',
      runId: 'lead-session-1',
      bootstrapRunId: 'bootstrap-1',
      source: 'test',
    });
    await expect(
      useCases.runMemberLifecycleOperation('team-a', 'Worker', 'manual_restart', async () => 'done')
    ).resolves.toBe('done');

    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0]?.message).toMatchObject({
      from: 'Lead',
      to: 'Worker',
      timestamp: '2026-07-06T17:00:00.000Z',
      messageId: 'member-restart:team-a:Worker:uuid-1',
      summary: 'Restarting Worker by user request',
    });
    expect(runtimeEvents).toEqual([
      expect.objectContaining({
        type: 'process_spawned',
        teamName: 'team-a',
        agentName: 'Worker',
        pid: 123,
      }),
    ]);
    expect(operationCalls).toEqual(['runner-bound:team-a:Worker:manual_restart']);
  });
});
