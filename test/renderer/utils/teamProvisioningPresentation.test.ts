import { buildTeamProvisioningPresentation } from '@renderer/utils/teamProvisioningPresentation';
import { describe, expect, it } from 'vitest';

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

    expect(presentation?.panelMessage).toBe('jack failed to start');
    expect(presentation?.panelMessageSeverity).toBe('warning');
    expect(presentation?.compactDetail).toBe('jack failed to start');
    expect(presentation?.compactTone).toBe('warning');
    expect(presentation?.defaultLiveOutputOpen).toBe(false);
  });

  it('counts retryable failed OpenCode secondary teammates conservatively', () => {
    const presentation = buildTeamProvisioningPresentation({
      progress: {
        runId: 'run-opencode-retry',
        teamName: 'mixed-team',
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
          providerId: 'anthropic',
        },
        {
          name: 'alice',
          agentType: 'developer',
          providerId: 'opencode',
          laneKind: 'secondary',
          laneOwnerProviderId: 'opencode',
        },
        {
          name: 'bob',
          agentType: 'developer',
          providerId: 'anthropic',
          laneKind: 'primary',
        },
      ],
      memberSpawnStatuses: {
        alice: {
          status: 'error',
          launchState: 'failed_to_start',
          hardFailureReason: 'OpenRouter credits exhausted',
          updatedAt: '2026-04-13T10:00:05.000Z',
          runtimeAlive: false,
          bootstrapConfirmed: false,
          hardFailure: true,
          agentToolAccepted: false,
        },
        bob: {
          status: 'error',
          launchState: 'failed_to_start',
          hardFailureReason: 'Primary lane failed',
          updatedAt: '2026-04-13T10:00:05.000Z',
          runtimeAlive: false,
          bootstrapConfirmed: false,
          hardFailure: true,
          agentToolAccepted: false,
        },
      },
      memberSpawnSnapshot: undefined,
    });

    expect(presentation?.retryableOpenCodeSecondaryFailedNames).toEqual(['alice']);
    expect(presentation?.retryableOpenCodeSecondaryFailedCount).toBe(1);
  });

  it('does not count skipped or permission-blocked OpenCode failures as bulk retry candidates', () => {
    const presentation = buildTeamProvisioningPresentation({
      progress: {
        runId: 'run-opencode-no-retry',
        teamName: 'mixed-team',
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
          name: 'alice',
          agentType: 'developer',
          providerId: 'opencode',
          laneKind: 'secondary',
          laneOwnerProviderId: 'opencode',
        },
        {
          name: 'tom',
          agentType: 'developer',
          providerId: 'opencode',
          laneKind: 'secondary',
          laneOwnerProviderId: 'opencode',
        },
      ],
      memberSpawnStatuses: {
        alice: {
          status: 'skipped',
          launchState: 'skipped_for_launch',
          skippedForLaunch: true,
          updatedAt: '2026-04-13T10:00:05.000Z',
          runtimeAlive: false,
          bootstrapConfirmed: false,
          hardFailure: false,
          agentToolAccepted: false,
        },
        tom: {
          status: 'waiting',
          launchState: 'runtime_pending_permission',
          pendingPermissionRequestIds: ['perm-1'],
          updatedAt: '2026-04-13T10:00:05.000Z',
          runtimeAlive: true,
          bootstrapConfirmed: false,
          hardFailure: false,
          agentToolAccepted: true,
        },
      },
      memberSpawnSnapshot: undefined,
    });

    expect(presentation?.retryableOpenCodeSecondaryFailedNames).toEqual([]);
    expect(presentation?.retryableOpenCodeSecondaryFailedCount).toBe(0);
  });

  it('does not truncate long failed teammate reasons in the panel message', () => {
    const reason =
      'You are bootstrapping into team "relay-works-10" as member "alice". Your first action is to call the MCP tool member_briefing on the agent-teams server with teamName="relay-works-10" and memberName="alice". If tool search shows only the prefixed MCP name, use mcp__agent-teams__member_briefing.';
    const presentation = buildTeamProvisioningPresentation({
      progress: {
        runId: 'run-long-failure',
        teamName: 'relay-works-10',
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
          name: 'alice',
          agentType: 'reviewer',
          status: 'unknown',
          currentTaskId: null,
          taskCount: 0,
          lastActiveAt: null,
          messageCount: 0,
        },
      ],
      memberSpawnStatuses: {
        alice: {
          status: 'error',
          launchState: 'failed_to_start',
          error: reason,
          hardFailureReason: reason,
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

    expect(presentation?.panelMessage).toBe('alice failed to start');
  });

  it('keeps multiple failed teammate details out of the top panel', () => {
    const presentation = buildTeamProvisioningPresentation({
      progress: {
        runId: 'run-multi-failure',
        teamName: 'relay-works-18',
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
        { name: 'team-lead', agentType: 'team-lead' },
        { name: 'alice', agentType: 'reviewer' },
        { name: 'tom', agentType: 'developer' },
      ],
      memberSpawnStatuses: {
        alice: {
          status: 'error',
          launchState: 'failed_to_start',
          hardFailureReason:
            'Latest assistant message msg_alice failed with APIError - Insufficient credits. Add more using https://openrouter.ai/settings/credits',
          updatedAt: '2026-04-13T10:00:03.000Z',
          runtimeAlive: false,
          bootstrapConfirmed: false,
          hardFailure: true,
          agentToolAccepted: true,
        },
        tom: {
          status: 'error',
          launchState: 'failed_to_start',
          hardFailureReason:
            'Latest assistant message msg_tom failed with APIError - Insufficient credits. Add more using https://openrouter.ai/settings/credits',
          updatedAt: '2026-04-13T10:00:04.000Z',
          runtimeAlive: false,
          bootstrapConfirmed: false,
          hardFailure: true,
          agentToolAccepted: true,
        },
      },
      memberSpawnSnapshot: {
        expectedMembers: ['alice', 'tom'],
        summary: {
          confirmedCount: 0,
          pendingCount: 0,
          failedCount: 2,
          runtimeAlivePendingCount: 0,
        },
      },
    });

    expect(presentation?.panelMessage).toBe('2 teammates failed to start');
    expect(presentation?.panelMessage).not.toContain('msg_alice');
    expect(presentation?.panelMessage).not.toContain('openrouter.ai');
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
    expect(presentation?.panelMessage).toBe('jack failed to start');
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
    expect(presentation?.panelMessage).toBe('bob failed to start');
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

  it('shows core team ready when only OpenCode secondary lanes are still joining', () => {
    const presentation = buildTeamProvisioningPresentation({
      progress: {
        runId: 'run-opencode-secondary-ready',
        teamName: 'mixed-team',
        state: 'ready',
        startedAt: '2026-04-13T10:00:00.000Z',
        updatedAt: '2026-04-13T10:00:08.000Z',
        message: 'Team provisioned - waiting for secondary runtime lane: tom',
        messageSeverity: undefined,
        pid: 4321,
        cliLogsTail: '',
        assistantOutput: '',
      },
      members: [
        {
          name: 'team-lead',
          agentType: 'team-lead',
          providerId: 'codex',
          status: 'active',
          currentTaskId: null,
          taskCount: 0,
          lastActiveAt: null,
          messageCount: 0,
        },
        {
          name: 'alice',
          providerId: 'codex',
          laneKind: 'primary',
          status: 'active',
          currentTaskId: null,
          taskCount: 0,
          lastActiveAt: null,
          messageCount: 0,
        },
        {
          name: 'tom',
          providerId: 'opencode',
          laneId: 'secondary:opencode:tom',
          laneKind: 'secondary',
          laneOwnerProviderId: 'opencode',
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
          updatedAt: '2026-04-13T10:00:05.000Z',
          runtimeAlive: true,
          bootstrapConfirmed: true,
          hardFailure: false,
          agentToolAccepted: true,
        },
        tom: {
          status: 'online',
          launchState: 'runtime_pending_bootstrap',
          updatedAt: '2026-04-13T10:00:07.000Z',
          runtimeAlive: true,
          livenessSource: 'process',
          livenessKind: 'runtime_process_candidate',
          bootstrapConfirmed: false,
          hardFailure: false,
          agentToolAccepted: true,
        },
      },
      memberSpawnSnapshot: {
        expectedMembers: ['alice', 'tom'],
        statuses: {
          alice: {
            status: 'online',
            launchState: 'confirmed_alive',
            updatedAt: '2026-04-13T10:00:05.000Z',
            runtimeAlive: true,
            bootstrapConfirmed: true,
            hardFailure: false,
            agentToolAccepted: true,
          },
          tom: {
            status: 'online',
            launchState: 'runtime_pending_bootstrap',
            updatedAt: '2026-04-13T10:00:07.000Z',
            runtimeAlive: true,
            livenessSource: 'process',
            livenessKind: 'runtime_process_candidate',
            bootstrapConfirmed: false,
            hardFailure: false,
            agentToolAccepted: true,
          },
        },
        summary: {
          confirmedCount: 1,
          pendingCount: 1,
          failedCount: 0,
          runtimeAlivePendingCount: 0,
          runtimeCandidatePendingCount: 1,
        },
      },
    });

    expect(presentation?.successMessage).toBe('Core team ready');
    expect(presentation?.panelMessage).toBe('Waiting for OpenCode: tom');
    expect(presentation?.compactTitle).toBe('Core team ready');
    expect(presentation?.compactDetail).toBe('Waiting for OpenCode: tom');
    expect(presentation?.currentStepIndex).toBe(2);
  });

  it('shows stalled OpenCode secondaries separately from normal bootstrap waiting', () => {
    const presentation = buildTeamProvisioningPresentation({
      progress: {
        runId: 'run-opencode-secondary-stalled',
        teamName: 'mixed-team',
        state: 'ready',
        startedAt: '2026-04-13T10:00:00.000Z',
        updatedAt: '2026-04-13T10:05:08.000Z',
        message: 'Team provisioned - waiting for secondary runtime lane: tom',
        messageSeverity: undefined,
        pid: 4321,
        cliLogsTail: '',
        assistantOutput: '',
      },
      members: [
        {
          name: 'team-lead',
          agentType: 'team-lead',
          providerId: 'codex',
          status: 'active',
          currentTaskId: null,
          taskCount: 0,
          lastActiveAt: null,
          messageCount: 0,
        },
        {
          name: 'alice',
          providerId: 'codex',
          laneKind: 'primary',
          status: 'active',
          currentTaskId: null,
          taskCount: 0,
          lastActiveAt: null,
          messageCount: 0,
        },
        {
          name: 'tom',
          providerId: 'opencode',
          laneId: 'secondary:opencode:tom',
          laneKind: 'secondary',
          laneOwnerProviderId: 'opencode',
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
          updatedAt: '2026-04-13T10:00:05.000Z',
          runtimeAlive: true,
          bootstrapConfirmed: true,
          hardFailure: false,
          agentToolAccepted: true,
        },
        tom: {
          status: 'waiting',
          launchState: 'runtime_pending_bootstrap',
          updatedAt: '2026-04-13T10:05:07.000Z',
          runtimeAlive: true,
          livenessKind: 'runtime_process',
          bootstrapConfirmed: false,
          hardFailure: false,
          agentToolAccepted: true,
          bootstrapStalled: true,
        },
      },
    });

    expect(presentation?.successMessage).toBe('Core team ready');
    expect(presentation?.panelMessage).toBe('Bootstrap stalled: tom');
    expect(presentation?.compactDetail).toBe('Bootstrap stalled: tom');
    expect(presentation?.currentStepIndex).toBe(2);
  });

  it('does not present bootstrap-confirmed provisioned-but-not-alive entries as failed', () => {
    const presentation = buildTeamProvisioningPresentation({
      progress: {
        runId: 'run-signal-ops',
        teamName: 'signal-ops',
        state: 'ready',
        startedAt: '2026-05-25T20:13:40.000Z',
        updatedAt: '2026-05-25T20:14:05.411Z',
        message: 'Team provisioned',
        messageSeverity: undefined,
        pid: 27036,
        cliLogsTail: '',
        assistantOutput: '',
      },
      members: [
        {
          name: 'team-lead',
          agentType: 'team-lead',
          providerId: 'anthropic',
          status: 'active',
          currentTaskId: null,
          taskCount: 0,
          lastActiveAt: null,
          messageCount: 0,
        },
        {
          name: 'tom',
          providerId: 'anthropic',
          laneKind: 'primary',
          status: 'active',
          currentTaskId: null,
          taskCount: 0,
          lastActiveAt: null,
          messageCount: 0,
        },
      ],
      memberSpawnStatuses: {
        tom: {
          status: 'error',
          launchState: 'failed_to_start',
          runtimeAlive: false,
          bootstrapConfirmed: true,
          hardFailure: true,
          hardFailureReason: 'CLI process exited (code 1) \u2014 team provisioned but not alive',
          livenessKind: 'confirmed_bootstrap',
          runtimeDiagnostic:
            'runtime pid could not be verified because process table is unavailable',
          runtimeDiagnosticSeverity: 'warning',
          updatedAt: '2026-05-25T20:14:02.147Z',
        },
      },
      memberRuntimeEntries: {
        tom: {
          memberName: 'tom',
          alive: false,
          restartable: true,
          livenessKind: 'confirmed_bootstrap',
          runtimeDiagnostic:
            'runtime pid could not be verified because process table is unavailable',
          runtimeDiagnosticSeverity: 'warning',
          updatedAt: '2026-05-25T20:14:03.317Z',
        },
      },
    });

    expect(presentation?.isFailed).toBe(false);
    expect(presentation?.failedSpawnCount).toBe(0);
    expect(presentation?.heartbeatConfirmedCount).toBe(1);
    expect(presentation?.panelTone).not.toBe('error');
    expect(presentation?.compactTone).not.toBe('error');
  });

  it('presents unsafe bootstrap-confirmed provisioned-but-not-alive entries as failed', () => {
    const presentation = buildTeamProvisioningPresentation({
      progress: {
        runId: 'run-signal-ops',
        teamName: 'signal-ops',
        state: 'ready',
        startedAt: '2026-05-25T20:13:40.000Z',
        updatedAt: '2026-05-25T20:14:05.411Z',
        message: 'Team provisioned',
        messageSeverity: undefined,
        pid: 27036,
        cliLogsTail: '',
        assistantOutput: '',
      },
      members: [
        {
          name: 'tom',
          providerId: 'anthropic',
          laneKind: 'primary',
          status: 'active',
          currentTaskId: null,
          taskCount: 0,
          lastActiveAt: null,
          messageCount: 0,
        },
      ],
      memberSpawnStatuses: {
        tom: {
          status: 'error',
          launchState: 'failed_to_start',
          runtimeAlive: false,
          bootstrapConfirmed: true,
          hardFailure: true,
          hardFailureReason: 'CLI process exited (code 1) - team provisioned but not alive',
          livenessKind: 'not_found',
          runtimeDiagnostic: 'Runtime is no longer registered',
          runtimeDiagnosticSeverity: 'warning',
          updatedAt: '2026-05-25T20:14:02.147Z',
        },
      },
    });

    expect(presentation?.isFailed).toBe(false);
    expect(presentation?.failedSpawnCount).toBe(1);
    expect(presentation?.heartbeatConfirmedCount).toBe(0);
    expect(presentation?.successMessageSeverity).toBe('warning');
    expect(presentation?.compactTone).toBe('warning');
  });

  it('does not show core team ready while a primary member is still joining', () => {
    const presentation = buildTeamProvisioningPresentation({
      progress: {
        runId: 'run-primary-still-starting',
        teamName: 'mixed-team',
        state: 'ready',
        startedAt: '2026-04-13T10:00:00.000Z',
        updatedAt: '2026-04-13T10:00:08.000Z',
        message: 'Team provisioned - waiting for members',
        messageSeverity: undefined,
        pid: 4321,
        cliLogsTail: '',
        assistantOutput: '',
      },
      members: [
        {
          name: 'team-lead',
          agentType: 'team-lead',
          providerId: 'codex',
          status: 'active',
          currentTaskId: null,
          taskCount: 0,
          lastActiveAt: null,
          messageCount: 0,
        },
        {
          name: 'alice',
          providerId: 'codex',
          laneKind: 'primary',
          status: 'unknown',
          currentTaskId: null,
          taskCount: 0,
          lastActiveAt: null,
          messageCount: 0,
        },
        {
          name: 'tom',
          providerId: 'opencode',
          laneId: 'secondary:opencode:tom',
          laneKind: 'secondary',
          laneOwnerProviderId: 'opencode',
          status: 'unknown',
          currentTaskId: null,
          taskCount: 0,
          lastActiveAt: null,
          messageCount: 0,
        },
      ],
      memberSpawnStatuses: {
        alice: {
          status: 'waiting',
          launchState: 'starting',
          updatedAt: '2026-04-13T10:00:05.000Z',
          runtimeAlive: false,
          bootstrapConfirmed: false,
          hardFailure: false,
          agentToolAccepted: true,
        },
        tom: {
          status: 'online',
          launchState: 'runtime_pending_bootstrap',
          updatedAt: '2026-04-13T10:00:07.000Z',
          runtimeAlive: true,
          livenessSource: 'process',
          livenessKind: 'runtime_process_candidate',
          bootstrapConfirmed: false,
          hardFailure: false,
          agentToolAccepted: true,
        },
      },
      memberSpawnSnapshot: {
        expectedMembers: ['alice', 'tom'],
        summary: {
          confirmedCount: 0,
          pendingCount: 2,
          failedCount: 0,
          runtimeAlivePendingCount: 0,
          runtimeCandidatePendingCount: 1,
        },
      },
    });

    expect(presentation?.successMessage).toBe('Finishing launch');
    expect(presentation?.panelMessage).not.toBe('Waiting for OpenCode: tom');
    expect(presentation?.compactTitle).toBe('Finishing launch');
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
    expect(presentation?.compactDetail).toBe('Waiting for runtime: alice, bob');
    expect(presentation?.panelMessage).toBe('Waiting for runtime: alice, bob');
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

    expect(presentation?.panelMessage).toBe('jack failed to start');
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

  it('keeps ready launch in finishing state when runtime snapshot contradicts confirmed spawn', () => {
    const presentation = buildTeamProvisioningPresentation({
      progress: {
        runId: 'run-5b',
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
      memberRuntimeEntries: {
        bob: {
          memberName: 'bob',
          alive: false,
          restartable: true,
          livenessKind: 'registered_only',
          runtimeDiagnostic: 'registered runtime metadata without live process',
          updatedAt: '2026-04-13T10:00:08.000Z',
        },
      },
    });

    expect(presentation?.compactTitle).toBe('Finishing launch');
    expect(presentation?.compactDetail).toBe('1 teammate still joining');
    expect(presentation?.successMessage).toBe('Finishing launch');
    expect(presentation?.currentStepIndex).toBe(2);
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
