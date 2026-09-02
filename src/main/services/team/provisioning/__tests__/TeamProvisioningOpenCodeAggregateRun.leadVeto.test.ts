import { describe, expect, it, vi } from 'vitest';

import {
  type OpenCodeWorktreeRootAggregateLaunchPorts,
  runOpenCodeWorktreeRootAggregateLaunch,
} from '../TeamProvisioningOpenCodeAggregateRun';

import {
  buildFailedOpenCodeLaunchResult,
  buildRetainableOpenCodeLaunchResult,
  buildUncommittedPrimaryLeadLaunchResult,
} from './support/openCodeUncommittedPrimaryLane';

import type { TeamLaunchRuntimeAdapter } from '../../runtime';
import type { OpenCodeAggregateProvisioningRun } from '../TeamProvisioningOpenCodeAggregateRun';
import type { TeamRuntimeLanePlan } from '@features/team-runtime-lanes';
import type { TeamCreateRequest, TeamProvisioningProgress } from '@shared/types';

type OpenCodeMemberLanePlan = Extract<TeamRuntimeLanePlan, { mode: 'pure_opencode_member_lanes' }>;
type OpenCodeMember = OpenCodeMemberLanePlan['allMembers'][number];

const PROJECT_CWD = '/fake/project';
const TEAMS_BASE_PATH = '/safe-test/teams';

function member(name: string, extra: Partial<OpenCodeMember> = {}): OpenCodeMember {
  return { name, role: 'Engineer', providerId: 'opencode', cwd: PROJECT_CWD, ...extra };
}

const lead = member('team-lead', { role: 'Team Lead' });
const ada = member('Ada');
const ben = member('Ben');

function request(): TeamCreateRequest {
  return {
    teamName: 'lane-team',
    cwd: PROJECT_CWD,
    providerId: 'opencode',
    members: [lead, ada, ben],
  } as TeamCreateRequest;
}

function lanePlan(): OpenCodeMemberLanePlan {
  return {
    mode: 'pure_opencode_member_lanes',
    primaryMembers: [lead],
    sideLanes: [
      { laneId: 'secondary:opencode:ada', member: ada, providerId: 'opencode' },
      { laneId: 'secondary:opencode:ben', member: ben, providerId: 'opencode' },
    ],
    allMembers: [lead, ada, ben],
  } as unknown as OpenCodeMemberLanePlan;
}

function basePorts(
  calls: string[],
  progressLog: TeamProvisioningProgress[]
): OpenCodeWorktreeRootAggregateLaunchPorts {
  const runs = new Map<string, OpenCodeAggregateProvisioningRun>();
  const provisioningRuns = new Map<string, string>();
  const ports: Partial<OpenCodeWorktreeRootAggregateLaunchPorts> = {
    randomUUID: () => 'run-a1',
    nowMs: () => 0,
    nowIso: () => '2026-08-28T12:20:00.000Z',
    getStopAllTeamsGeneration: () => 0,
    getStopTeamGeneration: () => 0,
    getRuntimeAdapterRun: () => undefined,
    stopOpenCodeRuntimeAdapterTeam: async () => {
      calls.push('stopPrimary');
    },
    hasSecondaryRuntimeRuns: () => true,
    stopMixedSecondaryRuntimeLanes: async () => {
      calls.push('stopSecondaryLanes');
    },
    getProvisioningRun: (teamName) => provisioningRuns.get(teamName),
    getRuntimeAdapterProgress: () => undefined,
    isCancellableRuntimeAdapterProgress: () => false,
    cancelRuntimeAdapterProvisioning: async () => undefined,
    recordCancelledOpenCodeRuntimeAdapterLaunch: () => {
      calls.push('recordCancelledLaunch');
      return { runId: 'cancelled-run' };
    },
    setProvisioningRun: (teamName, runId) => {
      provisioningRuns.set(teamName, runId);
    },
    getRun: (runId) => runs.get(runId),
    setRuntimeAdapterProgress: (progress) => {
      progressLog.push(progress);
      calls.push(`setProgress:${progress.state}`);
      return progress;
    },
    resetTeamScopedTransientStateForNewRun: () => undefined,
    readLaunchState: async () => null,
    clearPersistedLaunchState: async () => undefined,
    setRun: (runId, run) => {
      runs.set(runId, run);
    },
    invalidateRuntimeSnapshotCaches: () => undefined,
    launchOpenCodeAggregatePrimaryLane: async () => buildUncommittedPrimaryLeadLaunchResult(),
    launchSingleMixedSecondaryLane: async (_run, lane) => {
      lane.state = 'finished';
      lane.result = buildRetainableOpenCodeLaunchResult(lane.member.name);
    },
    publishMixedSecondaryLaneStatusChange: async () => undefined,
    getOpenCodeRuntimeLaunchCwd: (baseCwd) => baseCwd,
    getSecondaryRuntimeRun: () => undefined,
    summarizeOpenCodeAggregateLaunchState: () => 'clean_success',
    persistLaunchStateSnapshot: async (_run, launchPhase) => {
      calls.push(`persistLaunchState:${launchPhase}`);
      return null;
    },
    syncRunMemberSpawnStatusesFromSnapshot: () => undefined,
    setAliveRunId: () => {
      calls.push('setAliveRun');
    },
    setRuntimeAdapterRun: () => undefined,
    deleteAliveRunId: () => undefined,
    deleteRuntimeAdapterRun: () => undefined,
    cleanupRun: () => undefined,
    deleteProvisioningRunIfCurrent: () => undefined,
    emitTeamProcessChange: () => undefined,
    consumeCancelledRuntimeAdapterRunId: () => false,
    getTeamsBasePath: () => TEAMS_BASE_PATH,
    clearOpenCodeRuntimeLaneStorage: async () => true,
    setSecondaryRuntimeRun: () => undefined,
    deleteSecondaryRuntimeRun: () => undefined,
    deliverOpenCodeLaunchPromptToLead: async () => {
      calls.push('deliverLaunchPrompt');
    },
  };
  return ports as OpenCodeWorktreeRootAggregateLaunchPorts;
}

async function runLaunch(
  overrides: Partial<OpenCodeWorktreeRootAggregateLaunchPorts>
): Promise<{ calls: string[]; progressLog: TeamProvisioningProgress[]; reports: string[] }> {
  const calls: string[] = [];
  const progressLog: TeamProvisioningProgress[] = [];
  const reports: string[] = [];
  await runOpenCodeWorktreeRootAggregateLaunch(
    {
      adapter: {} as TeamLaunchRuntimeAdapter,
      request: request(),
      members: [lead, ada, ben],
      lanePlan: lanePlan(),
      prompt: 'Summarize the repo',
      onProgress: vi.fn(),
    },
    {
      ...basePorts(calls, progressLog),
      logDiagnostic: (message) => reports.push(message),
      ...overrides,
    }
  );
  return { calls, progressLog, reports };
}

describe('OpenCode aggregate launch treats the lead as a veto', () => {
  // NEGATIVE CONTROL, first on purpose: the veto is not a blanket fail. A
  // confirmed lead beside two FAILED side lanes must still promote the team.
  it('keeps a confirmed lead with two failed side lanes a partial success', async () => {
    const { calls, progressLog } = await runLaunch({
      hasCommittedOpenCodePrimaryLeadSessionEvidence: async () => true,
      summarizeOpenCodeAggregateLaunchState: () => 'partial_failure',
      launchSingleMixedSecondaryLane: async (_run, lane) => {
        lane.state = 'finished';
        lane.result = buildFailedOpenCodeLaunchResult(lane.member.name, 'runtime never answered');
      },
    });

    expect(progressLog.at(-1)?.state).toBe('ready');
    expect(progressLog.at(-1)?.message).toBe('OpenCode team is running with unavailable members');
    expect(progressLog.at(-1)?.configReady).toBe(true);
    expect(calls).toContain('setAliveRun');
    expect(calls).toContain('deliverLaunchPrompt');
    // No terminal rollback was taken: no failed progress was ever published.
    expect(progressLog.some((entry) => entry.state === 'failed')).toBe(false);
  });

  it('fails the launch when the lead has no committed session, even with two healthy side lanes', async () => {
    const { calls, progressLog } = await runLaunch({
      hasCommittedOpenCodePrimaryLeadSessionEvidence: async () => false,
    });

    const finalProgress = progressLog.at(-1)!;
    expect(finalProgress.state).toBe('failed');
    expect(finalProgress.configReady).toBe(false);
    expect(finalProgress.error).toContain('team-lead');
    expect(calls).not.toContain('setAliveRun');
    expect(calls).not.toContain('deliverLaunchPrompt');
    expect(calls).toContain('stopSecondaryLanes');
  });

  it('keeps the run active and still queues the prompt while the lead is pending', async () => {
    const pendingLead = buildUncommittedPrimaryLeadLaunchResult();
    pendingLead.members['team-lead'] = {
      ...pendingLead.members['team-lead'],
      launchState: 'runtime_pending_bootstrap',
      bootstrapConfirmed: false,
      runtimeAlive: false,
      runtimePid: 4321,
    };

    const { calls, progressLog } = await runLaunch({
      launchOpenCodeAggregatePrimaryLane: async () => pendingLead,
      hasCommittedOpenCodePrimaryLeadSessionEvidence: async () => false,
    });

    expect(calls).toContain('persistLaunchState:active');
    expect(calls).toContain('setAliveRun');
    // The prompt reaches the inbox EXACTLY ONCE: dropping it here would leave
    // the team idle forever with the user's request gone, on a progress that
    // says ready.
    expect(calls.filter((call) => call === 'deliverLaunchPrompt')).toEqual(['deliverLaunchPrompt']);
    expect(progressLog.at(-1)?.message).toBe(
      'OpenCode lead is waiting for its runtime bootstrap evidence'
    );
  });

  it('queues the prompt exactly once whether the lead commits before or after the branch', async () => {
    const pendingLead = buildUncommittedPrimaryLeadLaunchResult();
    pendingLead.members['team-lead'] = {
      ...pendingLead.members['team-lead'],
      launchState: 'runtime_pending_bootstrap',
      bootstrapConfirmed: false,
      runtimeAlive: false,
      runtimePid: 4321,
    };
    const prompts: { teamName: string; leadName: string; prompt: string }[] = [];
    const collectPrompt = async (input: {
      teamName: string;
      leadName: string;
      prompt: string;
    }): Promise<void> => {
      // Only the identity of the queued prompt is asserted here; the inbox port
      // carries launch-currency plumbing this case says nothing about.
      prompts.push({ teamName: input.teamName, leadName: input.leadName, prompt: input.prompt });
    };

    await runLaunch({
      launchOpenCodeAggregatePrimaryLane: async () => pendingLead,
      hasCommittedOpenCodePrimaryLeadSessionEvidence: async () => false,
      deliverOpenCodeLaunchPromptToLead: collectPrompt,
    });
    await runLaunch({
      hasCommittedOpenCodePrimaryLeadSessionEvidence: async () => true,
      deliverOpenCodeLaunchPromptToLead: collectPrompt,
    });

    expect(prompts).toEqual([
      { teamName: 'lane-team', leadName: 'team-lead', prompt: 'Summarize the repo' },
      { teamName: 'lane-team', leadName: 'team-lead', prompt: 'Summarize the repo' },
    ]);
  });

  // A lead parked on a permission prompt holds no pid and no session id, but the
  // user answering the prompt is what unblocks it: vetoing it would tear the
  // whole team down while the dialog is still on screen.
  it('waits for a permission-blocked lead instead of tearing the team down', async () => {
    const permissionBlockedLead = buildUncommittedPrimaryLeadLaunchResult();
    permissionBlockedLead.members['team-lead'] = {
      ...permissionBlockedLead.members['team-lead'],
      launchState: 'runtime_pending_permission',
      bootstrapConfirmed: false,
      runtimeAlive: false,
      livenessKind: 'permission_blocked',
      pendingPermissionRequestIds: ['perm-1'],
    };

    const { calls, progressLog } = await runLaunch({
      launchOpenCodeAggregatePrimaryLane: async () => permissionBlockedLead,
      hasCommittedOpenCodePrimaryLeadSessionEvidence: async () => false,
    });

    expect(progressLog.at(-1)?.state).toBe('ready');
    expect(progressLog.at(-1)?.configReady).toBe(true);
    expect(calls).toContain('persistLaunchState:active');
    expect(calls).toContain('setAliveRun');
    expect(calls).toContain('deliverLaunchPrompt');
  });

  it('promotes and delivers normally once the lead session is committed', async () => {
    const { calls, progressLog } = await runLaunch({
      hasCommittedOpenCodePrimaryLeadSessionEvidence: async () => true,
    });

    expect(progressLog.at(-1)?.state).toBe('ready');
    expect(progressLog.at(-1)?.configReady).toBe(true);
    expect(calls).toContain('setAliveRun');
    expect(calls).toContain('deliverLaunchPrompt');
  });

  // NEGATIVE CONTROL: with no committed-session reader wired the launch must
  // behave exactly as it did before this change.
  it('leaves a launch with no committed-session reader completely unchanged', async () => {
    const { calls, progressLog } = await runLaunch({});

    expect(progressLog.at(-1)?.state).toBe('ready');
    expect(progressLog.at(-1)?.message).toBe('OpenCode member lanes are ready');
    expect(calls).toContain('setAliveRun');
    expect(calls).toContain('deliverLaunchPrompt');
  });
});

describe('a blocked primary lane reports why, without changing the launch', () => {
  const pendingLeadResult = (): ReturnType<typeof buildUncommittedPrimaryLeadLaunchResult> => {
    const result = buildUncommittedPrimaryLeadLaunchResult();
    result.members['team-lead'] = {
      ...result.members['team-lead'],
      launchState: 'runtime_pending_bootstrap',
      bootstrapConfirmed: false,
      runtimeAlive: false,
      runtimePid: 4321,
    };
    return result;
  };

  // NEGATIVE CONTROL: a team that is not blocked produces ZERO reports.
  it('emits no report at all for a healthy launch', async () => {
    const { reports, calls, progressLog } = await runLaunch({
      hasCommittedOpenCodePrimaryLeadSessionEvidence: async () => true,
    });

    expect(reports).toEqual([]);
    expect(progressLog.at(-1)?.cliLogsTail).toBeUndefined();
    expect(calls).toContain('deliverLaunchPrompt');
  });

  // NEGATIVE CONTROL: the reports are pure observation. The same launch, run
  // once with a sink and once with none, produces the identical outcome.
  it('produces the same launch outcome with and without a report sink', async () => {
    const withSink = await runLaunch({
      launchOpenCodeAggregatePrimaryLane: async () => pendingLeadResult(),
      hasCommittedOpenCodePrimaryLeadSessionEvidence: async () => false,
    });
    const withoutSink = await runLaunch({
      launchOpenCodeAggregatePrimaryLane: async () => pendingLeadResult(),
      hasCommittedOpenCodePrimaryLeadSessionEvidence: async () => false,
      logDiagnostic: undefined,
    });

    expect(withSink.reports.length).toBeGreaterThan(0);
    expect(withoutSink.calls).toEqual(withSink.calls);
    // Identical down to the progress tail: the sink is a durable side channel,
    // never a second source of truth.
    expect(withoutSink.progressLog).toEqual(withSink.progressLog);
  });

  it('names the deferred dispatch while the lead bootstrap is pending', async () => {
    const { reports, progressLog, calls } = await runLaunch({
      launchOpenCodeAggregatePrimaryLane: async () => pendingLeadResult(),
      hasCommittedOpenCodePrimaryLeadSessionEvidence: async () => false,
    });

    expect(reports).toEqual([
      '[lane-team] opencode_launch_prompt_deferred_until_lead_bootstrap lead=team-lead',
    ]);
    // The same text reaches the progress tail the user can already see.
    expect(progressLog.at(-1)?.cliLogsTail).toContain(
      'opencode_launch_prompt_deferred_until_lead_bootstrap'
    );
    expect(calls).toContain('deliverLaunchPrompt');
  });

  // The prompt guard is a SECOND gate, on a different question: the veto asks
  // whether the lead's session is committed, this asks whether the lane holds
  // any runtime evidence for it at all. A lead that claims `confirmed_alive`
  // with a committed record but no handle passes the veto and fails this one.
  it('refuses to burn the prompt on a lead the lane holds no runtime evidence for', async () => {
    const noEvidenceLead = buildUncommittedPrimaryLeadLaunchResult();
    noEvidenceLead.members['team-lead'] = {
      ...noEvidenceLead.members['team-lead'],
      bootstrapConfirmed: false,
      runtimeAlive: false,
      agentToolAccepted: false,
      runtimeDiagnostic: 'primary lane reported no runtime handle',
    };

    const { reports, calls, progressLog } = await runLaunch({
      launchOpenCodeAggregatePrimaryLane: async () => noEvidenceLead,
      hasCommittedOpenCodePrimaryLeadSessionEvidence: async () => true,
    });

    expect(calls).not.toContain('deliverLaunchPrompt');
    expect(reports).toEqual([
      '[lane-team] opencode_launch_prompt_lead_unavailable lead=team-lead ' +
        'reason=primary lane reported no runtime handle',
    ]);
    // The launch outcome is untouched: the lanes are still promoted.
    expect(progressLog.at(-1)?.state).toBe('ready');
    expect(calls).toContain('setAliveRun');
  });
});
