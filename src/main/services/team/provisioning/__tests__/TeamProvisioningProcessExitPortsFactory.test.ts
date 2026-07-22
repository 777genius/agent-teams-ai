import { describe, expect, it, vi } from 'vitest';

import {
  createTeamProvisioningProcessExitPorts,
  createTeamProvisioningProcessExitPortsDepsFromService,
  type TeamProvisioningProcessExitServiceAdapter,
  type TeamProvisioningProcessExitServiceHost,
  type TeamProvisioningProcessExitVerificationProbeAdapter,
} from '../TeamProvisioningProcessExitPortsFactory';

import type { TeamProvisioningProcessExitRun } from '../TeamProvisioningProcessExit';
import type { TeamProvisioningProgress } from '@shared/types';

type TestRun = TeamProvisioningProcessExitRun;

function createProgress(
  overrides: Partial<TeamProvisioningProgress> = {}
): TeamProvisioningProgress {
  return {
    state: 'verifying',
    message: 'verifying',
    startedAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  } as TeamProvisioningProgress;
}

function createRun(overrides: Partial<TestRun> = {}): TestRun {
  return {
    runId: 'run-1',
    teamName: 'atlas-hq',
    progress: createProgress(),
    stdoutBuffer: 'stdout',
    stderrBuffer: 'stderr',
    stdoutParserCarry: '',
    stdoutParserCarryIsCompleteJson: false,
    stdoutParserCarryLooksLikeClaudeJson: false,
    processKilled: false,
    finalizingByTimeout: false,
    cancelRequested: false,
    provisioningComplete: false,
    processClosed: false,
    authRetryInProgress: false,
    isLaunch: true,
    request: {
      cwd: '/repo',
      color: 'blue',
      providerId: 'claude',
      model: 'sonnet',
      effort: 'medium',
      members: [{ name: 'Lead', role: 'Lead' }],
    },
    allEffectiveMembers: [{ name: 'Lead', role: 'Lead' }],
    detectedSessionId: 'session-1',
    expectedMembers: ['Lead'],
    teamsBasePathsToProbe: [{ location: 'configured', basePath: '/teams' }],
    onProgress: vi.fn(),
    ...overrides,
  } as TestRun;
}

describe('TeamProvisioningProcessExitPortsFactory', () => {
  it('builds process-exit deps from service-shaped dependencies', async () => {
    const run = createRun();
    const verificationProbePorts: TeamProvisioningProcessExitVerificationProbeAdapter<TestRun> = {
      waitForValidConfig: vi.fn(async () => ({
        ok: true as const,
        location: 'configured' as const,
        configPath: '/teams/atlas-hq/config.json',
      })),
      waitForTeamInList: vi.fn(async () => true),
      waitForMissingInboxes: vi.fn(async () => []),
    };
    const service = {
      outputRecoveryFacade: {
        buildStdoutCarryDiagnostic: vi.fn(() => ({ carry: true })),
        flushStdoutParserCarry: vi.fn(),
        stopStallWatchdog: vi.fn(),
      },
      hasSecondaryRuntimeRuns: vi.fn(() => false),
      stopMixedSecondaryRuntimeLanes: vi.fn(async () => undefined),
      persistMembersMeta: vi.fn(async () => undefined),
      finalizeIncompleteLaunchStateBeforeCleanup: vi.fn(async () => undefined),
      cleanupRun: vi.fn(),
    } satisfies TeamProvisioningProcessExitServiceHost<TestRun>;
    const logger = { info: vi.fn(), warn: vi.fn() };
    const updateProgress = vi.fn(() => run.progress);
    const deps = createTeamProvisioningProcessExitPortsDepsFromService(service, {
      verificationProbePorts,
      logger,
      updateProgress,
      getTeamsBasePath: () => '/teams',
      getAutoDetectedClaudeBasePath: () => '/claude',
      getConfiguredCliCommandLabel: () => 'claude',
      getRunRuntimeFailureLabel: () => 'Claude',
      getVerificationTimeoutMs: () => 15_000,
      extractCliLogsFromRun: () => 'tail',
      logsSuggestShutdownOrCleanup: () => true,
    });

    expect(deps.service.buildStdoutCarryDiagnostic(run)).toEqual({ carry: true });
    deps.service.flushStdoutParserCarry(run);
    deps.service.stopStallWatchdog(run);
    expect(deps.service.hasSecondaryRuntimeRuns('atlas-hq')).toBe(false);
    await deps.service.stopMixedSecondaryRuntimeLanes('atlas-hq');
    await deps.service.persistMembersMeta('atlas-hq', run.request);
    await deps.service.finalizeIncompleteLaunchStateBeforeCleanup(run, 'fallback');
    deps.service.cleanupRun(run);

    expect(deps.verificationProbePorts).toBe(verificationProbePorts);
    expect(deps.logger).toBe(logger);
    expect(deps.updateProgress).toBe(updateProgress);
    expect(deps.getTeamsBasePath()).toBe('/teams');
    expect(service.outputRecoveryFacade.flushStdoutParserCarry).toHaveBeenCalledWith(run);
    expect(service.stopMixedSecondaryRuntimeLanes).toHaveBeenCalledWith('atlas-hq');
    expect(service.persistMembersMeta).toHaveBeenCalledWith('atlas-hq', run.request);
    expect(service.finalizeIncompleteLaunchStateBeforeCleanup).toHaveBeenCalledWith(
      run,
      'fallback'
    );
    expect(service.cleanupRun).toHaveBeenCalledWith(run);
  });

  it('wires process-exit ports through explicit service and probe dependencies', async () => {
    const run = createRun();
    const progress = createProgress({ state: 'disconnected', message: 'done' });
    const service: TeamProvisioningProcessExitServiceAdapter<TestRun> = {
      buildStdoutCarryDiagnostic: vi.fn(() => ({ carry: true })),
      flushStdoutParserCarry: vi.fn(),
      stopStallWatchdog: vi.fn(),
      hasSecondaryRuntimeRuns: vi.fn(() => true),
      stopMixedSecondaryRuntimeLanes: vi.fn(async () => undefined),
      persistMembersMeta: vi.fn(async () => undefined),
      finalizeIncompleteLaunchStateBeforeCleanup: vi.fn(async () => undefined),
      cleanupRun: vi.fn(),
    };
    const verificationProbePorts: TeamProvisioningProcessExitVerificationProbeAdapter<TestRun> = {
      waitForValidConfig: vi.fn(async () => ({
        ok: true as const,
        location: 'configured' as const,
        configPath: '/teams/atlas-hq/config.json',
      })),
      waitForTeamInList: vi.fn(async () => true),
      waitForMissingInboxes: vi.fn(async () => ['Reviewer']),
    };
    const updateProgress = vi.fn(() => progress);
    const getRunRuntimeFailureLabel = vi.fn(() => 'Claude');
    const extractCliLogsFromRun = vi.fn(() => 'tail');
    const logsSuggestShutdownOrCleanup = vi.fn(() => true);

    const ports = createTeamProvisioningProcessExitPorts<TestRun>({
      service,
      verificationProbePorts,
      logger: { info: vi.fn(), warn: vi.fn() },
      updateProgress,
      getTeamsBasePath: () => '/teams',
      getAutoDetectedClaudeBasePath: () => '/claude',
      getConfiguredCliCommandLabel: () => 'claude',
      getRunRuntimeFailureLabel,
      getVerificationTimeoutMs: () => 15_000,
      extractCliLogsFromRun,
      logsSuggestShutdownOrCleanup,
    });

    expect(ports.buildStdoutCarryDiagnostic(run)).toEqual({ carry: true });
    ports.flushStdoutParserCarry(run);
    ports.stopStallWatchdog(run);
    expect(ports.hasSecondaryRuntimeRuns('atlas-hq')).toBe(true);
    await ports.stopMixedSecondaryRuntimeLanes('atlas-hq');
    await ports.waitForValidConfig(run);
    await ports.waitForTeamInList('atlas-hq', run);
    await expect(ports.waitForMissingInboxes(run)).resolves.toEqual(['Reviewer']);
    await ports.persistMembersMeta('atlas-hq', run.request);
    expect(ports.updateProgress(run, 'disconnected', 'done')).toBe(progress);
    ports.cleanupRun(run);
    expect(ports.getTeamsBasePath()).toBe('/teams');
    expect(ports.getAutoDetectedClaudeBasePath()).toBe('/claude');
    expect(ports.getConfiguredCliCommandLabel()).toBe('claude');
    expect(ports.getRunRuntimeFailureLabel(run)).toBe('Claude');
    expect(ports.getVerificationTimeoutMs()).toBe(15_000);
    expect(ports.extractCliLogsFromRun(run)).toBe('tail');
    expect(ports.logsSuggestShutdownOrCleanup('logs')).toBe(true);
    await ports.finalizeIncompleteLaunchStateBeforeCleanup(run, 'fallback');

    expect(service.flushStdoutParserCarry).toHaveBeenCalledWith(run);
    expect(service.stopStallWatchdog).toHaveBeenCalledWith(run);
    expect(service.stopMixedSecondaryRuntimeLanes).toHaveBeenCalledWith('atlas-hq');
    expect(verificationProbePorts.waitForValidConfig).toHaveBeenCalledWith(run);
    expect(verificationProbePorts.waitForTeamInList).toHaveBeenCalledWith('atlas-hq', run);
    expect(verificationProbePorts.waitForMissingInboxes).toHaveBeenCalledWith(run);
    expect(service.persistMembersMeta).toHaveBeenCalledWith('atlas-hq', run.request);
    expect(updateProgress).toHaveBeenCalledWith(run, 'disconnected', 'done', undefined);
    expect(service.cleanupRun).toHaveBeenCalledWith(run);
    expect(getRunRuntimeFailureLabel).toHaveBeenCalledWith(run);
    expect(extractCliLogsFromRun).toHaveBeenCalledWith(run);
    expect(logsSuggestShutdownOrCleanup).toHaveBeenCalledWith('logs');
    expect(service.finalizeIncompleteLaunchStateBeforeCleanup).toHaveBeenCalledWith(
      run,
      'fallback'
    );
  });
});
