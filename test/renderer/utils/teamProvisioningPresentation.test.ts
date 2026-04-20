import { describe, expect, it } from 'vitest';

import { buildTeamProvisioningPresentation } from '@renderer/utils/teamProvisioningPresentation';

describe('buildTeamProvisioningPresentation', () => {
  it('uses a lead-online compact detail for ready teams without teammates', () => {
    const presentation = buildTeamProvisioningPresentation({
      progress: {
        runId: 'run-1',
        teamName: 'solo-team',
        state: 'ready',
        startedAt: '2026-04-13T10:00:00.000Z',
        updatedAt: '2026-04-13T10:00:05.000Z',
        message: 'Launch completed',
        messageSeverity: undefined,
        pid: 4321,
        cliLogsTail: '',
        assistantOutput: '',
      },
      members: [
        {
          name: 'team-lead',
        },
      ],
      memberSpawnStatuses: {},
      memberSpawnSnapshot: undefined,
    });

    expect(presentation?.compactTitle).toBe('Team launched');
    expect(presentation?.compactDetail).toBe('Lead online');
  });

  it('surfaces the failed teammate reason while launch is still active', () => {
    const presentation = buildTeamProvisioningPresentation({
      progress: {
        runId: 'run-2',
        teamName: 'codex-team',
        state: 'assembling',
        startedAt: '2026-04-13T10:00:00.000Z',
        updatedAt: '2026-04-13T10:00:05.000Z',
        message: 'Spawning member jack...',
        messageSeverity: undefined,
        pid: 4321,
        cliLogsTail: '',
        assistantOutput: '',
      },
      members: [
        {
          name: 'team-lead',
          agentType: 'team-lead',
          status: 'active',
          currentTaskId: null,
          taskCount: 0,
          lastActiveAt: null,
          messageCount: 0,
        },
        {
          name: 'jack',
          agentType: 'engineer',
          status: 'unknown',
          currentTaskId: null,
          taskCount: 0,
          lastActiveAt: null,
          messageCount: 0,
        },
      ],
      memberSpawnStatuses: {
        jack: {
          status: 'error',
          launchState: 'failed_to_start',
          error:
            "The 'gpt-5.2-codex' model is not supported when using Codex with a ChatGPT account.",
          hardFailureReason:
            "The 'gpt-5.2-codex' model is not supported when using Codex with a ChatGPT account.",
          updatedAt: '2026-04-13T10:00:03.000Z',
          runtimeAlive: false,
          bootstrapConfirmed: false,
          hardFailure: true,
          agentToolAccepted: true,
          firstSpawnAcceptedAt: '2026-04-13T10:00:01.000Z',
        },
      },
      memberSpawnSnapshot: undefined,
    });

    expect(presentation?.panelMessage).toContain('jack failed to start');
    expect(presentation?.panelMessage).toContain('gpt-5.2-codex');
    expect(presentation?.panelMessageSeverity).toBe('warning');
    expect(presentation?.compactDetail).toBe('jack failed to start');
    expect(presentation?.compactTone).toBe('warning');
    expect(presentation?.defaultLiveOutputOpen).toBe(false);
  });

  it('surfaces the failed teammate reason after launch completes with errors', () => {
    const presentation = buildTeamProvisioningPresentation({
      progress: {
        runId: 'run-3',
        teamName: 'codex-team',
        state: 'ready',
        startedAt: '2026-04-13T10:00:00.000Z',
        updatedAt: '2026-04-13T10:00:08.000Z',
        message: 'Launch completed with teammate errors - jack failed to start',
        messageSeverity: 'warning',
        pid: 4321,
        cliLogsTail: '',
        assistantOutput: '',
      },
      members: [
        {
          name: 'team-lead',
          agentType: 'team-lead',
          status: 'active',
          currentTaskId: null,
          taskCount: 0,
          lastActiveAt: null,
          messageCount: 0,
        },
        {
          name: 'jack',
          agentType: 'engineer',
          status: 'unknown',
          currentTaskId: null,
          taskCount: 0,
          lastActiveAt: null,
          messageCount: 0,
        },
      ],
      memberSpawnStatuses: {
        jack: {
          status: 'error',
          launchState: 'failed_to_start',
          error: 'The requested model is not available for your account.',
          hardFailureReason: 'The requested model is not available for your account.',
          updatedAt: '2026-04-13T10:00:03.000Z',
          runtimeAlive: false,
          bootstrapConfirmed: false,
          hardFailure: true,
          agentToolAccepted: true,
          firstSpawnAcceptedAt: '2026-04-13T10:00:01.000Z',
        },
      },
      memberSpawnSnapshot: {
        expectedMembers: ['jack'],
        summary: {
          confirmedCount: 0,
          pendingCount: 0,
          failedCount: 1,
          runtimeAlivePendingCount: 0,
        },
      },
    });

    expect(presentation?.successMessage).toBe('Launch finished with errors - 1/1 teammates failed to start');
    expect(presentation?.panelMessage).toContain('requested model is not available');
    expect(presentation?.compactDetail).toBe('jack failed to start');
  });
});
