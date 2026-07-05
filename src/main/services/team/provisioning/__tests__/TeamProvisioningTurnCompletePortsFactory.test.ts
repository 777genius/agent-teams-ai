import { describe, expect, it, vi } from 'vitest';

import {
  createTeamProvisioningTurnCompletePorts,
  type TeamProvisioningTurnCompleteOutputRecoveryAdapter,
  type TeamProvisioningTurnCompletePortsFactoryRun,
  type TeamProvisioningTurnCompleteServiceAdapter,
} from '../TeamProvisioningTurnCompletePortsFactory';

import type { MemberSpawnStatusEntry, TeamProvisioningProgress } from '@shared/types';

type TestRun = TeamProvisioningTurnCompletePortsFactoryRun;
interface TestSecondaryLaunchResult {
  launched: boolean;
}
type TestServiceAdapter = TeamProvisioningTurnCompleteServiceAdapter<
  TestRun,
  TestSecondaryLaunchResult
>;
const PROJECT_CWD = '/workspace/project';

function createProgress(
  overrides: Partial<TeamProvisioningProgress> = {}
): TeamProvisioningProgress {
  return {
    state: 'assembling',
    message: 'starting',
    startedAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  } as TeamProvisioningProgress;
}

function createRun(overrides: Partial<TestRun> = {}): TestRun {
  return {
    runId: 'run-1',
    teamName: 'atlas-hq',
    provisioningComplete: false,
    cancelRequested: false,
    processKilled: false,
    progress: createProgress(),
    apiErrorWarningEmitted: false,
    timeoutHandle: null,
    isLaunch: true,
    request: {
      cwd: PROJECT_CWD,
      color: 'blue',
      members: [],
    },
    detectedSessionId: 'session-1',
    allEffectiveMembers: [],
    deterministicBootstrap: false,
    pendingGeminiPostLaunchHydration: false,
    geminiPostLaunchHydrationInFlight: false,
    child: null,
    onProgress: vi.fn(),
    claudeLogLines: [],
    stdoutBuffer: '',
    stderrBuffer: '',
    stdoutParserCarry: '',
    stdoutParserCarryIsCompleteJson: false,
    stdoutParserCarryLooksLikeClaudeJson: false,
    memberSpawnStatuses: new Map(),
    ...overrides,
  } as TestRun;
}

function createServiceAdapter(overrides: Partial<TestServiceAdapter> = {}): TestServiceAdapter {
  return {
    hasPendingDeterministicFirstRealTurn: vi.fn(() => false),
    isProvisioningRunStillPromotable: vi.fn(() => true),
    scheduleDeterministicBootstrapCompletionRecovery: vi.fn(),
    resetRuntimeToolActivity: vi.fn(),
    getRunLeadName: vi.fn(() => 'Lead'),
    setLeadActivity: vi.fn(),
    stopFilesystemMonitor: vi.fn(),
    refreshMemberSpawnStatusesFromLeadInbox: vi.fn(async () => undefined),
    maybeAuditMemberSpawnStatuses: vi.fn(async () => undefined),
    finalizeMissingRegisteredMembersAsFailed: vi.fn(async () => undefined),
    launchMixedSecondaryLaneIfNeeded: vi.fn(async () => ({ launched: true })),
    reconcileFinalLaunchReportingSnapshot: vi.fn(async () => null),
    getMemberLaunchSummary: vi.fn(() => ({
      confirmedCount: 1,
      pendingCount: 0,
      failedCount: 0,
      runtimeAlivePendingCount: 0,
    })),
    hasPendingLaunchMembers: vi.fn(() => false),
    isProvisioningRunPromotedToAlive: vi.fn(() => false),
    buildAggregatePendingLaunchMessage: vi.fn(() => 'pending launch members'),
    fireTeamLaunchedNotification: vi.fn(async () => undefined),
    fireTeamLaunchIncompleteNotification: vi.fn(async () => undefined),
    sendMessageToRun: vi.fn(async () => undefined),
    relayLeadInboxMessages: vi.fn(async () => undefined),
    injectGeminiPostLaunchHydration: vi.fn(async () => undefined),
    waitForValidConfig: vi.fn(async () => ({ ok: true, location: 'configured' as const })),
    writeLaunchFailureArtifactPackBestEffort: vi.fn(),
    cleanupRun: vi.fn(),
    ...overrides,
  };
}

function createOutputRecoveryAdapter(): TeamProvisioningTurnCompleteOutputRecoveryAdapter<
  TestRun,
  TestSecondaryLaunchResult
> {
  return {
    failProvisioningWithApiError: vi.fn(),
    handleAuthFailureInOutput: vi.fn(),
    stopStallWatchdog: vi.fn(),
  };
}

describe('TeamProvisioningTurnCompletePortsFactory', () => {
  it('wires service callbacks and shared provisioning helpers into turn-complete ports', async () => {
    const service = createServiceAdapter();
    const config = {
      updateConfigPostLaunch: vi.fn(async () => undefined),
      cleanupPrelaunchBackup: vi.fn(async () => undefined),
      persistMembersMeta: vi.fn(async () => undefined),
    };
    const updateProgress = vi.fn((_run, state, message) => createProgress({ state, message }));
    const outputRecovery = createOutputRecoveryAdapter();
    const provisioningRunByTeam = new Map<string, TestRun>();
    const setAliveRunId = vi.fn();
    const emitTeamChange = vi.fn();
    const killTeamProcess = vi.fn();
    const ports = createTeamProvisioningTurnCompletePorts({
      service,
      outputRecovery,
      config,
      updateProgress,
      provisioningRunByTeam,
      setAliveRunId,
      emitTeamChange,
      killTeamProcess,
    });
    const run = createRun({
      claudeLogLines: ['first', 'second'],
      stderrBuffer: ' stderr auth failure ',
      stdoutParserCarry: ' trailing stdout failure ',
      memberSpawnStatuses: new Map<string, MemberSpawnStatusEntry>([
        [
          'zeta',
          {
            launchState: 'failed_to_start',
            error: 'terminal error',
            updatedAt: '2026-01-01T00:00:00.000Z',
          } as MemberSpawnStatusEntry,
        ],
        [
          'alpha',
          {
            launchState: 'failed_to_start',
            hardFailureReason: 'hard fail',
            updatedAt: '2026-01-01T00:01:00.000Z',
          } as MemberSpawnStatusEntry,
        ],
      ]),
    });

    expect(ports.getRunLeadName(run)).toBe('Lead');
    expect(ports.updateProgress(run, 'ready', 'done')).toEqual(
      createProgress({ state: 'ready', message: 'done' })
    );
    expect(ports.extractCliLogsFromRun(run)).toBe('first\nsecond');
    expect(ports.getPreCompleteCliErrorText(run)).toBe(
      'stderr auth failure\ntrailing stdout failure'
    );
    expect(ports.getFailedSpawnMembers(run)).toEqual([
      {
        name: 'alpha',
        error: 'hard fail',
        updatedAt: '2026-01-01T00:01:00.000Z',
      },
      {
        name: 'zeta',
        error: 'terminal error',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    ]);
    expect(ports.hasApiError('runtime emitted api error: 429 model cooldown')).toBe(true);
    expect(ports.isAuthFailureWarning('API Error: 401 Unauthorized', 'pre-complete')).toBe(true);

    await ports.updateConfigPostLaunch('atlas-hq', PROJECT_CWD, 'session-1', 'blue', {
      providerId: undefined,
      model: undefined,
      effort: undefined,
      members: [],
    });
    await expect(ports.launchMixedSecondaryLaneIfNeeded(run)).resolves.toEqual({
      launched: true,
    });
    ports.setAliveRunId('atlas-hq', 'run-1');
    ports.emitTeamChange({ type: 'inbox', teamName: 'atlas-hq', detail: 'user.json' });
    ports.killTeamProcess(null);

    expect(config.updateConfigPostLaunch).toHaveBeenCalledWith(
      'atlas-hq',
      PROJECT_CWD,
      'session-1',
      'blue',
      {
        providerId: undefined,
        model: undefined,
        effort: undefined,
        members: [],
      }
    );
    expect(service.launchMixedSecondaryLaneIfNeeded).toHaveBeenCalledWith(run, undefined);
    expect(setAliveRunId).toHaveBeenCalledWith('atlas-hq', 'run-1');
    expect(emitTeamChange).toHaveBeenCalledWith({
      type: 'inbox',
      teamName: 'atlas-hq',
      detail: 'user.json',
    });
    expect(killTeamProcess).toHaveBeenCalledWith(null);
  });
});
