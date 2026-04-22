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

  it('keeps a generic failed teammate message when only persisted failure counts remain', () => {
    const presentation = buildTeamProvisioningPresentation({
      progress: {
        runId: 'run-3b',
        teamName: 'codex-team',
        state: 'ready',
        startedAt: '2026-04-13T10:00:00.000Z',
        updatedAt: '2026-04-13T10:00:08.000Z',
        message: 'Launch completed',
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
      memberSpawnStatuses: {},
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
    expect(presentation?.panelMessage).toBe('1 teammate failed to start');
    expect(presentation?.compactDetail).toBe('1 teammate failed to start');
  });

  it('prefers live member spawn statuses over a stale persisted launch summary', () => {
    const presentation = buildTeamProvisioningPresentation({
      progress: {
        runId: 'run-4',
        teamName: 'codex-team',
        state: 'ready',
        startedAt: '2026-04-13T10:00:00.000Z',
        updatedAt: '2026-04-13T10:00:08.000Z',
        message: 'Launch completed',
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
          name: 'bob',
          agentType: 'engineer',
          status: 'unknown',
          currentTaskId: null,
          taskCount: 0,
          lastActiveAt: null,
          messageCount: 0,
        },
      ],
      memberSpawnStatuses: {
        bob: {
          status: 'online',
          launchState: 'runtime_pending_bootstrap',
          updatedAt: '2026-04-13T10:00:07.000Z',
          runtimeAlive: true,
          livenessSource: 'process',
          bootstrapConfirmed: false,
          hardFailure: false,
          agentToolAccepted: true,
          firstSpawnAcceptedAt: '2026-04-13T10:00:01.000Z',
        },
      },
      memberSpawnSnapshot: {
        expectedMembers: ['bob'],
        summary: {
          confirmedCount: 0,
          pendingCount: 1,
          failedCount: 0,
          runtimeAlivePendingCount: 0,
        },
      },
    });

    expect(presentation?.compactTitle).toBe('Finishing launch');
    expect(presentation?.compactDetail).toBe('1 teammate still joining');
    expect(presentation?.panelMessage).toBe('1 teammate still joining');
  });

  it('surfaces permission-blocked teammates as awaiting approval while launch is finishing', () => {
    const presentation = buildTeamProvisioningPresentation({
      progress: {
        runId: 'run-4c',
        teamName: 'opencode-team',
        state: 'ready',
        startedAt: '2026-04-13T10:00:00.000Z',
        updatedAt: '2026-04-13T10:00:08.000Z',
        message: 'Launch completed',
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
          name: 'bob',
          agentType: 'engineer',
          status: 'unknown',
          currentTaskId: null,
          taskCount: 0,
          lastActiveAt: null,
          messageCount: 0,
        },
      ],
      memberSpawnStatuses: {
        bob: {
          status: 'online',
          launchState: 'runtime_pending_permission',
          updatedAt: '2026-04-13T10:00:07.000Z',
          runtimeAlive: true,
          livenessSource: 'process',
          bootstrapConfirmed: false,
          hardFailure: false,
          agentToolAccepted: true,
          pendingPermissionRequestIds: ['perm_1'],
          firstSpawnAcceptedAt: '2026-04-13T10:00:01.000Z',
        },
      },
      memberSpawnSnapshot: {
        expectedMembers: ['bob'],
        summary: {
          confirmedCount: 0,
          pendingCount: 1,
          failedCount: 0,
          runtimeAlivePendingCount: 1,
        },
      },
    });

    expect(presentation?.compactTitle).toBe('Finishing launch');
    expect(presentation?.compactDetail).toBe('1 teammate awaiting permission approval');
    expect(presentation?.panelMessage).toBe('1 teammate awaiting permission approval');
  });

  it('surfaces permission-blocked teammates as awaiting approval while launch is still active', () => {
    const presentation = buildTeamProvisioningPresentation({
      progress: {
        runId: 'run-4d',
        teamName: 'opencode-team',
        state: 'finalizing',
        startedAt: '2026-04-13T10:00:00.000Z',
        updatedAt: '2026-04-13T10:00:08.000Z',
        message: 'Waiting for runtime confirmation',
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
          name: 'bob',
          agentType: 'engineer',
          status: 'unknown',
          currentTaskId: null,
          taskCount: 0,
          lastActiveAt: null,
          messageCount: 0,
        },
      ],
      memberSpawnStatuses: {
        bob: {
          status: 'online',
          launchState: 'runtime_pending_permission',
          updatedAt: '2026-04-13T10:00:07.000Z',
          runtimeAlive: true,
          livenessSource: 'process',
          bootstrapConfirmed: false,
          hardFailure: false,
          agentToolAccepted: true,
          pendingPermissionRequestIds: ['perm_1'],
          firstSpawnAcceptedAt: '2026-04-13T10:00:01.000Z',
        },
      },
      memberSpawnSnapshot: {
        expectedMembers: ['bob'],
        summary: {
          confirmedCount: 0,
          pendingCount: 1,
          failedCount: 0,
          runtimeAlivePendingCount: 1,
        },
      },
    });

    expect(presentation?.compactTitle).toBe('Launching team');
    expect(presentation?.compactDetail).toBe('1 teammate awaiting permission approval');
    expect(presentation?.panelMessage).toBe('1 teammate awaiting permission approval');
  });

  it('keeps a generic failed teammate message while launch is still active if only persisted failure counts remain', () => {
    const presentation = buildTeamProvisioningPresentation({
      progress: {
        runId: 'run-4b',
        teamName: 'codex-team',
        state: 'assembling',
        startedAt: '2026-04-13T10:00:00.000Z',
        updatedAt: '2026-04-13T10:00:05.000Z',
        message: 'Finalizing launch...',
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
      memberSpawnStatuses: {},
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

    expect(presentation?.panelMessage).toBe('1 teammate failed to start');
    expect(presentation?.compactDetail).toBe('1 teammate failed to start');
    expect(presentation?.compactTone).toBe('warning');
  });

  it('prefers live confirmed teammates over a stale persisted launch summary', () => {
    const presentation = buildTeamProvisioningPresentation({
      progress: {
        runId: 'run-5',
        teamName: 'codex-team',
        state: 'ready',
        startedAt: '2026-04-13T10:00:00.000Z',
        updatedAt: '2026-04-13T10:00:08.000Z',
        message: 'Launch completed',
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
          name: 'bob',
          agentType: 'engineer',
          status: 'unknown',
          currentTaskId: null,
          taskCount: 0,
          lastActiveAt: null,
          messageCount: 0,
        },
      ],
      memberSpawnStatuses: {
        bob: {
          status: 'online',
          launchState: 'confirmed_alive',
          updatedAt: '2026-04-13T10:00:07.000Z',
          runtimeAlive: true,
          livenessSource: 'heartbeat',
          bootstrapConfirmed: true,
          hardFailure: false,
          agentToolAccepted: true,
          firstSpawnAcceptedAt: '2026-04-13T10:00:01.000Z',
          lastHeartbeatAt: '2026-04-13T10:00:07.000Z',
        },
      },
      memberSpawnSnapshot: {
        expectedMembers: ['bob'],
        summary: {
          confirmedCount: 0,
          pendingCount: 1,
          failedCount: 0,
          runtimeAlivePendingCount: 0,
        },
      },
    });

    expect(presentation?.compactTitle).toBe('Team launched');
    expect(presentation?.compactDetail).toBe('All 1 teammates joined');
    expect(presentation?.panelMessage).toBeNull();
    expect(presentation?.currentStepIndex).toBe(4);
  });

  it('ignores removed teammates that still linger in persisted expectedMembers', () => {
    const presentation = buildTeamProvisioningPresentation({
      progress: {
        runId: 'run-6',
        teamName: 'codex-team',
        state: 'ready',
        startedAt: '2026-04-13T10:00:00.000Z',
        updatedAt: '2026-04-13T10:00:08.000Z',
        message: 'Launch completed',
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
          name: 'alice',
          agentType: 'reviewer',
          status: 'active',
          currentTaskId: null,
          taskCount: 0,
          lastActiveAt: null,
          messageCount: 0,
        },
        {
          name: 'bob',
          agentType: 'developer',
          status: 'unknown',
          currentTaskId: null,
          taskCount: 0,
          lastActiveAt: null,
          messageCount: 0,
          removedAt: 1_713_000_000_000,
        },
      ],
      memberSpawnStatuses: {
        alice: {
          status: 'online',
          launchState: 'confirmed_alive',
          updatedAt: '2026-04-13T10:00:07.000Z',
          runtimeAlive: true,
          bootstrapConfirmed: true,
          hardFailure: false,
          agentToolAccepted: true,
        },
      },
      memberSpawnSnapshot: {
        expectedMembers: ['alice', 'bob'],
        summary: {
          confirmedCount: 1,
          pendingCount: 1,
          failedCount: 0,
          runtimeAlivePendingCount: 0,
        },
      },
    });

    expect(presentation?.compactTitle).toBe('Team launched');
    expect(presentation?.compactDetail).toBe('All 1 teammates joined');
    expect(presentation?.panelMessage).toBeNull();
    expect(presentation?.currentStepIndex).toBe(4);
  });

  it('keeps active teammates that are missing from persisted expectedMembers', () => {
    const presentation = buildTeamProvisioningPresentation({
      progress: {
        runId: 'run-7',
        teamName: 'codex-team',
        state: 'ready',
        startedAt: '2026-04-13T10:00:00.000Z',
        updatedAt: '2026-04-13T10:00:08.000Z',
        message: 'Launch completed',
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
          name: 'alice',
          agentType: 'reviewer',
          status: 'active',
          currentTaskId: null,
          taskCount: 0,
          lastActiveAt: null,
          messageCount: 0,
        },
        {
          name: 'bob',
          agentType: 'developer',
          status: 'unknown',
          currentTaskId: null,
          taskCount: 0,
          lastActiveAt: null,
          messageCount: 0,
        },
      ],
      memberSpawnStatuses: {
        alice: {
          status: 'online',
          launchState: 'confirmed_alive',
          updatedAt: '2026-04-13T10:00:07.000Z',
          runtimeAlive: true,
          bootstrapConfirmed: true,
          hardFailure: false,
          agentToolAccepted: true,
        },
        bob: {
          status: 'waiting',
          launchState: 'starting',
          updatedAt: '2026-04-13T10:00:07.000Z',
          runtimeAlive: false,
          bootstrapConfirmed: false,
          hardFailure: false,
          agentToolAccepted: false,
        },
      },
      memberSpawnSnapshot: {
        expectedMembers: ['alice'],
        summary: {
          confirmedCount: 1,
          pendingCount: 0,
          failedCount: 0,
          runtimeAlivePendingCount: 0,
        },
      },
    });

    expect(presentation?.compactTitle).toBe('Finishing launch');
    expect(presentation?.compactDetail).toBe('1 teammate still joining');
    expect(presentation?.panelMessage).toBe('1 teammate still joining');
    expect(presentation?.currentStepIndex).toBe(2);
  });
});
