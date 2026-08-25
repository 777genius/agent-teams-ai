import {
  finalizeAuthRetryCleanupOwnership,
  retainAuthRetryCleanupOwnership,
} from './TeamProvisioningAuthRetryCleanupOwnership';

import type {
  AnthropicApiKeyHelperCleanupRetryOwner,
  AnthropicApiKeyHelperRunOwner,
} from './TeamProvisioningAnthropicApiKeyHelperLease';
import type { TeamProvisioningOutputRecoveryRun } from './TeamProvisioningOutputRecovery';
import type {
  TeamCreateRequest,
  TeamProvisioningProgress,
  TeamProvisioningState,
} from '@shared/types';
import type { ChildProcess } from 'child_process';

export type BootstrapRealTaskSubmissionState = 'not_submitted' | 'submitted' | 'unknown' | null;

export interface TeamProvisioningAuthRetrySpawnContext {
  claudePath: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  prompt: string;
}

export interface TeamProvisioningAuthRetryRun
  extends TeamProvisioningOutputRecoveryRun, AnthropicApiKeyHelperRunOwner {
  child: ChildProcess | null;
  timeoutHandle: NodeJS.Timeout | null;
  stdoutLogLineBuf: string;
  stderrLogLineBuf: string;
  lastClaudeLogStream: 'stdout' | 'stderr' | null;
  claudeLogsUpdatedAt?: string;
  spawnContext: TeamProvisioningAuthRetrySpawnContext | null;
  mcpConfigPath: string | null;
  bootstrapUserPromptPath: string | null;
  processClosed: boolean;
  finalizingByTimeout: boolean;
  deterministicBootstrap: boolean;
  effectiveMembers: TeamCreateRequest['members'];
}

export interface TeamProvisioningAuthRetryLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export interface TeamProvisioningAuthRetryMcpConfigBuilder {
  writeConfigFile(cwd: string, options: { controlApiBaseUrl: string | undefined }): Promise<string>;
}

export interface TeamProvisioningAuthRetryPorts<TRun extends TeamProvisioningAuthRetryRun> {
  logger: TeamProvisioningAuthRetryLogger;
  clearTimeout(handle: NodeJS.Timeout): void;
  setTimeout(callback: () => void, ms: number): NodeJS.Timeout;
  nowMs(): number;
  sleep(ms: number): Promise<void>;
  pathExists(filePath: string): Promise<boolean>;
  mcpConfigBuilder: TeamProvisioningAuthRetryMcpConfigBuilder;
  readBootstrapRealTaskSubmissionState(teamName: string): Promise<BootstrapRealTaskSubmissionState>;
  writeDeterministicBootstrapUserPromptFile(prompt: string): Promise<string>;
  validateAgentTeamsMcpRuntime(
    claudePath: string,
    cwd: string,
    env: NodeJS.ProcessEnv,
    mcpConfigPath: string,
    options: { isCancelled(): boolean }
  ): Promise<void>;
  spawnCli(
    command: string,
    args: string[],
    options: { cwd: string; env: NodeJS.ProcessEnv; stdio: ['pipe', 'pipe', 'pipe'] }
  ): ChildProcess;
  isStopAllTeamsGenerationChanged(stopAllGenerationAtStart: number): boolean;
  getStopAllTeamsGeneration(): number;
  stopFilesystemMonitor(run: TRun): void;
  stopStallWatchdog(run: TRun): void;
  killTeamProcessAndWait(child: ChildProcess | null): Promise<void>;
  cleanupRunOwnedAnthropicApiKeyHelper(run: TRun): Promise<void>;
  retainAnthropicApiKeyHelperCleanupRetryOwner: AnthropicApiKeyHelperCleanupRetryOwner['retainRunOwner'];
  updateProgress(
    run: TRun,
    state: Exclude<TeamProvisioningState, 'idle'>,
    message: string,
    extras?: Pick<TeamProvisioningProgress, 'error' | 'cliLogsTail' | 'pid'>
  ): TeamProvisioningProgress;
  extractCliLogsFromRun(run: TRun): string | undefined;
  cleanupRun(run: TRun): void;
  attachStdoutHandler(run: TRun): void;
  attachStderrHandler(run: TRun): void;
  startStallWatchdog(run: TRun): void;
  startFilesystemMonitor(run: TRun, request: TRun['request']): void;
  tryCompleteAfterTimeout(run: TRun): Promise<boolean>;
  getProvisioningRunTimeoutMs(run: TRun): number;
  handleProcessExit(run: TRun, code: number | null): Promise<void>;
}

export interface TeamProvisioningAuthRetryOptions {
  preflightAuthRetryDelayMs: number;
}

async function finalizeFailedAuthRetry<TRun extends TeamProvisioningAuthRetryRun>(
  run: TRun,
  child: ChildProcess | null,
  ports: TeamProvisioningAuthRetryPorts<TRun>,
  options: {
    terminationConfirmed: boolean;
    message: string;
    error: string;
    cliLogsTail?: string;
  }
): Promise<void> {
  run.authRetryInProgress = false;
  const ownership = await finalizeAuthRetryCleanupOwnership({
    run,
    child,
    terminationConfirmed: options.terminationConfirmed,
    ports,
  });
  const progress = ports.updateProgress(run, 'failed', options.message, {
    error: options.error,
    cliLogsTail: options.cliLogsTail ?? ports.extractCliLogsFromRun(run),
  });
  run.onProgress(progress);
  if (ownership === 'released') {
    ports.cleanupRun(run);
  }
}

async function terminateAndReleaseAuthRetryRun<TRun extends TeamProvisioningAuthRetryRun>(
  run: TRun,
  child: ChildProcess,
  ports: TeamProvisioningAuthRetryPorts<TRun>,
  context: 'timeout' | 'child error'
): Promise<boolean> {
  try {
    await ports.killTeamProcessAndWait(child);
  } catch (error) {
    run.finalizingByTimeout = false;
    await retainAuthRetryCleanupOwnership({
      run,
      child,
      terminationConfirmed: false,
      ports,
    });
    ports.logger.error(
      `[${run.teamName}] Failed to confirm auth-retry process termination after ${context}: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    const progress = ports.updateProgress(
      run,
      'failed',
      'Failed to confirm auth-retry CLI termination',
      {
        error:
          'The auth-retry CLI could not be confirmed stopped. The run and its authentication helper remain tracked for retry.',
        cliLogsTail: ports.extractCliLogsFromRun(run),
      }
    );
    run.onProgress(progress);
    return false;
  }

  try {
    await ports.cleanupRunOwnedAnthropicApiKeyHelper(run);
  } catch (error) {
    run.finalizingByTimeout = false;
    await retainAuthRetryCleanupOwnership({
      run,
      child,
      terminationConfirmed: true,
      ports,
    });
    ports.logger.error(
      `[${run.teamName}] Failed to release auth-retry helper after ${context}: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    const progress = ports.updateProgress(
      run,
      'failed',
      'Auth-retry helper cleanup will be retried',
      {
        error:
          'The auth-retry CLI stopped, but app-managed authentication material could not be removed. The run remains tracked for retry.',
        cliLogsTail: ports.extractCliLogsFromRun(run),
      }
    );
    run.onProgress(progress);
    return false;
  }
  return true;
}

export async function respawnCliAfterAuthFailure<TRun extends TeamProvisioningAuthRetryRun>(
  run: TRun,
  ports: TeamProvisioningAuthRetryPorts<TRun>,
  options: TeamProvisioningAuthRetryOptions
): Promise<void> {
  const ctx = run.spawnContext;
  const stopAllGenerationAtStart = ports.getStopAllTeamsGeneration();

  // Tear down current process without full cleanupRun (keep run alive)
  if (run.timeoutHandle) {
    ports.clearTimeout(run.timeoutHandle);
    run.timeoutHandle = null;
  }
  ports.stopFilesystemMonitor(run);
  ports.stopStallWatchdog(run);
  const previousChild = run.child;
  if (previousChild) {
    previousChild.stdout?.removeAllListeners('data');
    previousChild.stderr?.removeAllListeners('data');
    previousChild.removeAllListeners('error');
    previousChild.removeAllListeners('exit');
    previousChild.removeAllListeners('close');
    try {
      await ports.killTeamProcessAndWait(previousChild);
    } catch (error) {
      await retainAuthRetryCleanupOwnership({
        run,
        child: previousChild,
        terminationConfirmed: false,
        ports,
      });
      run.authRetryInProgress = false;
      const progress = ports.updateProgress(
        run,
        'failed',
        'Failed to confirm previous CLI termination before auth retry',
        {
          error: error instanceof Error ? error.message : String(error),
          cliLogsTail: ports.extractCliLogsFromRun(run),
        }
      );
      run.onProgress(progress);
      return;
    }
  }

  if (!ctx) {
    ports.logger.error(`[${run.teamName}] Cannot respawn - no spawn context saved`);
    await finalizeFailedAuthRetry(run, previousChild, ports, {
      terminationConfirmed: true,
      message: 'Cannot retry Claude CLI authentication',
      error: 'The saved CLI spawn context is unavailable.',
    });
    return;
  }

  // Reset buffers for fresh attempt
  run.stdoutBuffer = '';
  run.stderrBuffer = '';
  run.claudeLogLines = [];
  run.lastClaudeLogStream = null;
  run.stdoutLogLineBuf = '';
  run.stderrLogLineBuf = '';
  run.claudeLogsUpdatedAt = undefined;
  run.authFailureRetried = true;
  run.apiErrorWarningEmitted = false;

  ports.updateProgress(run, 'spawning', 'Auth failed - retrying after short delay');
  run.onProgress(run.progress);

  await ports.sleep(options.preflightAuthRetryDelayMs);

  if (run.cancelRequested) {
    await finalizeFailedAuthRetry(run, previousChild, ports, {
      terminationConfirmed: true,
      message: 'Authentication retry cancelled',
      error: 'The authentication retry was cancelled before the replacement CLI was spawned.',
    });
    return;
  }

  // Verify --mcp-config still exists; regenerate if deleted (e.g. by stale GC)
  const mcpFlagIdx = ctx.args.indexOf('--mcp-config');
  const bootstrapPromptFlagIdx = ctx.args.indexOf('--team-bootstrap-user-prompt-file');
  if (mcpFlagIdx !== -1 && mcpFlagIdx + 1 < ctx.args.length) {
    const existingConfigPath = ctx.args[mcpFlagIdx + 1];
    let configExists: boolean;
    try {
      configExists = await ports.pathExists(existingConfigPath);
    } catch (pathError) {
      await finalizeFailedAuthRetry(run, previousChild, ports, {
        terminationConfirmed: true,
        message: 'Failed to inspect MCP config for auth retry',
        error: pathError instanceof Error ? pathError.message : String(pathError),
      });
      return;
    }
    if (!configExists) {
      ports.logger.warn(`[${run.teamName}] MCP config ${existingConfigPath} missing, regenerating`);
      try {
        const newConfigPath = await ports.mcpConfigBuilder.writeConfigFile(ctx.cwd, {
          controlApiBaseUrl: ctx.env.CLAUDE_TEAM_CONTROL_URL,
        });
        ctx.args[mcpFlagIdx + 1] = newConfigPath;
        run.mcpConfigPath = newConfigPath;
        ports.logger.info(`[${run.teamName}] Regenerated MCP config at ${newConfigPath}`);
      } catch (regenErr) {
        await finalizeFailedAuthRetry(run, previousChild, ports, {
          terminationConfirmed: true,
          message: 'Failed to regenerate MCP config',
          error: regenErr instanceof Error ? regenErr.message : String(regenErr),
        });
        return;
      }
    }
  }

  if (bootstrapPromptFlagIdx !== -1 && bootstrapPromptFlagIdx + 1 < ctx.args.length) {
    const existingPromptPath = ctx.args[bootstrapPromptFlagIdx + 1];
    let promptFileExists: boolean;
    try {
      promptFileExists = await ports.pathExists(existingPromptPath);
    } catch (pathError) {
      await finalizeFailedAuthRetry(run, previousChild, ports, {
        terminationConfirmed: true,
        message: 'Failed to inspect deferred first task file for auth retry',
        error: pathError instanceof Error ? pathError.message : String(pathError),
      });
      return;
    }
    if (!promptFileExists) {
      let submissionState: BootstrapRealTaskSubmissionState;
      try {
        submissionState = await ports.readBootstrapRealTaskSubmissionState(run.teamName);
      } catch (stateError) {
        await finalizeFailedAuthRetry(run, previousChild, ports, {
          terminationConfirmed: true,
          message: 'Failed to inspect deferred first task state for auth retry',
          error: stateError instanceof Error ? stateError.message : String(stateError),
        });
        return;
      }
      if (submissionState === 'submitted') {
        ctx.args.splice(bootstrapPromptFlagIdx, 2);
        ctx.prompt = '';
        run.bootstrapUserPromptPath = null;
      } else if (submissionState === 'unknown') {
        await finalizeFailedAuthRetry(run, previousChild, ports, {
          terminationConfirmed: true,
          message: 'Unable to safely retry first task after auth failure',
          error:
            'deterministic bootstrap recorded the first real task as unknown, so retry would risk a duplicate submission',
        });
        return;
      } else if (ctx.prompt.trim().length === 0) {
        await finalizeFailedAuthRetry(run, previousChild, ports, {
          terminationConfirmed: true,
          message: 'Failed to restore deferred first task after auth retry',
          error:
            'deterministic bootstrap user prompt file was missing and no prompt was available to regenerate it',
        });
        return;
      } else {
        ports.logger.warn(
          `[${run.teamName}] Bootstrap user prompt file ${existingPromptPath} missing, regenerating`
        );
        try {
          const newPromptPath = await ports.writeDeterministicBootstrapUserPromptFile(ctx.prompt);
          ctx.args[bootstrapPromptFlagIdx + 1] = newPromptPath;
          run.bootstrapUserPromptPath = newPromptPath;
        } catch (regenErr) {
          await finalizeFailedAuthRetry(run, previousChild, ports, {
            terminationConfirmed: true,
            message: 'Failed to regenerate deferred first task for auth retry',
            error: regenErr instanceof Error ? regenErr.message : String(regenErr),
          });
          return;
        }
      }
    }
  }

  // Respawn with saved context - CLI handles its own auth refresh.
  let child: ChildProcess;
  try {
    if (mcpFlagIdx !== -1 && mcpFlagIdx + 1 < ctx.args.length) {
      await ports.validateAgentTeamsMcpRuntime(
        ctx.claudePath,
        ctx.cwd,
        ctx.env,
        ctx.args[mcpFlagIdx + 1],
        {
          isCancelled: () =>
            run.cancelRequested ||
            run.processKilled ||
            ports.isStopAllTeamsGenerationChanged(stopAllGenerationAtStart),
        }
      );
    }
    if (
      run.cancelRequested ||
      run.processKilled ||
      ports.isStopAllTeamsGenerationChanged(stopAllGenerationAtStart)
    ) {
      throw new Error('Team launch cancelled by app shutdown');
    }
    child = ports.spawnCli(ctx.claudePath, ctx.args, {
      cwd: ctx.cwd,
      env: { ...ctx.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (error) {
    await finalizeFailedAuthRetry(run, previousChild, ports, {
      terminationConfirmed: true,
      message: 'Failed to respawn Claude CLI',
      error: error instanceof Error ? error.message : String(error),
    });
    return;
  }

  ports.logger.info(
    `[${run.teamName}] Respawned CLI process after auth failure (pid=${child.pid ?? '?'})`
  );
  run.child = child;
  run.processClosed = false;
  run.authRetryInProgress = false;

  ports.updateProgress(run, 'spawning', 'CLI respawned - sending prompt', {
    pid: child.pid ?? undefined,
  });
  run.onProgress(run.progress);

  // Resend prompt only for legacy direct-stdin flows. Deterministic bootstrap
  // owns the first real task via --team-bootstrap-user-prompt-file.
  if (bootstrapPromptFlagIdx === -1 && child.stdin?.writable) {
    const message = JSON.stringify({
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'text', text: ctx.prompt }],
      },
    });
    child.stdin.write(message + '\n');
  }

  // Reattach stdout handler
  ports.attachStdoutHandler(run);

  // Reattach stderr handler
  ports.attachStderrHandler(run);

  run.lastDataReceivedAt = ports.nowMs();
  run.lastStdoutReceivedAt = ports.nowMs();
  ports.startStallWatchdog(run);

  // Restart filesystem monitor for createTeam (launch skips it)
  if (!run.isLaunch) {
    ports.updateProgress(run, 'configuring', 'Waiting for team configuration...');
    run.onProgress(run.progress);
    ports.startFilesystemMonitor(run, run.request);
  } else {
    ports.updateProgress(
      run,
      'configuring',
      run.deterministicBootstrap
        ? 'CLI running - deterministic launch in progress'
        : 'CLI running - reconnecting with teammates'
    );
    run.onProgress(run.progress);
  }

  // Restart timeout
  run.timeoutHandle = ports.setTimeout(() => {
    if (!run.processKilled && !run.provisioningComplete && run.child === child) {
      run.processKilled = true;
      run.finalizingByTimeout = true;
      void (async () => {
        if (!(await terminateAndReleaseAuthRetryRun(run, child, ports, 'timeout'))) {
          return;
        }
        const readyOnTimeout = await ports.tryCompleteAfterTimeout(run).catch(() => false);
        if (readyOnTimeout) return;

        const hint = run.isLaunch ? ' (launch)' : '';
        const progress = ports.updateProgress(run, 'failed', `Timed out waiting for CLI${hint}`, {
          error: `Timed out waiting for CLI${hint}.`,
          cliLogsTail: ports.extractCliLogsFromRun(run),
        });
        run.onProgress(progress);
        ports.cleanupRun(run);
      })();
    }
  }, ports.getProvisioningRunTimeoutMs(run));

  child.once('error', (error) => {
    const hint = run.isLaunch ? ' (launch)' : '';
    run.processKilled = true;
    void (async () => {
      if (await terminateAndReleaseAuthRetryRun(run, child, ports, 'child error')) {
        const progress = ports.updateProgress(run, 'failed', `Failed to start Claude CLI${hint}`, {
          error: error.message,
          cliLogsTail: ports.extractCliLogsFromRun(run),
        });
        run.onProgress(progress);
        ports.cleanupRun(run);
      }
    })();
  });

  child.once('close', (code) => {
    void ports.handleProcessExit(run, code);
  });
}
