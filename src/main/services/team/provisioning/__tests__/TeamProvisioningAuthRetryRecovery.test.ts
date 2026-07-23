import { EventEmitter } from 'events';
import { describe, expect, it, vi } from 'vitest';

import { createAnthropicApiKeyHelperCleanupRetryOwner } from '../TeamProvisioningAnthropicApiKeyHelperLease';
import {
  respawnCliAfterAuthFailure,
  type TeamProvisioningAuthRetryPorts,
  type TeamProvisioningAuthRetryRun,
} from '../TeamProvisioningAuthRetryRecovery';

import type { TeamProvisioningProgress } from '@shared/types';
import type { ChildProcess } from 'child_process';

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}

function makeAnthropicHelper() {
  const directory = '/test-artifacts/auth-retry-helper';
  return {
    teamName: 'team-a',
    directory,
    helperPath: `${directory}/helper.sh`,
    keyPath: `${directory}/key`,
    settingsPath: `${directory}/settings.json`,
    settingsObject: { apiKeyHelper: `${directory}/helper.sh` },
    settingsArgs: ['--settings', `${directory}/settings.json`],
    envPatch: {},
  };
}

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
    anthropicApiKeyHelper: null,
    anthropicApiKeyHelperCleanupPromise: null,
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
  cleanupRetryOwner: ReturnType<typeof createAnthropicApiKeyHelperCleanupRetryOwner>;
} {
  const spawnedChild = makeChild(222);
  const cleanupRetryOwner = createAnthropicApiKeyHelperCleanupRetryOwner({
    retryDelaysMs: [24 * 60 * 60 * 1000],
  });
  return {
    spawnedChild,
    cleanupRetryOwner,
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
    killTeamProcessAndWait: vi.fn(async () => undefined),
    cleanupRunOwnedAnthropicApiKeyHelper: vi.fn(async (run) => {
      run.anthropicApiKeyHelper = null;
    }),
    retainAnthropicApiKeyHelperCleanupRetryOwner: (run, options) =>
      cleanupRetryOwner.retainRunOwner(run, options),
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
    expect(ports.killTeamProcessAndWait).toHaveBeenCalledWith(oldChild);
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

  it('does not regenerate or respawn until the old process tree is confirmed stopped', async () => {
    const run = makeRun();
    const ports = makePorts();
    const termination = deferred();
    vi.mocked(ports.killTeamProcessAndWait).mockImplementationOnce(async () => termination.promise);

    const respawning = respawnCliAfterAuthFailure(run, ports, {
      preflightAuthRetryDelayMs: 2_000,
    });
    await vi.waitFor(() => expect(ports.killTeamProcessAndWait).toHaveBeenCalledWith(run.child));

    expect(ports.mcpConfigBuilder.writeConfigFile).not.toHaveBeenCalled();
    expect(ports.spawnCli).not.toHaveBeenCalled();
    termination.resolve();
    await respawning;
    expect(ports.spawnCli).toHaveBeenCalledOnce();
  });

  it('retains old-process termination and helper ownership before publishing terminal failure', async () => {
    const helper = makeAnthropicHelper();
    const run = makeRun({ anthropicApiKeyHelper: helper });
    const oldChild = run.child;
    const ports = makePorts();
    vi.mocked(ports.killTeamProcessAndWait)
      .mockRejectedValueOnce(new Error('old descendant still observable'))
      .mockResolvedValue(undefined);
    run.onProgress = vi.fn(() => {
      if (run.progress.state === 'failed') {
        expect(ports.cleanupRetryOwner.getPendingOwnerCount()).toBe(1);
      }
    });

    await respawnCliAfterAuthFailure(run, ports, { preflightAuthRetryDelayMs: 2_000 });

    expect(run.progress.message).toBe(
      'Failed to confirm previous CLI termination before auth retry'
    );
    expect(run.child).toBe(oldChild);
    expect(run.anthropicApiKeyHelper).toBe(helper);
    expect(ports.mcpConfigBuilder.writeConfigFile).not.toHaveBeenCalled();
    expect(ports.cleanupRun).not.toHaveBeenCalled();

    await ports.cleanupRetryOwner.retryPendingForTeam('team-a');

    expect(run.child).toBeNull();
    expect(run.anthropicApiKeyHelper).toBeNull();
    expect(ports.cleanupRun).toHaveBeenCalledWith(run);
  });

  it.each([
    {
      name: 'missing spawn context',
      expectedMessage: 'Cannot retry Claude CLI authentication',
      configure(run: TeamProvisioningAuthRetryRun) {
        run.spawnContext = null;
      },
    },
    {
      name: 'cancellation after the retry delay',
      expectedMessage: 'Authentication retry cancelled',
      configure(run: TeamProvisioningAuthRetryRun, ports: ReturnType<typeof makePorts>) {
        vi.mocked(ports.sleep).mockImplementationOnce(async () => {
          run.cancelRequested = true;
        });
      },
    },
    {
      name: 'MCP config regeneration failure',
      expectedMessage: 'Failed to regenerate MCP config',
      configure(_run: TeamProvisioningAuthRetryRun, ports: ReturnType<typeof makePorts>) {
        vi.mocked(ports.mcpConfigBuilder.writeConfigFile).mockRejectedValueOnce(
          new Error('mcp write failed')
        );
      },
    },
    {
      name: 'MCP config path inspection failure',
      expectedMessage: 'Failed to inspect MCP config for auth retry',
      configure(_run: TeamProvisioningAuthRetryRun, ports: ReturnType<typeof makePorts>) {
        vi.mocked(ports.pathExists).mockRejectedValueOnce(new Error('mcp path unreadable'));
      },
    },
    {
      name: 'bootstrap state read failure',
      expectedMessage: 'Failed to inspect deferred first task state for auth retry',
      configure(run: TeamProvisioningAuthRetryRun, ports: ReturnType<typeof makePorts>) {
        run.spawnContext!.args = ['--team-bootstrap-user-prompt-file', '/missing-prompt'];
        vi.mocked(ports.readBootstrapRealTaskSubmissionState).mockRejectedValueOnce(
          new Error('bootstrap state unreadable')
        );
      },
    },
    {
      name: 'unknown bootstrap submission state',
      expectedMessage: 'Unable to safely retry first task after auth failure',
      configure(run: TeamProvisioningAuthRetryRun, ports: ReturnType<typeof makePorts>) {
        run.spawnContext!.args = ['--team-bootstrap-user-prompt-file', '/missing-prompt'];
        vi.mocked(ports.readBootstrapRealTaskSubmissionState).mockResolvedValueOnce('unknown');
      },
    },
    {
      name: 'missing bootstrap prompt content',
      expectedMessage: 'Failed to restore deferred first task after auth retry',
      configure(run: TeamProvisioningAuthRetryRun) {
        run.spawnContext!.args = ['--team-bootstrap-user-prompt-file', '/missing-prompt'];
        run.spawnContext!.prompt = '';
      },
    },
    {
      name: 'bootstrap prompt path inspection failure',
      expectedMessage: 'Failed to inspect deferred first task file for auth retry',
      configure(run: TeamProvisioningAuthRetryRun, ports: ReturnType<typeof makePorts>) {
        run.spawnContext!.args = ['--team-bootstrap-user-prompt-file', '/missing-prompt'];
        vi.mocked(ports.pathExists).mockRejectedValueOnce(new Error('prompt path unreadable'));
      },
    },
    {
      name: 'bootstrap prompt regeneration failure',
      expectedMessage: 'Failed to regenerate deferred first task for auth retry',
      configure(run: TeamProvisioningAuthRetryRun, ports: ReturnType<typeof makePorts>) {
        run.spawnContext!.args = ['--team-bootstrap-user-prompt-file', '/missing-prompt'];
        vi.mocked(ports.writeDeterministicBootstrapUserPromptFile).mockRejectedValueOnce(
          new Error('prompt write failed')
        );
      },
    },
    {
      name: 'replacement MCP validation failure',
      expectedMessage: 'Failed to respawn Claude CLI',
      configure(_run: TeamProvisioningAuthRetryRun, ports: ReturnType<typeof makePorts>) {
        vi.mocked(ports.validateAgentTeamsMcpRuntime).mockRejectedValueOnce(
          new Error('MCP validation failed')
        );
      },
    },
    {
      name: 'replacement spawn failure',
      expectedMessage: 'Failed to respawn Claude CLI',
      configure(_run: TeamProvisioningAuthRetryRun, ports: ReturnType<typeof makePorts>) {
        vi.mocked(ports.spawnCli).mockImplementationOnce(() => {
          throw new Error('spawn failed');
        });
      },
    },
  ])(
    'awaits helper cleanup before clearing child or tracking after $name',
    async ({ configure, expectedMessage }) => {
      const helper = makeAnthropicHelper();
      const run = makeRun({ anthropicApiKeyHelper: helper });
      const oldChild = run.child;
      const ports = makePorts();
      const cleanup = deferred();
      vi.mocked(ports.cleanupRunOwnedAnthropicApiKeyHelper).mockImplementationOnce(
        async (cleanupRun) => {
          await cleanup.promise;
          cleanupRun.anthropicApiKeyHelper = null;
        }
      );
      configure(run, ports);

      const respawning = respawnCliAfterAuthFailure(run, ports, {
        preflightAuthRetryDelayMs: 2_000,
      });
      await vi.waitFor(() =>
        expect(ports.cleanupRunOwnedAnthropicApiKeyHelper).toHaveBeenCalledWith(run)
      );

      expect(run.child).toBe(oldChild);
      expect(run.anthropicApiKeyHelper).toBe(helper);
      expect(ports.cleanupRun).not.toHaveBeenCalled();

      cleanup.resolve();
      await respawning;

      expect(run.child).toBeNull();
      expect(run.anthropicApiKeyHelper).toBeNull();
      expect(run.progress).toMatchObject({ state: 'failed', message: expectedMessage });
      expect(ports.cleanupRun).toHaveBeenCalledWith(run);
    }
  );

  it('registers terminal helper-cleanup ownership before failed progress is published', async () => {
    const helper = makeAnthropicHelper();
    const run = makeRun({ anthropicApiKeyHelper: helper });
    const ports = makePorts();
    vi.mocked(ports.mcpConfigBuilder.writeConfigFile).mockRejectedValueOnce(
      new Error('mcp write failed')
    );
    vi.mocked(ports.cleanupRunOwnedAnthropicApiKeyHelper).mockRejectedValueOnce(
      new Error('helper cleanup failed')
    );
    run.onProgress = vi.fn(() => {
      if (run.progress.state === 'failed') {
        expect(ports.cleanupRetryOwner.getPendingOwnerCount()).toBe(1);
      }
    });

    await respawnCliAfterAuthFailure(run, ports, { preflightAuthRetryDelayMs: 2_000 });

    expect(run.progress.message).toBe('Failed to regenerate MCP config');
    expect(run.child).not.toBeNull();
    expect(run.anthropicApiKeyHelper).toBe(helper);
    expect(ports.cleanupRun).not.toHaveBeenCalled();

    await ports.cleanupRetryOwner.retryPendingForTeam('team-a');

    expect(run.child).toBeNull();
    expect(run.anthropicApiKeyHelper).toBeNull();
    expect(ports.cleanupRun).toHaveBeenCalledWith(run);
  });

  it('awaits timeout termination before releasing the helper and dropping run tracking', async () => {
    const run = makeRun({ anthropicApiKeyHelper: makeAnthropicHelper() });
    const ports = makePorts();
    let timeoutCallback: (() => void) | undefined;
    ports.setTimeout = vi.fn((callback) => {
      timeoutCallback = callback;
      return { id: 'next-timer' } as unknown as NodeJS.Timeout;
    });
    const termination = deferred();
    vi.mocked(ports.killTeamProcessAndWait)
      .mockResolvedValueOnce(undefined)
      .mockImplementation(async () => termination.promise);

    await respawnCliAfterAuthFailure(run, ports, { preflightAuthRetryDelayMs: 2_000 });
    timeoutCallback?.();
    await vi.waitFor(() => {
      expect(ports.killTeamProcessAndWait).toHaveBeenCalledWith(ports.spawnedChild);
    });

    expect(ports.cleanupRunOwnedAnthropicApiKeyHelper).not.toHaveBeenCalled();
    expect(ports.cleanupRun).not.toHaveBeenCalled();
    expect(run.anthropicApiKeyHelper).not.toBeNull();

    termination.resolve();
    await vi.waitFor(() => {
      expect(ports.cleanupRun).toHaveBeenCalledWith(run);
    });
    expect(ports.cleanupRunOwnedAnthropicApiKeyHelper).toHaveBeenCalledWith(run);
    expect(run.anthropicApiKeyHelper).toBeNull();
    expect(ports.tryCompleteAfterTimeout).toHaveBeenCalledWith(run);
  });

  it('retains timeout tracking and helper ownership when termination is uncertain', async () => {
    const helper = makeAnthropicHelper();
    const run = makeRun({ anthropicApiKeyHelper: helper });
    const ports = makePorts();
    let timeoutCallback: (() => void) | undefined;
    ports.setTimeout = vi.fn((callback) => {
      timeoutCallback = callback;
      return { id: 'next-timer' } as unknown as NodeJS.Timeout;
    });
    vi.mocked(ports.killTeamProcessAndWait)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('descendant still observable'))
      .mockResolvedValue(undefined);

    await respawnCliAfterAuthFailure(run, ports, { preflightAuthRetryDelayMs: 2_000 });
    timeoutCallback?.();
    await vi.waitFor(() => {
      expect(run.progress.message).toBe('Failed to confirm auth-retry CLI termination');
    });

    expect(ports.cleanupRunOwnedAnthropicApiKeyHelper).not.toHaveBeenCalled();
    expect(ports.cleanupRun).not.toHaveBeenCalled();
    expect(run.anthropicApiKeyHelper).toBe(helper);
    expect(ports.cleanupRetryOwner.getPendingOwnerCount()).toBe(1);

    await ports.cleanupRetryOwner.retryPendingForTeam('team-a');

    expect(run.anthropicApiKeyHelper).toBeNull();
    expect(run.child).toBeNull();
    expect(ports.cleanupRun).toHaveBeenCalledWith(run);
    expect(ports.cleanupRetryOwner.getPendingOwnerCount()).toBe(0);
  });

  it('awaits child-error termination before helper release and cleanupRun', async () => {
    const run = makeRun({ anthropicApiKeyHelper: makeAnthropicHelper() });
    const ports = makePorts();
    const termination = deferred();
    vi.mocked(ports.killTeamProcessAndWait)
      .mockResolvedValueOnce(undefined)
      .mockImplementation(async () => termination.promise);

    await respawnCliAfterAuthFailure(run, ports, { preflightAuthRetryDelayMs: 2_000 });
    ports.spawnedChild.emit('error', new Error('spawned child failed'));
    await vi.waitFor(() => {
      expect(ports.killTeamProcessAndWait).toHaveBeenCalledWith(ports.spawnedChild);
    });

    expect(ports.cleanupRunOwnedAnthropicApiKeyHelper).not.toHaveBeenCalled();
    expect(ports.cleanupRun).not.toHaveBeenCalled();

    termination.resolve();
    await vi.waitFor(() => {
      expect(ports.cleanupRun).toHaveBeenCalledWith(run);
    });
    expect(ports.cleanupRunOwnedAnthropicApiKeyHelper).toHaveBeenCalledWith(run);
    expect(run.anthropicApiKeyHelper).toBeNull();
  });

  it('retains child-error helper cleanup before terminal progress becomes visible', async () => {
    const helper = makeAnthropicHelper();
    const run = makeRun({ anthropicApiKeyHelper: helper });
    const ports = makePorts();
    vi.mocked(ports.cleanupRunOwnedAnthropicApiKeyHelper).mockRejectedValueOnce(
      new Error('helper cleanup failed')
    );
    run.onProgress = vi.fn(() => {
      if (run.progress.state === 'failed') {
        expect(ports.cleanupRetryOwner.getPendingOwnerCount()).toBe(1);
      }
    });

    await respawnCliAfterAuthFailure(run, ports, { preflightAuthRetryDelayMs: 2_000 });
    ports.spawnedChild.emit('error', new Error('spawned child failed'));
    await vi.waitFor(() => {
      expect(run.progress.message).toBe('Auth-retry helper cleanup will be retried');
    });

    expect(run.anthropicApiKeyHelper).toBe(helper);
    expect(ports.cleanupRun).not.toHaveBeenCalled();

    await ports.cleanupRetryOwner.retryPendingForTeam('team-a');

    expect(run.anthropicApiKeyHelper).toBeNull();
    expect(run.child).toBeNull();
    expect(ports.cleanupRun).toHaveBeenCalledWith(run);
  });
});
