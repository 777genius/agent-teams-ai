import { describe, expect, it, vi } from 'vitest';

import {
  buildOpenCodeSecondaryBootstrapStallDiagnostic,
  isOpenCodeBootstrapStallWindowElapsed,
  OPENCODE_APP_MANAGED_BOOTSTRAP_STALLED_DIAGNOSTIC,
  OPENCODE_LEGACY_BOOTSTRAP_STALLED_DIAGNOSTIC,
  OPENCODE_MEMBER_BRIEFING_WITHOUT_CHECKIN_DIAGNOSTIC,
  planOpenCodeSecondaryBootstrapCheckinRetryPrompt,
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

function opencodeLane(overrides: Record<string, unknown> = {}) {
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

describe('OpenCode bootstrap stall helpers', () => {
  it('selects app-managed diagnostics without transcript lookup', async () => {
    const findBootstrapTranscriptOutcome = vi.fn();
    const diagnostic = await buildOpenCodeSecondaryBootstrapStallDiagnostic(
      {
        run: {
          teamName: 'Team',
          mixedSecondaryLanes: [
            opencodeLane({
              result: {
                ...opencodeLane().result,
                members: {
                  Worker: {
                    ...opencodeLane().result.members.Worker,
                    bootstrapMode: 'app_managed_context',
                  },
                },
              },
            }),
          ],
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
        mixedSecondaryLanes: [
          opencodeLane({
            result: {
              ...opencodeLane().result,
              members: {
                Worker: {
                  ...opencodeLane().result.members.Worker,
                  bootstrapMode: 'app_managed_context',
                },
              },
            },
          }),
        ],
        provisioningOutputParts: [],
      },
      memberName: 'Worker',
      current: status(),
      runtimeDiagnostic: OPENCODE_APP_MANAGED_BOOTSTRAP_STALLED_DIAGNOSTIC,
      isCurrentTrackedRun: true,
    });
    expect(appManagedPlan).toEqual({ shouldSend: false, reason: 'app_managed_bootstrap' });
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

    scheduleOpenCodeBootstrapStallReevaluation(
      {
        runId: 'run-1',
        teamName: 'Team',
        request: { cwd: '/tmp/project' },
        provisioningOutputParts: [],
        memberSpawnStatuses: new Map(),
        progress: {} as never,
        onProgress: vi.fn(),
        isLaunch: true,
        provisioningComplete: false,
      },
      'Worker',
      acceptedAt,
      {
        nowMs: () => nowMs,
        getMemberLaunchGraceKey: () => 'Team:Worker',
        hasPendingTimeout: (key) => timers.has(key),
        setPendingTimeout: (key, timer) => timers.set(key, timer),
        deletePendingTimeout: (key) => timers.delete(key),
        setTimeout: setTimeoutPort,
        reevaluateMemberLaunchStatus: vi.fn(),
      }
    );
    scheduleOpenCodeBootstrapStallReevaluation(
      {
        runId: 'run-1',
        teamName: 'Team',
        request: { cwd: '/tmp/project' },
        provisioningOutputParts: [],
        memberSpawnStatuses: new Map(),
        progress: {} as never,
        onProgress: vi.fn(),
        isLaunch: true,
        provisioningComplete: false,
      },
      'Worker',
      acceptedAt,
      {
        nowMs: () => nowMs,
        getMemberLaunchGraceKey: () => 'Team:Worker',
        hasPendingTimeout: (key) => timers.has(key),
        setPendingTimeout: (key, timer) => timers.set(key, timer),
        deletePendingTimeout: (key) => timers.delete(key),
        setTimeout: setTimeoutPort,
        reevaluateMemberLaunchStatus: vi.fn(),
      }
    );

    expect(setTimeoutPort).toHaveBeenCalledTimes(1);
    expect(timers.has('Team:Worker:bootstrap-stall')).toBe(true);
  });
});
