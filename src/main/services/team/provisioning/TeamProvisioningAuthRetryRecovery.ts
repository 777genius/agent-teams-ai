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

export interface TeamProvisioningAuthRetryRun extends TeamProvisioningOutputRecoveryRun {
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
  killTeamProcess(child: ChildProcess | null): void;
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

export async function respawnCliAfterAuthFailure<TRun extends TeamProvisioningAuthRetryRun>(
  run: TRun,
  ports: TeamProvisioningAuthRetryPorts<TRun>,
  options: TeamProvisioningAuthRetryOptions
): Promise<void> {
  const ctx = run.spawnContext;
  const stopAllGenerationAtStart = ports.getStopAllTeamsGeneration();
  if (!ctx) {
    ports.logger.error(`[${run.teamName}] Cannot respawn - no spawn context saved`);
    run.authRetryInProgress = false;
    return;
  }

  // Tear down current process without full cleanupRun (keep run alive)
  if (run.timeoutHandle) {
    ports.clearTimeout(run.timeoutHandle);
    run.timeoutHandle = null;
  }
  ports.stopFilesystemMonitor(run);
  ports.stopStallWatchdog(run);
  if (run.child) {
    run.child.stdout?.removeAllListeners('data');
    run.child.stderr?.removeAllListeners('data');
    run.child.removeAllListeners('error');
    run.child.removeAllListeners('exit');
    run.child.removeAllListeners('close');
    ports.killTeamProcess(run.child);
    run.child = null;
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
    run.authRetryInProgress = false;
    return;
  }

  // Verify --mcp-config still exists; regenerate if deleted (e.g. by stale GC)
  const mcpFlagIdx = ctx.args.indexOf('--mcp-config');
  const bootstrapPromptFlagIdx = ctx.args.indexOf('--team-bootstrap-user-prompt-file');
  if (mcpFlagIdx !== -1 && mcpFlagIdx + 1 < ctx.args.length) {
    const existingConfigPath = ctx.args[mcpFlagIdx + 1];
    if (!(await ports.pathExists(existingConfigPath))) {
      ports.logger.warn(`[${run.teamName}] MCP config ${existingConfigPath} missing, regenerating`);
      try {
        const newConfigPath = await ports.mcpConfigBuilder.writeConfigFile(ctx.cwd, {
          controlApiBaseUrl: ctx.env.CLAUDE_TEAM_CONTROL_URL,
        });
        ctx.args[mcpFlagIdx + 1] = newConfigPath;
        run.mcpConfigPath = newConfigPath;
        ports.logger.info(`[${run.teamName}] Regenerated MCP config at ${newConfigPath}`);
      } catch (regenErr) {
        run.authRetryInProgress = false;
        const progress = ports.updateProgress(run, 'failed', 'Failed to regenerate MCP config', {
          error: regenErr instanceof Error ? regenErr.message : String(regenErr),
          cliLogsTail: ports.extractCliLogsFromRun(run),
        });
        run.onProgress(progress);
        ports.cleanupRun(run);
        return;
      }
    }
  }

  if (bootstrapPromptFlagIdx !== -1 && bootstrapPromptFlagIdx + 1 < ctx.args.length) {
    const existingPromptPath = ctx.args[bootstrapPromptFlagIdx + 1];
    if (!(await ports.pathExists(existingPromptPath))) {
      const submissionState = await ports.readBootstrapRealTaskSubmissionState(run.teamName);
      if (submissionState === 'submitted') {
        ctx.args.splice(bootstrapPromptFlagIdx, 2);
        ctx.prompt = '';
        run.bootstrapUserPromptPath = null;
      } else if (submissionState === 'unknown') {
        run.authRetryInProgress = false;
        const progress = ports.updateProgress(
          run,
          'failed',
          'Unable to safely retry first task after auth failure',
          {
            error:
              'deterministic bootstrap recorded the first real task as unknown, so retry would risk a duplicate submission',
            cliLogsTail: ports.extractCliLogsFromRun(run),
          }
        );
        run.onProgress(progress);
        ports.cleanupRun(run);
        return;
      } else if (ctx.prompt.trim().length === 0) {
        run.authRetryInProgress = false;
        const progress = ports.updateProgress(
          run,
          'failed',
          'Failed to restore deferred first task after auth retry',
          {
            error:
              'deterministic bootstrap user prompt file was missing and no prompt was available to regenerate it',
            cliLogsTail: ports.extractCliLogsFromRun(run),
          }
        );
        run.onProgress(progress);
        ports.cleanupRun(run);
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
          run.authRetryInProgress = false;
          const progress = ports.updateProgress(
            run,
            'failed',
            'Failed to regenerate deferred first task for auth retry',
            {
              error: regenErr instanceof Error ? regenErr.message : String(regenErr),
              cliLogsTail: ports.extractCliLogsFromRun(run),
            }
          );
          run.onProgress(progress);
          ports.cleanupRun(run);
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
    run.authRetryInProgress = false;
    const progress = ports.updateProgress(run, 'failed', 'Failed to respawn Claude CLI', {
      error: error instanceof Error ? error.message : String(error),
    });
    run.onProgress(progress);
    ports.cleanupRun(run);
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
    if (!run.processKilled && !run.provisioningComplete) {
      run.processKilled = true;
      run.finalizingByTimeout = true;
      void (async () => {
        const readyOnTimeout = await ports.tryCompleteAfterTimeout(run);
        ports.killTeamProcess(run.child);
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
    const progress = ports.updateProgress(run, 'failed', `Failed to start Claude CLI${hint}`, {
      error: error.message,
      cliLogsTail: ports.extractCliLogsFromRun(run),
    });
    run.onProgress(progress);
    ports.cleanupRun(run);
  });

  child.once('close', (code) => {
    void ports.handleProcessExit(run, code);
  });
}
