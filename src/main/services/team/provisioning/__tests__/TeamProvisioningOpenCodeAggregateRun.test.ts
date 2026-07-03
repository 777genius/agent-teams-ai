import { describe, expect, it, vi } from 'vitest';

import { createOpenCodeAggregateProvisioningRun } from '../TeamProvisioningOpenCodeAggregateRun';

import type { TeamRuntimeLanePlan } from '@features/team-runtime-lanes';
import type { TeamCreateRequest, TeamProvisioningProgress } from '@shared/types';

type OpenCodeWorktreeLanePlan = Extract<
  TeamRuntimeLanePlan,
  { mode: 'pure_opencode_worktree_root_lanes' }
>;
type OpenCodeWorktreeMember = OpenCodeWorktreeLanePlan['allMembers'][number];

function member(
  name: string,
  extra: Partial<OpenCodeWorktreeMember> = {}
): OpenCodeWorktreeMember {
  return {
    name,
    role: 'Engineer',
    providerId: 'opencode',
    ...extra,
  } as OpenCodeWorktreeMember;
}

function progress(): TeamProvisioningProgress {
  return {
    runId: 'run-open-code',
    teamName: 'open-code-team',
    state: 'spawning',
    message: 'Launching',
    startedAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:01.000Z',
  };
}

describe('TeamProvisioningOpenCodeAggregateRun', () => {
  it('builds the OpenCode aggregate provisioning run defaults without launching runtime work', () => {
    const alice = member('alice', { cwd: '/fake/project' });
    const bob = member('bob', { cwd: '/fake/project/bob' });
    const request = {
      teamName: 'open-code-team',
      cwd: '/fake/project',
      providerId: 'opencode',
      members: [alice],
      description: 'fake launch request',
    } as unknown as TeamCreateRequest;
    const lanePlan: OpenCodeWorktreeLanePlan = {
      mode: 'pure_opencode_worktree_root_lanes',
      primaryMembers: [alice],
      allMembers: [alice, bob],
      sideLanes: [{ laneId: 'secondary:opencode:bob', providerId: 'opencode', member: bob }],
    };
    const onProgress = vi.fn();
    const runProgress = progress();

    const run = createOpenCodeAggregateProvisioningRun({
      runId: 'run-open-code',
      startedAt: '2026-01-01T00:00:00.000Z',
      progress: runProgress,
      request,
      members: [alice, bob],
      lanePlan,
      onProgress,
    });

    expect(run).toMatchObject({
      runId: 'run-open-code',
      teamName: 'open-code-team',
      startedAt: '2026-01-01T00:00:00.000Z',
      progress: runProgress,
      stdoutBuffer: '',
      stderrBuffer: '',
      claudeLogLines: [],
      lastClaudeLogStream: null,
      stdoutLogLineBuf: '',
      stderrLogLineBuf: '',
      stdoutParserCarry: '',
      stdoutParserCarryIsCompleteJson: false,
      stdoutParserCarryLooksLikeClaudeJson: false,
      deterministicBootstrapMemberSpawnSeen: false,
      deterministicBootstrapMemberResultSeen: false,
      processKilled: false,
      finalizingByTimeout: false,
      cancelRequested: false,
      child: null,
      timeoutHandle: null,
      fsMonitorHandle: null,
      expectedMembers: ['alice', 'bob'],
      allEffectiveMembers: [alice, bob],
      effectiveMembers: [alice],
      launchIdentity: null,
      lastLogProgressAt: 0,
      lastDataReceivedAt: 0,
      lastStdoutReceivedAt: 0,
      stallCheckHandle: null,
      stallWarningIndex: null,
      preStallMessage: null,
      lastRetryAt: 0,
      apiRetryWarningIndex: null,
      apiErrorWarningEmitted: false,
      fsPhase: 'all_files_found',
      waitingTasksSince: null,
      provisioningComplete: false,
      processClosed: false,
      requiresFirstRealTurnSuccess: false,
      firstRealTurnSucceeded: false,
      mcpConfigPath: null,
      memberMcpConfigPaths: [],
      bootstrapSpecPath: null,
      bootstrapUserPromptPath: null,
      isLaunch: true,
      launchStateClearedForRun: false,
      deterministicBootstrap: false,
      workspaceTrustPlan: null,
      workspaceTrustExecution: null,
      workspaceTrustDiagnostics: null,
      workspaceTrustRetryAttempted: false,
      leadRelayCapture: null,
      activeCrossTeamReplyHints: [],
      leadMsgSeq: 0,
      liveLeadTextBuffer: null,
      pendingToolCalls: [],
      pendingDirectCrossTeamSendRefresh: false,
      lastLeadTextEmitMs: 0,
      silentUserDmForward: null,
      silentUserDmForwardClearHandle: null,
      pendingInboxRelayCandidates: [],
      provisioningOutputParts: [],
      provisioningTraceLines: [],
      lastProvisioningTraceKey: null,
      detectedSessionId: null,
      leadActivityState: 'active',
      authFailureRetried: false,
      authRetryInProgress: false,
      leadContextUsage: null,
      spawnContext: null,
      anthropicApiKeyHelper: null,
      pendingPostCompactReminder: false,
      postCompactReminderInFlight: false,
      suppressPostCompactReminderOutput: false,
      pendingGeminiPostLaunchHydration: false,
      geminiPostLaunchHydrationInFlight: false,
      geminiPostLaunchHydrationSent: false,
      suppressGeminiPostLaunchHydrationOutput: false,
      lastDeterministicBootstrapSeq: 0,
      lastMemberSpawnAuditAt: 0,
      lastMemberSpawnAuditConfigReadWarningAt: 0,
    });
    expect(run.request).toEqual({ ...request, members: [alice, bob] });
    expect(run.onProgress).toBe(onProgress);
    expect(run.teamsBasePathsToProbe.length).toBeGreaterThan(0);
    expect(run.mixedSecondaryLanes).toEqual([
      {
        laneId: 'secondary:opencode:bob',
        providerId: 'opencode',
        member: bob,
        runId: null,
        state: 'queued',
        result: null,
        warnings: [],
        diagnostics: [],
      },
    ]);
    expect(run.activeToolCalls).toBeInstanceOf(Map);
    expect(run.provisioningOutputIndexByMessageId).toBeInstanceOf(Map);
    expect(run.pendingApprovals).toBeInstanceOf(Map);
    expect(run.processedPermissionRequestIds).toBeInstanceOf(Set);
    expect(run.memberSpawnStatuses).toBeInstanceOf(Map);
    expect(run.memberSpawnToolUseIds).toBeInstanceOf(Map);
    expect(run.pendingMemberRestarts).toBeInstanceOf(Map);
    expect(run.memberSpawnLeadInboxCursorByMember).toBeInstanceOf(Map);
    expect(run.lastMemberSpawnAuditMissingWarningAt).toBeInstanceOf(Map);
  });
});
