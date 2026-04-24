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

    expect(presentation?.successMessage).toBe(
      'Launch finished with errors - 1/1 teammates failed to start'
    );
    expect(presentation?.panelMessage).toContain('requested model is not available');
    expect(presentation?.compactDetail).toBe('jack failed to start');
    expect(presentation?.currentStepIndex).toBe(2);
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

    expect(presentation?.successMessage).toBe(
      'Launch finished with errors - 1/1 teammates failed to start'
    );
    expect(presentation?.panelMessage).toBe('1 teammate failed to start');
    expect(presentation?.compactDetail).toBe('1 teammate failed to start');
    expect(presentation?.currentStepIndex).toBe(2);
  });

  it('keeps Members joining incomplete while active launch already has failed teammates', () => {
    const presentation = buildTeamProvisioningPresentation({
      progress: {
        runId: 'run-3c',
        teamName: 'mixed-team',
        state: 'finalizing',
        startedAt: '2026-04-13T10:00:00.000Z',
        updatedAt: '2026-04-13T10:00:08.000Z',
        message: 'Finishing launch',
        messageSeverity: undefined,
        pid: 4321,
        configReady: true,
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
          status: 'error',
          launchState: 'failed_to_start',
          updatedAt: '2026-04-13T10:00:07.000Z',
          runtimeAlive: false,
          bootstrapConfirmed: false,
          hardFailure: true,
          hardFailureReason: 'OpenCode lane failed',
          agentToolAccepted: false,
        },
      },
      memberSpawnSnapshot: {
        expectedMembers: ['alice', 'bob'],
        summary: {
          confirmedCount: 1,
          pendingCount: 0,
          failedCount: 1,
          runtimeAlivePendingCount: 0,
        },
      },
    });

    expect(presentation?.currentStepIndex).toBe(2);
    expect(presentation?.panelMessage).toContain('bob failed to start');
    expect(presentation?.compactTone).toBe('warning');
  });

  it('shows skipped teammates as a continued launch instead of still joining', () => {
    const presentation = buildTeamProvisioningPresentation({
      progress: {
        runId: 'run-3d',
        teamName: 'mixed-team',
        state: 'ready',
        startedAt: '2026-04-13T10:00:00.000Z',
        updatedAt: '2026-04-13T10:00:08.000Z',
        message: 'Launch completed',
        messageSeverity: undefined,
        pid: 4321,
        configReady: true,
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
          agentType: 'developer',
          status: 'unknown',
          currentTaskId: null,
          taskCount: 0,
          lastActiveAt: null,
          messageCount: 0,
        },
      ],
      memberSpawnStatuses: {
        bob: {
          status: 'skipped',
          launchState: 'skipped_for_launch',
          updatedAt: '2026-04-13T10:00:07.000Z',
          runtimeAlive: false,
          bootstrapConfirmed: false,
          hardFailure: false,
          agentToolAccepted: false,
          skippedForLaunch: true,
          skipReason: 'Skipped by user after launch failure: OpenCode lane failed',
        },
      },
      memberSpawnSnapshot: {
        expectedMembers: ['bob'],
        summary: {
          confirmedCount: 0,
          pendingCount: 0,
          failedCount: 0,
          skippedCount: 1,
          runtimeAlivePendingCount: 0,
        },
      },
    });

    expect(presentation?.successMessage).toBe('Launch continued - 1/1 teammates skipped');
    expect(presentation?.panelMessage).toContain('bob skipped for this launch');
    expect(presentation?.compactTitle).toBe('Launch continued with skipped teammates');
    expect(presentation?.compactDetail).toBe('bob skipped');
    expect(presentation?.compactTone).toBe('warning');
    expect(presentation?.currentStepIndex).toBe(2);
    expect(presentation?.hasMembersStillJoining).toBe(false);
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

  it('does not let stale live failures override a newer persisted pending snapshot', () => {
    const presentation = buildTeamProvisioningPresentation({
      progress: {
        runId: 'run-4-stale-live-failure',
        teamName: 'mixed-team',
        state: 'ready',
        startedAt: '2026-04-13T10:00:00.000Z',
        updatedAt: '2026-04-13T10:00:10.000Z',
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
          agentType: 'developer',
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
          hardFailureReason: 'Teammate was never spawned during launch.',
          updatedAt: '2026-04-13T10:00:05.000Z',
          runtimeAlive: false,
          bootstrapConfirmed: false,
          hardFailure: true,
          agentToolAccepted: false,
        },
      },
      memberSpawnSnapshot: {
        expectedMembers: ['jack'],
        updatedAt: '2026-04-13T10:00:09.000Z',
        statuses: {
          jack: {
            status: 'waiting',
            launchState: 'starting',
            updatedAt: '2026-04-13T10:00:09.000Z',
            runtimeAlive: false,
            bootstrapConfirmed: false,
            hardFailure: false,
            agentToolAccepted: false,
          },
        },
        summary: {
          confirmedCount: 0,
          pendingCount: 1,
          failedCount: 0,
          runtimeAlivePendingCount: 0,
        },
      },
    });

    expect(presentation?.successMessage).toBe('Finishing launch');
    expect(presentation?.panelMessage).toBe('1 teammate still joining');
    expect(presentation?.compactDetail).toBe('1 teammate still joining');
    expect(presentation?.failedSpawnCount).toBe(0);
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

  it('trusts pending permission request ids even before launchState flips to runtime_pending_permission', () => {
    const presentation = buildTeamProvisioningPresentation({
      progress: {
        runId: 'run-4e',
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
          launchState: 'runtime_pending_bootstrap',
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

    expect(presentation?.compactDetail).toBe('1 teammate awaiting permission approval');
    expect(presentation?.panelMessage).toBe('1 teammate awaiting permission approval');
  });

  it('trusts persisted snapshot permission state when live member spawn statuses are absent', () => {
    const presentation = buildTeamProvisioningPresentation({
      progress: {
        runId: 'run-4f',
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
      memberSpawnStatuses: {},
      memberSpawnSnapshot: {
        expectedMembers: ['bob'],
        statuses: {
          bob: {
            status: 'online',
            launchState: 'runtime_pending_bootstrap',
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

  it('names teammates in pending runtime diagnostic summaries', () => {
    const presentation = buildTeamProvisioningPresentation({
      progress: {
        runId: 'run-named-diagnostics',
        teamName: 'runtime-team',
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
          agentType: 'developer',
          status: 'unknown',
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
      memberSpawnStatuses: {},
      memberSpawnSnapshot: {
        expectedMembers: ['alice', 'bob'],
        statuses: {
          alice: {
            status: 'waiting',
            launchState: 'runtime_pending_bootstrap',
            updatedAt: '2026-04-13T10:00:07.000Z',
            runtimeAlive: false,
            bootstrapConfirmed: false,
            hardFailure: false,
            agentToolAccepted: true,
            livenessKind: 'not_found',
            runtimeDiagnostic: 'runtime process not found',
          },
          bob: {
            status: 'waiting',
            launchState: 'runtime_pending_bootstrap',
            updatedAt: '2026-04-13T10:00:07.000Z',
            runtimeAlive: false,
            bootstrapConfirmed: false,
            hardFailure: false,
            agentToolAccepted: true,
            livenessKind: 'not_found',
            runtimeDiagnostic: 'runtime process not found',
          },
        },
        summary: {
          confirmedCount: 0,
          pendingCount: 2,
          failedCount: 0,
          runtimeAlivePendingCount: 0,
          noRuntimePendingCount: 2,
        },
      },
    });

    expect(presentation?.compactTitle).toBe('Finishing launch');
    expect(presentation?.compactDetail).toBe('No runtime found: alice, bob');
    expect(presentation?.panelMessage).toBe('No runtime found: alice, bob');
  });

  it('names live pending diagnostics without duplicating permission-blocked teammates', () => {
    const presentation = buildTeamProvisioningPresentation({
      progress: {
        runId: 'run-live-diagnostics',
        teamName: 'runtime-team',
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
          agentType: 'developer',
          status: 'unknown',
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
          launchState: 'runtime_pending_bootstrap',
          updatedAt: '2026-04-13T10:00:07.000Z',
          runtimeAlive: true,
          bootstrapConfirmed: false,
          hardFailure: false,
          agentToolAccepted: true,
          livenessKind: 'runtime_process',
        },
        bob: {
          status: 'online',
          launchState: 'runtime_pending_permission',
          updatedAt: '2026-04-13T10:00:07.000Z',
          runtimeAlive: true,
          bootstrapConfirmed: false,
          hardFailure: false,
          agentToolAccepted: true,
          livenessKind: 'runtime_process',
          pendingPermissionRequestIds: ['perm_1'],
        },
      },
      memberSpawnSnapshot: undefined,
    });

    expect(presentation?.panelMessage).toBe(
      'Waiting for bootstrap: alice, Awaiting permission: bob'
    );
    expect(presentation?.panelMessage).not.toContain('Waiting for bootstrap: alice, bob');
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

  it('surfaces persisted failed teammate reasons when live member statuses are missing', () => {
    const presentation = buildTeamProvisioningPresentation({
      progress: {
        runId: 'run-4c',
        teamName: 'codex-team',
        state: 'ready',
        startedAt: '2026-04-13T10:00:00.000Z',
        updatedAt: '2026-04-13T10:00:08.000Z',
        message: 'Launch completed with teammate errors',
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
      memberSpawnStatuses: {},
      memberSpawnSnapshot: {
        expectedMembers: ['jack'],
        summary: {
          confirmedCount: 0,
          pendingCount: 0,
          failedCount: 1,
          runtimeAlivePendingCount: 0,
        },
        statuses: {
          jack: {
            status: 'error',
            launchState: 'failed_to_start',
            hardFailureReason: 'The requested model is not available for your account.',
            updatedAt: '2026-04-13T10:00:03.000Z',
            runtimeAlive: false,
            bootstrapConfirmed: false,
            hardFailure: true,
            agentToolAccepted: true,
            firstSpawnAcceptedAt: '2026-04-13T10:00:01.000Z',
          },
        },
      },
    });

    expect(presentation?.panelMessage).toContain('jack failed to start');
    expect(presentation?.panelMessage).toContain('requested model is not available');
    expect(presentation?.compactDetail).toBe('jack failed to start');
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
