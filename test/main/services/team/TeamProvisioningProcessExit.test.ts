import {
  buildCodeZeroProvisioningValidationError,
  buildCompletedProcessExitMessage,
  buildProvisionedButNotAliveWarnings,
  buildTimeoutCompletionWarnings,
  decideProcessExitAfterParserFlush,
  decideProcessExitBeforeParserFlush,
  decideTimeoutCompletion,
  handleProvisioningProcessExit,
  hasIncompleteClaudeStdoutCarry,
  isProvisioningRunFailed,
  type TeamProvisioningProcessExitPorts,
  type TeamProvisioningProcessExitRun,
  waitForValidConfig,
} from '@main/services/team/provisioning/TeamProvisioningProcessExit';
import { describe, expect, it, vi } from 'vitest';

import type { TeamProvisioningProgress } from '@shared/types';

function makeProcessExitProgress(
  overrides: Partial<TeamProvisioningProgress> = {}
): TeamProvisioningProgress {
  return {
    runId: 'run-1',
    teamName: 'team-a',
    state: 'ready',
    message: 'Ready',
    startedAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:01.000Z',
    ...overrides,
  };
}

function makeProcessExitRun(
  overrides: Partial<TeamProvisioningProcessExitRun> = {}
): TeamProvisioningProcessExitRun {
  return {
    runId: 'run-1',
    teamName: 'team-a',
    progress: makeProcessExitProgress(),
    stdoutBuffer: '',
    stderrBuffer: '',
    deterministicBootstrap: false,
    deterministicBootstrapMemberSpawnSeen: false,
    memberSpawnStatuses: new Map(),
    stdoutParserCarry: '',
    stdoutParserCarryIsCompleteJson: false,
    stdoutParserCarryLooksLikeClaudeJson: false,
    processKilled: false,
    finalizingByTimeout: false,
    cancelRequested: false,
    provisioningComplete: true,
    processClosed: false,
    authRetryInProgress: false,
    isLaunch: true,
    teamsBasePathsToProbe: [],
    expectedMembers: [],
    request: {
      teamName: 'team-a',
      members: [],
      cwd: '/test/project',
    },
    allEffectiveMembers: [],
    detectedSessionId: null,
    onProgress: vi.fn(),
    ...overrides,
  };
}

function makeProcessExitHarness(
  run: TeamProvisioningProcessExitRun,
  lifecycleEvents: string[]
): {
  ports: TeamProvisioningProcessExitPorts<TeamProvisioningProcessExitRun>;
  trackedRuns: Map<string, TeamProvisioningProcessExitRun>;
} {
  const trackedRuns = new Map([[run.runId, run]]);
  const ports = {
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
    },
    buildStdoutCarryDiagnostic: vi.fn(() => ({})),
    flushStdoutParserCarry: vi.fn(),
    stopStallWatchdog: vi.fn(),
    hasSecondaryRuntimeRuns: vi.fn(() => true),
    stopMixedSecondaryRuntimeLanes: vi.fn(async () => {
      lifecycleEvents.push('secondaries stopped');
    }),
    waitForValidConfig: vi.fn(async () => ({ ok: false as const })),
    waitForTeamInList: vi.fn(async () => false),
    waitForMissingInboxes: vi.fn(async () => []),
    persistMembersMeta: vi.fn(async () => undefined),
    updateProgress: vi.fn((targetRun, state, message, extras) => {
      lifecycleEvents.push('progress updated');
      const nextProgress = makeProcessExitProgress({
        ...targetRun.progress,
        ...extras,
        runId: targetRun.runId,
        teamName: targetRun.teamName,
        state,
        message,
        updatedAt: '2026-01-01T00:00:02.000Z',
      });
      targetRun.progress = nextProgress;
      return nextProgress;
    }),
    cleanupRun: vi.fn((targetRun) => {
      lifecycleEvents.push('cleanup');
      trackedRuns.delete(targetRun.runId);
    }),
    getTeamsBasePath: vi.fn(() => '/configured/teams'),
    getAutoDetectedClaudeBasePath: vi.fn(() => '/default'),
    getConfiguredCliCommandLabel: vi.fn(() => 'claude'),
    getRunRuntimeFailureLabel: vi.fn(() => 'Claude runtime'),
    getVerificationTimeoutMs: vi.fn(() => 15_000),
    extractCliLogsFromRun: vi.fn(() => undefined),
    logsSuggestShutdownOrCleanup: vi.fn(() => false),
    finalizeIncompleteLaunchStateBeforeCleanup: vi.fn(async () => undefined),
  } satisfies TeamProvisioningProcessExitPorts<TeamProvisioningProcessExitRun>;

  return { ports, trackedRuns };
}

describe('TeamProvisioningProcessExit', () => {
  it('stops secondary runtimes before successful process-exit cleanup', async () => {
    const lifecycleEvents: string[] = [];
    const run = makeProcessExitRun({
      onProgress: vi.fn(() => {
        lifecycleEvents.push('progress emitted');
      }),
    });
    const { ports, trackedRuns } = makeProcessExitHarness(run, lifecycleEvents);

    await handleProvisioningProcessExit(run, 0, ports);

    expect(lifecycleEvents).toEqual([
      'secondaries stopped',
      'progress updated',
      'progress emitted',
      'cleanup',
    ]);
    expect(ports.cleanupRun).toHaveBeenCalledOnce();
    expect(trackedRuns.has(run.runId)).toBe(false);
  });

  it('propagates secondary stop rejection and preserves process-exit tracking', async () => {
    const lifecycleEvents: string[] = [];
    const stopFailure = new Error('secondary process-exit stop failed');
    const run = makeProcessExitRun();
    const { ports, trackedRuns } = makeProcessExitHarness(run, lifecycleEvents);
    vi.mocked(ports.stopMixedSecondaryRuntimeLanes).mockImplementation(async () => {
      lifecycleEvents.push('secondary stop failed');
      throw stopFailure;
    });

    await expect(handleProvisioningProcessExit(run, 0, ports)).rejects.toBe(stopFailure);

    expect(lifecycleEvents).toEqual(['secondary stop failed']);
    expect(ports.updateProgress).not.toHaveBeenCalled();
    expect(ports.cleanupRun).not.toHaveBeenCalled();
    expect(trackedRuns.get(run.runId)).toBe(run);
    expect(ports.logger.warn).not.toHaveBeenCalled();
  });

  it('classifies process exit guards before parser flushing', () => {
    expect(
      decideProcessExitBeforeParserFlush({
        finalizingByTimeout: true,
        progressState: 'verifying',
        cancelRequested: false,
        authRetryInProgress: false,
      })
    ).toEqual({ action: 'ignore', reason: 'finalizing_by_timeout' });

    expect(
      decideProcessExitBeforeParserFlush({
        finalizingByTimeout: false,
        progressState: 'failed',
        cancelRequested: false,
        authRetryInProgress: false,
      })
    ).toEqual({ action: 'ignore', reason: 'failed_or_cancelled' });

    expect(
      decideProcessExitBeforeParserFlush({
        finalizingByTimeout: false,
        progressState: 'verifying',
        cancelRequested: false,
        authRetryInProgress: true,
      })
    ).toEqual({ action: 'ignore', reason: 'auth_retry_in_progress' });

    expect(
      decideProcessExitBeforeParserFlush({
        finalizingByTimeout: false,
        progressState: 'verifying',
        cancelRequested: false,
        authRetryInProgress: false,
      })
    ).toEqual({ action: 'continue' });
  });

  it('classifies process exit guards after parser flushing', () => {
    expect(
      decideProcessExitAfterParserFlush({
        progressState: 'failed',
        cancelRequested: false,
        processKilled: false,
        authRetryInProgress: false,
      })
    ).toEqual({ action: 'ignore', reason: 'failed' });

    expect(
      decideProcessExitAfterParserFlush({
        progressState: 'verifying',
        cancelRequested: true,
        processKilled: false,
        authRetryInProgress: false,
      })
    ).toEqual({ action: 'ignore', reason: 'cancelled' });

    expect(
      decideProcessExitAfterParserFlush({
        progressState: 'verifying',
        cancelRequested: false,
        processKilled: true,
        authRetryInProgress: false,
      })
    ).toEqual({ action: 'ignore', reason: 'process_killed' });

    expect(
      decideProcessExitAfterParserFlush({
        progressState: 'verifying',
        cancelRequested: false,
        processKilled: false,
        authRetryInProgress: false,
      })
    ).toEqual({ action: 'continue' });
  });

  it('builds stable process exit messages and warnings', () => {
    expect(buildCompletedProcessExitMessage(0)).toBe('Team process exited normally');
    expect(buildCompletedProcessExitMessage(2)).toBe('Team process exited unexpectedly (code 2)');
    expect(buildCompletedProcessExitMessage(null)).toBe(
      'Team process exited unexpectedly (code unknown)'
    );

    expect(buildProvisionedButNotAliveWarnings(null)).toEqual([
      'CLI process exited (code unknown) — team provisioned but not alive',
    ]);
    expect(buildProvisionedButNotAliveWarnings(1, ['worker'])).toEqual([
      'CLI process exited (code 1) — team provisioned but not alive',
      'Some inboxes not created yet',
    ]);
    expect(buildTimeoutCompletionWarnings(['worker'])).toEqual([
      'CLI timed out after config was created — team provisioned but process killed',
      'Some inboxes not created yet',
    ]);
  });

  it('builds code-zero validation errors from config visibility evidence', () => {
    expect(
      buildCodeZeroProvisioningValidationError({
        configFound: false,
        configuredTeamsBasePath: '/configured/teams',
        configuredConfigPath: '/configured/teams/demo/config.json',
        defaultTeamsBasePath: '/default/teams',
        defaultConfigPath: '/default/teams/demo/config.json',
        timeoutMs: 15_000,
        cleanupHint: ' cleanup hint',
      })
    ).toBe(
      'No valid config.json found at /configured/teams/demo/config.json (also checked /default/teams/demo/config.json) within 15s. cleanup hint'
    );

    expect(
      buildCodeZeroProvisioningValidationError({
        configFound: true,
        configuredTeamsBasePath: '/configured/teams',
        configuredConfigPath: '/configured/teams/demo/config.json',
        defaultTeamsBasePath: '/default/teams',
        defaultConfigPath: '/default/teams/demo/config.json',
        timeoutMs: 15_000,
      })
    ).toBe('Team did not appear in team:list after provisioning');
  });

  it('decides timeout completion from config, visibility, and cancellation state', () => {
    expect(
      decideTimeoutCompletion({
        cancelRequested: true,
        configProbe: { ok: true, location: 'configured', configPath: '/team/config.json' },
        visibleInList: true,
        missingInboxes: [],
      })
    ).toEqual({ action: 'skip', reason: 'cancelled' });

    expect(
      decideTimeoutCompletion({
        cancelRequested: false,
        configProbe: { ok: false },
        visibleInList: true,
        missingInboxes: [],
      })
    ).toEqual({ action: 'skip', reason: 'config_missing' });

    expect(
      decideTimeoutCompletion({
        cancelRequested: false,
        configProbe: { ok: true, location: 'default', configPath: '/team/config.json' },
        visibleInList: true,
        missingInboxes: [],
      })
    ).toEqual({ action: 'skip', reason: 'config_not_configured_root' });

    expect(
      decideTimeoutCompletion({
        cancelRequested: false,
        configProbe: { ok: true, location: 'configured', configPath: '/team/config.json' },
        visibleInList: false,
        missingInboxes: [],
      })
    ).toEqual({ action: 'skip', reason: 'team_not_visible' });

    expect(
      decideTimeoutCompletion({
        cancelRequested: false,
        configProbe: { ok: true, location: 'configured', configPath: '/team/config.json' },
        visibleInList: true,
        missingInboxes: ['worker'],
      })
    ).toEqual({
      action: 'complete',
      warnings: [
        'CLI timed out after config was created — team provisioned but process killed',
        'Some inboxes not created yet',
      ],
    });
  });

  it('waits for valid config across configured and default probe roots', async () => {
    const readPaths: string[] = [];
    const result = await waitForValidConfig(
      {
        teamName: 'demo',
        cancelRequested: false,
        teamsBasePathsToProbe: [
          { location: 'configured', basePath: '/configured/teams' },
          { location: 'default', basePath: '/default/teams' },
        ],
      },
      {
        readRegularFileUtf8: vi.fn(async (filePath: string) => {
          readPaths.push(filePath);
          return filePath.startsWith('/default/') ? '{"name":"demo"}' : null;
        }),
        timeoutMs: 1_000,
        pollMs: 10,
        teamJsonReadTimeoutMs: 25,
        teamConfigMaxBytes: 1_024,
        sleep: vi.fn(async () => undefined),
      }
    );

    expect(result).toEqual({
      ok: true,
      location: 'default',
      configPath: '/default/teams/demo/config.json',
    });
    expect(readPaths).toEqual([
      '/configured/teams/demo/config.json',
      '/default/teams/demo/config.json',
    ]);
  });

  it('keeps polling malformed config until the deadline', async () => {
    const now = vi.spyOn(Date, 'now');
    now.mockReturnValueOnce(0).mockReturnValueOnce(0).mockReturnValueOnce(10);
    const sleep = vi.fn(async () => undefined);

    try {
      const result = await waitForValidConfig(
        {
          teamName: 'demo',
          cancelRequested: false,
          teamsBasePathsToProbe: [{ location: 'configured', basePath: '/configured/teams' }],
        },
        {
          readRegularFileUtf8: vi.fn(async () => '{"name":""}'),
          timeoutMs: 10,
          pollMs: 10,
          teamJsonReadTimeoutMs: 25,
          teamConfigMaxBytes: 1_024,
          sleep,
        }
      );

      expect(result).toEqual({ ok: false });
      expect(sleep).toHaveBeenCalledWith(10);
    } finally {
      now.mockRestore();
    }
  });

  it('detects failed progress and incomplete stream-json carry', () => {
    expect(isProvisioningRunFailed({ progress: { state: 'failed' } })).toBe(true);
    expect(isProvisioningRunFailed({ progress: { state: 'verifying' } })).toBe(false);

    expect(
      hasIncompleteClaudeStdoutCarry({
        stdoutParserCarry: ' {"type": "assistant"',
        stdoutParserCarryIsCompleteJson: false,
        stdoutParserCarryLooksLikeClaudeJson: true,
      })
    ).toBe(true);
    expect(
      hasIncompleteClaudeStdoutCarry({
        stdoutParserCarry: ' {"type": "assistant"}',
        stdoutParserCarryIsCompleteJson: true,
        stdoutParserCarryLooksLikeClaudeJson: true,
      })
    ).toBe(false);
  });
});
