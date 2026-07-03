import { describe, expect, it, vi } from 'vitest';

import {
  buildOpenCodeSecondaryBootstrapStallDiagnostic,
  isOpenCodeBootstrapStallWindowElapsed,
  markOpenCodeSecondaryBootstrapStalled,
  OPENCODE_APP_MANAGED_BOOTSTRAP_STALLED_DIAGNOSTIC,
  OPENCODE_LEGACY_BOOTSTRAP_STALLED_DIAGNOSTIC,
  OPENCODE_MEMBER_BRIEFING_WITHOUT_CHECKIN_DIAGNOSTIC,
  type OpenCodeBootstrapStallLaneLike,
  type OpenCodeBootstrapStallRunLike,
  planOpenCodeSecondaryBootstrapCheckinRetryPrompt,
  reconcileOpenCodeRuntimeProcessBootstrapStatus,
  scheduleOpenCodeBootstrapStallReevaluation,
} from '../TeamProvisioningOpenCodeBootstrapStall';
import { MEMBER_BOOTSTRAP_STALL_MS } from '../TeamProvisioningOpenCodeRuntimeEvidencePolicy';

import type { MemberSpawnStatusEntry } from '@shared/types';

const ISO = '2026-01-01T00:00:00.000Z';

function status(overrides: Partial<MemberSpawnStatusEntry> = {}): MemberSpawnStatusEntry {
  return {
    status: 'waiting',
    launchState: 'runtime_pending_bootstrap',
    updatedAt: ISO,
    ...overrides,
  };
}

function opencodeLane(
  overrides: Partial<OpenCodeBootstrapStallLaneLike> = {}
): OpenCodeBootstrapStallLaneLike {
  return {
    providerId: 'opencode',
    laneId: 'lane-worker',
    runId: 'runtime-run-1',
    diagnostics: [],
    member: { name: 'Worker', cwd: '/tmp/project' },
    result: {
      runId: 'runtime-run-1',
      teamName: 'Team',
      launchPhase: 'finished',
      teamLaunchState: 'partial_failure',
      members: {
        Worker: {
          memberName: 'Worker',
          providerId: 'opencode',
          launchState: 'runtime_pending_bootstrap',
          agentToolAccepted: true,
          runtimeAlive: true,
          bootstrapConfirmed: false,
          hardFailure: false,
          sessionId: 'session-1',
          bootstrapMode: 'model_tool_checkin',
          diagnostics: [],
        },
      },
      warnings: [],
      diagnostics: [],
    },
    ...overrides,
  };
}

function appManagedOpenCodeLane(): OpenCodeBootstrapStallLaneLike {
  const lane = opencodeLane();
  const result = lane.result;
  if (!result) {
    throw new Error('Expected OpenCode lane fixture to include a launch result.');
  }
  const worker = result.members.Worker;
  if (!worker) {
    throw new Error('Expected OpenCode lane fixture to include Worker evidence.');
  }

  return opencodeLane({
    result: {
      ...result,
      members: {
        Worker: {
          ...worker,
          bootstrapMode: 'app_managed_context',
        },
      },
    },
  });
}

function bootstrapRun(): OpenCodeBootstrapStallRunLike {
  return {
    runId: 'run-1',
    teamName: 'Team',
    request: { cwd: '/tmp/project' },
    provisioningOutputParts: [],
    memberSpawnStatuses: new Map(),
    progress: {} as never,
    onProgress: vi.fn(),
    isLaunch: true,
    provisioningComplete: false,
  };
}

describe('OpenCode bootstrap stall helpers', () => {
  it('selects app-managed diagnostics without transcript lookup', async () => {
    const findBootstrapTranscriptOutcome = vi.fn();
    const diagnostic = await buildOpenCodeSecondaryBootstrapStallDiagnostic(
      {
        run: {
          teamName: 'Team',
          mixedSecondaryLanes: [appManagedOpenCodeLane()],
        },
        memberName: 'Worker',
        current: status(),
      },
      { findBootstrapTranscriptOutcome }
    );

    expect(diagnostic).toBe(OPENCODE_APP_MANAGED_BOOTSTRAP_STALLED_DIAGNOSTIC);
    expect(findBootstrapTranscriptOutcome).not.toHaveBeenCalled();
  });

  it('falls back to transcript-aware legacy diagnostics', async () => {
    const findBootstrapTranscriptOutcome = vi.fn().mockResolvedValue({
      kind: 'success',
      source: 'member_briefing',
    });
    const firstSpawnAcceptedAt = '2026-01-01T00:05:00.000Z';
    const diagnostic = await buildOpenCodeSecondaryBootstrapStallDiagnostic(
      {
        run: { teamName: 'Team', mixedSecondaryLanes: [opencodeLane()] },
        memberName: 'Worker',
        current: status({ firstSpawnAcceptedAt }),
      },
      { findBootstrapTranscriptOutcome }
    );

    expect(diagnostic).toBe(OPENCODE_MEMBER_BRIEFING_WITHOUT_CHECKIN_DIAGNOSTIC);
    expect(findBootstrapTranscriptOutcome).toHaveBeenCalledWith(
      'Team',
      'Worker',
      Date.parse(firstSpawnAcceptedAt)
    );
  });

  it('plans one legacy check-in retry and suppresses duplicates or app-managed lanes', () => {
    const run = {
      mixedSecondaryLanes: [opencodeLane()],
      provisioningOutputParts: [],
    };

    const plan = planOpenCodeSecondaryBootstrapCheckinRetryPrompt({
      run,
      memberName: 'Worker',
      current: status(),
      runtimeDiagnostic: OPENCODE_LEGACY_BOOTSTRAP_STALLED_DIAGNOSTIC,
      isCurrentTrackedRun: true,
    });

    expect(plan.shouldSend).toBe(true);
    expect(plan).toMatchObject({
      laneRunId: 'runtime-run-1',
      runtimeSessionId: 'session-1',
      marker: 'opencode_bootstrap_checkin_retry_prompt_sent:runtime-run-1:session-1',
    });

    const duplicatePlan = planOpenCodeSecondaryBootstrapCheckinRetryPrompt({
      run: {
        ...run,
        provisioningOutputParts: [
          'opencode_bootstrap_checkin_retry_prompt_sent:runtime-run-1:session-1',
        ],
      },
      memberName: 'Worker',
      current: status(),
      runtimeDiagnostic: OPENCODE_LEGACY_BOOTSTRAP_STALLED_DIAGNOSTIC,
      isCurrentTrackedRun: true,
    });
    expect(duplicatePlan).toEqual({ shouldSend: false, reason: 'already_sent' });

    const appManagedPlan = planOpenCodeSecondaryBootstrapCheckinRetryPrompt({
      run: {
        mixedSecondaryLanes: [appManagedOpenCodeLane()],
        provisioningOutputParts: [],
      },
      memberName: 'Worker',
      current: status(),
      runtimeDiagnostic: OPENCODE_APP_MANAGED_BOOTSTRAP_STALLED_DIAGNOSTIC,
      isCurrentTrackedRun: true,
    });
    expect(appManagedPlan).toEqual({ shouldSend: false, reason: 'app_managed_bootstrap' });
  });

  it('reconciles runtime-process bootstrap pending status and schedules reevaluation', async () => {
    const buildDiagnostic = vi.fn();
    const setPendingStatus = vi.fn();
    const sendRetryPrompt = vi.fn();
    const scheduleReevaluation = vi.fn();
    const firstSpawnAcceptedAt = '2026-01-01T00:00:00.000Z';
    const current = status({ firstSpawnAcceptedAt });
    const run = bootstrapRun();

    await reconcileOpenCodeRuntimeProcessBootstrapStatus(
      {
        run,
        memberName: 'Worker',
        current,
        bootstrapStalled: false,
        runtimeDiagnostic: 'OpenCode runtime process is alive',
        runtimeDiagnosticSeverity: 'info',
        firstSpawnAcceptedAt,
        scheduleReevaluation: true,
      },
      {
        buildOpenCodeSecondaryBootstrapStallDiagnostic: buildDiagnostic,
        setOpenCodeRuntimePendingBootstrapStatus: setPendingStatus,
        maybeSendOpenCodeSecondaryBootstrapCheckinRetryPrompt: sendRetryPrompt,
        scheduleOpenCodeBootstrapStallReevaluation: scheduleReevaluation,
      }
    );

    expect(buildDiagnostic).not.toHaveBeenCalled();
    expect(setPendingStatus).toHaveBeenCalledWith(run, 'Worker', current, {
      bootstrapStalled: false,
      runtimeDiagnostic: 'OpenCode runtime process is alive',
      runtimeDiagnosticSeverity: 'info',
    });
    expect(sendRetryPrompt).not.toHaveBeenCalled();
    expect(scheduleReevaluation).toHaveBeenCalledWith(run, 'Worker', firstSpawnAcceptedAt);
  });

  it('reconciles stalled runtime-process bootstrap status with retry prompt diagnostics', async () => {
    const current = status({ firstSpawnAcceptedAt: '2026-01-01T00:00:00.000Z' });
    const run = bootstrapRun();
    const buildDiagnostic = vi.fn().mockResolvedValue(OPENCODE_LEGACY_BOOTSTRAP_STALLED_DIAGNOSTIC);
    const setPendingStatus = vi.fn();
    const sendRetryPrompt = vi.fn();
    const scheduleReevaluation = vi.fn();

    await reconcileOpenCodeRuntimeProcessBootstrapStatus(
      {
        run,
        memberName: 'Worker',
        current,
        bootstrapStalled: true,
        runtimeSessionId: 'session-1',
        scheduleReevaluation: true,
      },
      {
        buildOpenCodeSecondaryBootstrapStallDiagnostic: buildDiagnostic,
        setOpenCodeRuntimePendingBootstrapStatus: setPendingStatus,
        maybeSendOpenCodeSecondaryBootstrapCheckinRetryPrompt: sendRetryPrompt,
        scheduleOpenCodeBootstrapStallReevaluation: scheduleReevaluation,
      }
    );

    expect(setPendingStatus).toHaveBeenCalledWith(run, 'Worker', current, {
      bootstrapStalled: true,
      runtimeDiagnostic: 'Runtime process is alive, but no bootstrap check-in after 5 min.',
      runtimeDiagnosticSeverity: 'warning',
    });
    expect(sendRetryPrompt).toHaveBeenCalledWith({
      run,
      memberName: 'Worker',
      current,
      runtimeDiagnostic: 'Runtime process is alive, but no bootstrap check-in after 5 min.',
      runtimeSessionId: 'session-1',
    });
    expect(scheduleReevaluation).not.toHaveBeenCalled();
  });

  it('marks elapsed secondary bootstrap as stalled with runtime metadata enrichment', async () => {
    const current = status({
      firstSpawnAcceptedAt: '2026-01-01T00:00:00.000Z',
      runtimeDiagnostic: 'previous diagnostic',
    });
    const run = bootstrapRun();
    const buildDiagnostic = vi.fn().mockResolvedValue('diagnostic from transcript');
    const setStalledStatus = vi.fn();
    const sendRetryPrompt = vi.fn();

    await expect(
      markOpenCodeSecondaryBootstrapStalled(
        {
          run,
          memberName: 'Worker',
          current,
          isOpenCodeSecondaryLaneMember: true,
          bootstrapStallWindowElapsed: true,
          runtimeMetadata: {
            livenessKind: 'runtime_process_candidate',
            runtimeDiagnostic: 'candidate diagnostic',
            runtimeDiagnosticSeverity: 'warning',
            runtimeSessionId: 'session-1',
          },
        },
        {
          buildOpenCodeSecondaryBootstrapStallDiagnostic: buildDiagnostic,
          setOpenCodeSecondaryBootstrapStalledStatus: setStalledStatus,
          maybeSendOpenCodeSecondaryBootstrapCheckinRetryPrompt: sendRetryPrompt,
        }
      )
    ).resolves.toBe(true);

    const enriched = {
      ...current,
      livenessKind: 'runtime_process_candidate',
      runtimeDiagnostic: 'candidate diagnostic',
      runtimeDiagnosticSeverity: 'warning',
    };
    expect(buildDiagnostic).toHaveBeenCalledWith(run, 'Worker', enriched);
    expect(setStalledStatus).toHaveBeenCalledWith(
      run,
      'Worker',
      enriched,
      'diagnostic from transcript'
    );
    expect(sendRetryPrompt).toHaveBeenCalledWith({
      run,
      memberName: 'Worker',
      current: enriched,
      runtimeDiagnostic: 'diagnostic from transcript',
      runtimeSessionId: 'session-1',
    });
  });

  it('calculates stall windows and schedules one reevaluation timer', () => {
    const nowMs = Date.parse('2026-01-01T00:05:00.000Z');
    const acceptedAt = new Date(nowMs - MEMBER_BOOTSTRAP_STALL_MS + 2_500).toISOString();
    const timers = new Map<string, NodeJS.Timeout>();
    const setTimeoutPort = vi.fn((callback: () => void, delayMs: number) => {
      expect(callback).toEqual(expect.any(Function));
      expect(delayMs).toBe(2_500);
      return { unref: vi.fn() } as unknown as NodeJS.Timeout;
    });

    expect(isOpenCodeBootstrapStallWindowElapsed(acceptedAt, nowMs)).toBe(false);
    expect(isOpenCodeBootstrapStallWindowElapsed(acceptedAt, nowMs + 2_500)).toBe(true);

    scheduleOpenCodeBootstrapStallReevaluation(bootstrapRun(), 'Worker', acceptedAt, {
      nowMs: () => nowMs,
      getMemberLaunchGraceKey: () => 'Team:Worker',
      hasPendingTimeout: (key) => timers.has(key),
      setPendingTimeout: (key, timer) => timers.set(key, timer),
      deletePendingTimeout: (key) => timers.delete(key),
      setTimeout: setTimeoutPort,
      reevaluateMemberLaunchStatus: vi.fn(),
    });
    scheduleOpenCodeBootstrapStallReevaluation(bootstrapRun(), 'Worker', acceptedAt, {
      nowMs: () => nowMs,
      getMemberLaunchGraceKey: () => 'Team:Worker',
      hasPendingTimeout: (key) => timers.has(key),
      setPendingTimeout: (key, timer) => timers.set(key, timer),
      deletePendingTimeout: (key) => timers.delete(key),
      setTimeout: setTimeoutPort,
      reevaluateMemberLaunchStatus: vi.fn(),
    });

    expect(setTimeoutPort).toHaveBeenCalledTimes(1);
    expect(timers.has('Team:Worker:bootstrap-stall')).toBe(true);
  });
});
