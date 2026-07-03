import { EventEmitter } from 'events';
import { describe, expect, it, vi } from 'vitest';

import {
  respawnCliAfterAuthFailure,
  type TeamProvisioningAuthRetryPorts,
  type TeamProvisioningAuthRetryRun,
} from '../TeamProvisioningAuthRetryRecovery';

import type { TeamProvisioningProgress } from '@shared/types';
import type { ChildProcess } from 'child_process';

function progress(): TeamProvisioningProgress {
  return {
    runId: 'run-1',
    teamName: 'team-a',
    state: 'spawning',
    message: 'Starting',
    startedAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

function makeChild(pid = 123): ChildProcess {
  const child = new EventEmitter() as ChildProcess;
  Object.assign(child, {
    pid,
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    stdin: {
      writable: true,
      write: vi.fn(),
    },
  });
  return child;
}

function makeRun(
  overrides: Partial<TeamProvisioningAuthRetryRun> = {}
): TeamProvisioningAuthRetryRun {
  return {
    runId: 'run-1',
    teamName: 'team-a',
    progress: progress(),
    stdoutBuffer: 'old stdout',
    stderrBuffer: 'old stderr',
    claudeLogLines: ['old log'],
    provisioningOutputParts: [],
    provisioningOutputIndexByMessageId: new Map(),
    stdoutParserCarry: '',
    stdoutParserCarryIsCompleteJson: false,
    stdoutParserCarryLooksLikeClaudeJson: false,
    processKilled: false,
    cancelRequested: false,
    provisioningComplete: false,
    child: makeChild(111),
    onProgress: vi.fn(),
    expectedMembers: [],
    request: {
      teamName: 'team-a',
      cwd: '/project',
      members: [],
    } as TeamProvisioningAuthRetryRun['request'],
    lastLogProgressAt: 0,
    lastDataReceivedAt: 0,
    lastStdoutReceivedAt: 0,
    stallCheckHandle: null,
    stallWarningIndex: null,
    preStallMessage: null,
    lastRetryAt: 0,
    apiRetryWarningIndex: null,
    apiErrorWarningEmitted: true,
    authFailureRetried: false,
    authRetryInProgress: true,
    isLaunch: false,
    memberSpawnStatuses: new Map(),
    timeoutHandle: { id: 'timer' } as unknown as NodeJS.Timeout,
    stdoutLogLineBuf: 'old stdout line',
    stderrLogLineBuf: 'old stderr line',
    lastClaudeLogStream: 'stderr',
    claudeLogsUpdatedAt: '2026-01-01T00:00:00.000Z',
    spawnContext: {
      claudePath: '/bin/claude',
      args: [
        '--mcp-config',
        '/missing-mcp',
        '--team-bootstrap-user-prompt-file',
        '/missing-prompt',
      ],
      cwd: '/project',
      env: { CLAUDE_TEAM_CONTROL_URL: 'http://localhost:1234' },
      prompt: 'hello',
    },
    mcpConfigPath: '/missing-mcp',
    bootstrapUserPromptPath: '/missing-prompt',
    processClosed: true,
    finalizingByTimeout: false,
    deterministicBootstrap: true,
    effectiveMembers: [],
    ...overrides,
  };
}

function makePorts(): TeamProvisioningAuthRetryPorts<TeamProvisioningAuthRetryRun> & {
  spawnedChild: ChildProcess;
} {
  const spawnedChild = makeChild(222);
  return {
    spawnedChild,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    clearTimeout: vi.fn(),
    setTimeout: vi.fn(() => ({ id: 'next-timer' }) as unknown as NodeJS.Timeout),
    nowMs: vi.fn(() => 5_000),
    sleep: vi.fn(async () => undefined),
    pathExists: vi.fn(async () => false),
    mcpConfigBuilder: {
      writeConfigFile: vi.fn(async () => '/new-mcp'),
    },
    readBootstrapRealTaskSubmissionState: vi.fn(async () => 'not_submitted' as const),
    writeDeterministicBootstrapUserPromptFile: vi.fn(async () => '/new-prompt'),
    validateAgentTeamsMcpRuntime: vi.fn(async () => undefined),
    spawnCli: vi.fn(() => spawnedChild),
    isStopAllTeamsGenerationChanged: vi.fn(() => false),
    getStopAllTeamsGeneration: vi.fn(() => 7),
    stopFilesystemMonitor: vi.fn(),
    stopStallWatchdog: vi.fn(),
    killTeamProcess: vi.fn(),
    updateProgress: vi.fn((run, state, message, extras) => {
      run.progress = {
        ...run.progress,
        state,
        message,
        updatedAt: '2026-01-01T00:00:01.000Z',
        error: extras?.error,
        cliLogsTail: extras?.cliLogsTail,
        pid: extras?.pid,
      };
      return run.progress;
    }),
    extractCliLogsFromRun: vi.fn(() => 'logs tail'),
    cleanupRun: vi.fn(),
    attachStdoutHandler: vi.fn(),
    attachStderrHandler: vi.fn(),
    startStallWatchdog: vi.fn(),
    startFilesystemMonitor: vi.fn(),
    tryCompleteAfterTimeout: vi.fn(async () => false),
    getProvisioningRunTimeoutMs: vi.fn(() => 60_000),
    handleProcessExit: vi.fn(async () => undefined),
  };
}

describe('team provisioning auth retry recovery', () => {
  it('tears down the failed process, regenerates missing bootstrap files, and respawns', async () => {
    const run = makeRun();
    const oldChild = run.child;
    const ports = makePorts();

    await respawnCliAfterAuthFailure(run, ports, { preflightAuthRetryDelayMs: 2_000 });

    expect(ports.clearTimeout).toHaveBeenCalledWith(expect.objectContaining({ id: 'timer' }));
    expect(ports.stopFilesystemMonitor).toHaveBeenCalledWith(run);
    expect(ports.stopStallWatchdog).toHaveBeenCalledWith(run);
    expect(ports.killTeamProcess).toHaveBeenCalledWith(oldChild);
    expect(run.stdoutBuffer).toBe('');
    expect(run.stderrBuffer).toBe('');
    expect(run.claudeLogLines).toEqual([]);
    expect(run.authFailureRetried).toBe(true);
    expect(run.apiErrorWarningEmitted).toBe(false);
    expect(ports.sleep).toHaveBeenCalledWith(2_000);
    expect(ports.mcpConfigBuilder.writeConfigFile).toHaveBeenCalledWith('/project', {
      controlApiBaseUrl: 'http://localhost:1234',
    });
    expect(ports.writeDeterministicBootstrapUserPromptFile).toHaveBeenCalledWith('hello');
    expect(run.spawnContext?.args).toEqual([
      '--mcp-config',
      '/new-mcp',
      '--team-bootstrap-user-prompt-file',
      '/new-prompt',
    ]);
    expect(ports.validateAgentTeamsMcpRuntime).toHaveBeenCalledWith(
      '/bin/claude',
      '/project',
      expect.objectContaining({ CLAUDE_TEAM_CONTROL_URL: 'http://localhost:1234' }),
      '/new-mcp',
      expect.objectContaining({ isCancelled: expect.any(Function) })
    );
    expect(ports.spawnCli).toHaveBeenCalledWith('/bin/claude', run.spawnContext?.args, {
      cwd: '/project',
      env: expect.objectContaining({ CLAUDE_TEAM_CONTROL_URL: 'http://localhost:1234' }),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    expect(run.child).toBe(ports.spawnedChild);
    expect(run.authRetryInProgress).toBe(false);
    expect(run.processClosed).toBe(false);
    expect(ports.attachStdoutHandler).toHaveBeenCalledWith(run);
    expect(ports.attachStderrHandler).toHaveBeenCalledWith(run);
    expect(ports.startStallWatchdog).toHaveBeenCalledWith(run);
    expect(ports.startFilesystemMonitor).toHaveBeenCalledWith(run, run.request);
    expect(run.timeoutHandle).toEqual(expect.objectContaining({ id: 'next-timer' }));
  });

  it('fails without respawning when retrying a missing prompt would risk duplicate submission', async () => {
    const run = makeRun({
      spawnContext: {
        claudePath: '/bin/claude',
        args: ['--team-bootstrap-user-prompt-file', '/missing-prompt'],
        cwd: '/project',
        env: {},
        prompt: 'hello',
      },
    });
    const ports = makePorts();
    vi.mocked(ports.readBootstrapRealTaskSubmissionState).mockResolvedValue('unknown');

    await respawnCliAfterAuthFailure(run, ports, { preflightAuthRetryDelayMs: 2_000 });

    expect(ports.spawnCli).not.toHaveBeenCalled();
    expect(run.authRetryInProgress).toBe(false);
    expect(run.progress).toMatchObject({
      state: 'failed',
      message: 'Unable to safely retry first task after auth failure',
    });
    expect(ports.cleanupRun).toHaveBeenCalledWith(run);
  });
});
