import { describe, expect, it } from 'vitest';

import { createTeamProvisioningMemberLifecycleServiceUseCases } from '../TeamProvisioningMemberLifecycleServiceUseCases';

import type { DirectProcessRuntimeEventInput } from '../TeamProvisioningAppendDirectProcessRuntimeEventUseCase';

describe('TeamProvisioningMemberLifecycleServiceUseCases', () => {
  it('creates only the service-owned lifecycle use case ports', async () => {
    const sentMessages: Array<{ teamName: string; message: Record<string, unknown> }> = [];
    const runtimeEvents: DirectProcessRuntimeEventInput[] = [];

    const useCases = createTeamProvisioningMemberLifecycleServiceUseCases({
      persistSentMessage: (teamName, message) => {
        sentMessages.push({ teamName, message });
      },
      appendDirectProcessRuntimeEvent: async (input) => {
        runtimeEvents.push(input);
      },
      nowIso: () => '2026-07-06T17:00:00.000Z',
      randomUUID: () => 'uuid-1',
    });

    expect(Object.keys(useCases).sort()).toEqual([
      'appendDirectProcessRuntimeEvent',
      'persistOpenCodeMemberRestartSystemMessage',
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
      eventsPath: '/tmp/team-a/runtime/events.jsonl',
      pid: 123,
      teamName: 'team-a',
      agentName: 'Worker',
      agentId: 'worker@team-a',
      runId: 'lead-session-1',
      bootstrapRunId: 'bootstrap-1',
      source: 'test',
    });
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
  });
});
