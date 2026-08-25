import type {
  AuthWarningSource,
  TeamProvisioningStallWarningRequest,
} from './TeamProvisioningOutputErrorPolicy';
import type { TeamProvisioningProgress, TeamProvisioningState } from '@shared/types';

export type TeamProvisioningOutputRecoverySource = AuthWarningSource;

interface DataStreamLike {
  on(event: 'data', listener: (chunk: Buffer) => void): unknown;
}

interface ProcessLike {
  stdout?: DataStreamLike | null;
  stderr?: DataStreamLike | null;
}

export interface TeamProvisioningOutputRecoveryRun {
  runId: string;
  teamName: string;
  progress: TeamProvisioningProgress;
  stdoutBuffer: string;
  stderrBuffer: string;
  claudeLogLines: string[];
  provisioningOutputParts: string[];
  provisioningOutputIndexByMessageId: Map<string, number>;
  stdoutParserCarry: string;
  stdoutParserCarryIsCompleteJson: boolean;
  stdoutParserCarryLooksLikeClaudeJson: boolean;
  processKilled: boolean;
  cancelRequested: boolean;
  provisioningComplete: boolean;
  child: ProcessLike | null;
  onProgress(progress: TeamProvisioningProgress): void;
  expectedMembers: string[];
  request: TeamProvisioningStallWarningRequest;
  lastLogProgressAt: number;
  lastDataReceivedAt: number;
  lastStdoutReceivedAt: number;
  stallCheckHandle: NodeJS.Timeout | null;
  stallWarningIndex: number | null;
  preStallMessage: string | null;
  lastRetryAt: number;
  apiRetryWarningIndex: number | null;
  apiErrorWarningEmitted: boolean;
  authFailureRetried: boolean;
  authRetryInProgress: boolean;
  isLaunch: boolean;
  memberSpawnStatuses: Map<
    string,
    {
      bootstrapConfirmed?: boolean;
      skippedForLaunch?: boolean;
    }
  >;
}

export interface TeamProvisioningOutputRecoveryLogger {
  warn(message: string, detail?: unknown): void;
  error(message: string, detail?: unknown): void;
}

export interface TeamProvisioningOutputRecoveryPorts<
  TRun extends TeamProvisioningOutputRecoveryRun,
> {
  logger: TeamProvisioningOutputRecoveryLogger;
  nowMs(): number;
  nowIso(): string;
  setInterval(callback: () => void, ms: number): NodeJS.Timeout;
  clearInterval(handle: NodeJS.Timeout): void;
  buildCombinedLogs(stdoutBuffer: string, stderrBuffer: string): string;
  extractApiErrorSnippet(text: string): string | null;
  hasApiError(text: string): boolean;
  isAuthFailureWarning(text: string, source: TeamProvisioningOutputRecoverySource): boolean;
  buildStallWarningText(silenceSec: number, request: TRun['request']): string;
  buildStallProgressMessage(silenceSec: number, elapsed: string): string;
  boundStdoutParserCarry(carry: string): string;
  looksLikeClaudeStdoutJsonFragment(text: string): boolean;
  boundRunProvisioningOutputParts(run: TRun): void;
  buildProvisioningLiveOutput(run: TRun): string | undefined;
  extractCliLogsFromRun(run: TRun): string | undefined;
  updateProgress(
    run: TRun,
    state: Exclude<TeamProvisioningState, 'idle'>,
    message: string,
    extras?: Pick<TeamProvisioningProgress, 'error' | 'cliLogsTail' | 'pid'>
  ): TeamProvisioningProgress;
  emitLogsProgress(run: TRun): void;
  killTeamProcess(child: TRun['child']): void;
  cleanupRun(run: TRun): void;
  respawnAfterAuthFailure(run: TRun): Promise<void>;
  appendCliLogs(run: TRun, stream: 'stdout' | 'stderr', text: string): void;
  handleStreamJsonMessage(run: TRun, msg: Record<string, unknown>): void;
  shiftProvisioningOutputIndexesAfterRemoval(run: TRun, removedIndex: number): void;
}

export interface TeamProvisioningOutputRecoveryOptions {
  stderrRingLimit: number;
  stdoutRingLimit: number;
  logProgressThrottleMs: number;
  stallCheckIntervalMs: number;
  stallWarningThresholdMs: number;
  preflightAuthRetryDelayMs: number;
}

export interface TeamProvisioningOutputRecoveryHelper<
  TRun extends TeamProvisioningOutputRecoveryRun,
> {
  failProvisioningWithApiError(run: TRun, source: string): void;
  emitApiErrorWarning(run: TRun, text: string): void;
  startStallWatchdog(run: TRun): void;
  stopStallWatchdog(run: TRun): void;
  handleAuthFailureInOutput(
    run: TRun,
    text: string,
    source: TeamProvisioningOutputRecoverySource
  ): void;
  attachStdoutHandler(run: TRun): void;
  updateStdoutParserCarry(run: TRun, carry: string): void;
  flushStdoutParserCarry(run: TRun): void;
  buildStdoutCarryDiagnostic(run: TRun): Record<string, unknown>;
  getUnconfirmedBootstrapMemberNames(run: TRun): string[];
  handleStdoutParserLine(run: TRun, trimmed: string): void;
  handleParsedStdoutJsonMessage(run: TRun, msg: Record<string, unknown>): void;
  attachStderrHandler(run: TRun): void;
}

export function createTeamProvisioningOutputRecoveryHelper<
  TRun extends TeamProvisioningOutputRecoveryRun,
>(
  ports: TeamProvisioningOutputRecoveryPorts<TRun>,
  options: TeamProvisioningOutputRecoveryOptions
): TeamProvisioningOutputRecoveryHelper<TRun> {
  const helper: TeamProvisioningOutputRecoveryHelper<TRun> = {
    failProvisioningWithApiError(run, source) {
      if (run.provisioningComplete || run.processKilled || run.authRetryInProgress) return;
      if (run.progress.state === 'failed' || run.cancelRequested) return;

      const combined = [
        ports.buildCombinedLogs(run.stdoutBuffer, run.stderrBuffer),
        run.provisioningOutputParts.length > 0 ? run.provisioningOutputParts.join('\n') : '',
      ]
        .filter(Boolean)
        .join('\n')
        .trim();

      const snippet =
        ports.extractApiErrorSnippet(combined) ?? ports.extractApiErrorSnippet(source) ?? null;
      const status =
        /api error:\s*(\d{3})\b/i.exec(combined)?.[1] ??
        /api error:\s*(\d{3})\b/i.exec(source)?.[1];

      const hint = run.isLaunch ? 'Launch' : 'Provisioning';
      const statusLabel = status ? `API Error ${status}` : 'API Error';
      if (snippet) {
        run.provisioningOutputParts.push(
          `**${hint} failed: ${statusLabel} detected**\n\n\`\`\`\n${snippet}\n\`\`\``
        );
      } else {
        run.provisioningOutputParts.push(`**${hint} failed: ${statusLabel} detected**`);
      }
      ports.boundRunProvisioningOutputParts(run);

      const progress = ports.updateProgress(run, 'failed', `${hint} failed — ${statusLabel}`, {
        error: `Claude CLI reported ${statusLabel} during startup. The team was not started.`,
        cliLogsTail: ports.extractCliLogsFromRun(run),
      });
      run.onProgress(progress);

      run.processKilled = true;
      run.cancelRequested = true;
      ports.killTeamProcess(run.child);
      ports.cleanupRun(run);
    },

    emitApiErrorWarning(run, text) {
      if (run.provisioningComplete || run.processKilled || run.authRetryInProgress) return;
      if (run.progress.state === 'failed' || run.cancelRequested) return;
      if (run.apiErrorWarningEmitted) return;

      run.apiErrorWarningEmitted = true;

      const snippet = ports.extractApiErrorSnippet(text);
      const status = /api error:\s*(\d{3})\b/i.exec(text)?.[1] ?? null;
      const label = status ? `API Error ${status}` : 'API Error';

      const warningText = snippet
        ? `**${label} — SDK is retrying**\n\n\`\`\`\n${snippet}\n\`\`\`\n\nWaiting for retry...`
        : `**${label} — SDK is retrying**\n\nWaiting for retry...`;

      run.provisioningOutputParts.push(warningText);
      ports.boundRunProvisioningOutputParts(run);
      run.progress.message = `${label} — SDK retrying...`;
      ports.emitLogsProgress(run);
      run.lastLogProgressAt = ports.nowMs();
    },

    startStallWatchdog(run) {
      if (run.stallCheckHandle) return;

      run.stallCheckHandle = ports.setInterval(() => {
        try {
          if (
            run.provisioningComplete ||
            run.processKilled ||
            run.cancelRequested ||
            run.authRetryInProgress
          ) {
            helper.stopStallWatchdog(run);
            return;
          }

          const now = ports.nowMs();
          const silenceMs = now - run.lastStdoutReceivedAt;

          if (silenceMs < options.stallWarningThresholdMs) return;

          const silenceSec = Math.round(silenceMs / 1000);
          const warningText = ports.buildStallWarningText(silenceSec, run.request);

          if (run.stallWarningIndex != null) {
            run.provisioningOutputParts[run.stallWarningIndex] = warningText;
          } else {
            if (run.progress.messageSeverity !== 'error') {
              run.preStallMessage = run.progress.message;
            }
            run.stallWarningIndex = run.provisioningOutputParts.length;
            run.provisioningOutputParts.push(warningText);
            ports.boundRunProvisioningOutputParts(run);
          }

          const mins = Math.floor(silenceSec / 60);
          const secs = silenceSec % 60;
          const elapsed = mins > 0 ? (secs > 0 ? `${mins}m ${secs}s` : `${mins}m`) : `${secs}s`;

          const retryActive = run.lastRetryAt > 0 && now - run.lastRetryAt < 90_000;

          run.progress = {
            ...run.progress,
            updatedAt: ports.nowIso(),
            ...(!retryActive && {
              message: ports.buildStallProgressMessage(silenceSec, elapsed),
              messageSeverity: 'warning' as const,
            }),
            assistantOutput: ports.buildProvisioningLiveOutput(run) ?? run.progress.assistantOutput,
          };
          run.onProgress(run.progress);
        } catch (err) {
          ports.logger.error(
            `[${run.teamName}] Stall watchdog error: ${
              err instanceof Error ? err.message : String(err)
            }`
          );
        }
      }, options.stallCheckIntervalMs);
    },

    stopStallWatchdog(run) {
      if (run.stallCheckHandle) {
        ports.clearInterval(run.stallCheckHandle);
        run.stallCheckHandle = null;
      }
    },

    handleAuthFailureInOutput(run, text, source) {
      if (run.provisioningComplete || run.processKilled || run.authRetryInProgress) return;
      if (!ports.isAuthFailureWarning(text, source)) return;

      if (!run.authFailureRetried) {
        ports.logger.warn(
          `[${run.teamName}] Auth failure detected in ${source} during provisioning — ` +
            `will kill process and retry after ${options.preflightAuthRetryDelayMs}ms`
        );
        run.authRetryInProgress = true;
        void ports.respawnAfterAuthFailure(run);
      } else {
        ports.logger.error(
          `[${run.teamName}] Auth failure detected in ${source} after retry — giving up`
        );
        run.processKilled = true;
        ports.killTeamProcess(run.child);
        const progress = ports.updateProgress(
          run,
          'failed',
          'Authentication failed — CLI requires login',
          {
            error:
              'Claude CLI is not authenticated. Run `claude auth login` (or start `claude` and run `/login`) ' +
              'to authenticate, or set ANTHROPIC_API_KEY and try again.',
            cliLogsTail: ports.extractCliLogsFromRun(run),
          }
        );
        run.onProgress(progress);
        ports.cleanupRun(run);
      }
    },

    attachStdoutHandler(run) {
      const child = run.child;
      if (!child?.stdout) return;

      let stdoutLineBuf = '';
      child.stdout.on('data', (chunk: Buffer) => {
        run.lastDataReceivedAt = ports.nowMs();

        const text = chunk.toString('utf8');
        ports.appendCliLogs(run, 'stdout', text);
        run.stdoutBuffer += text;
        if (run.stdoutBuffer.length > options.stdoutRingLimit) {
          run.stdoutBuffer = run.stdoutBuffer.slice(
            run.stdoutBuffer.length - options.stdoutRingLimit
          );
        }

        stdoutLineBuf += text;
        const lines = stdoutLineBuf.split('\n');
        stdoutLineBuf = ports.boundStdoutParserCarry(lines.pop() ?? '');
        helper.updateStdoutParserCarry(run, stdoutLineBuf);
        for (const line of lines) {
          const trimmed = line.trim();
          helper.handleStdoutParserLine(run, trimmed);
        }

        const currentTs = ports.nowMs();
        if (currentTs - run.lastLogProgressAt >= options.logProgressThrottleMs) {
          run.lastLogProgressAt = currentTs;
          ports.emitLogsProgress(run);
        }
      });
    },

    updateStdoutParserCarry(run, carry) {
      const boundedCarry = ports.boundStdoutParserCarry(carry);
      run.stdoutParserCarry = boundedCarry;
      const trimmedCarry = boundedCarry.trim();
      if (!trimmedCarry) {
        run.stdoutParserCarryIsCompleteJson = false;
        run.stdoutParserCarryLooksLikeClaudeJson = false;
        return;
      }

      try {
        JSON.parse(trimmedCarry);
        run.stdoutParserCarryIsCompleteJson = true;
      } catch {
        run.stdoutParserCarryIsCompleteJson = false;
      }
      run.stdoutParserCarryLooksLikeClaudeJson =
        ports.looksLikeClaudeStdoutJsonFragment(trimmedCarry);
    },

    flushStdoutParserCarry(run) {
      const stdoutParserCarry =
        typeof run.stdoutParserCarry === 'string' ? run.stdoutParserCarry : '';
      const trimmed = stdoutParserCarry.trim();
      if (!trimmed || !run.stdoutParserCarryIsCompleteJson) {
        return;
      }

      ports.logger.warn(
        `[${run.teamName}] Flushing final stream-json stdout carry before process close handling`,
        helper.buildStdoutCarryDiagnostic(run)
      );
      helper.handleStdoutParserLine(run, trimmed);
      helper.updateStdoutParserCarry(run, '');
    },

    buildStdoutCarryDiagnostic(run) {
      const stdoutParserCarry =
        typeof run.stdoutParserCarry === 'string' ? run.stdoutParserCarry : '';
      const diagnostic: Record<string, unknown> = {
        runId: run.runId,
        stdoutCarryLength: stdoutParserCarry.length,
        stdoutCarryCompleteJson: run.stdoutParserCarryIsCompleteJson === true,
        stdoutCarryLooksLikeClaudeJson: run.stdoutParserCarryLooksLikeClaudeJson === true,
      };

      if (run.stdoutParserCarryIsCompleteJson === true) {
        try {
          const parsed = JSON.parse(stdoutParserCarry.trim()) as Record<string, unknown>;
          diagnostic.messageType = typeof parsed.type === 'string' ? parsed.type : null;
          diagnostic.messageSubtype = typeof parsed.subtype === 'string' ? parsed.subtype : null;
          diagnostic.bootstrapEvent = typeof parsed.event === 'string' ? parsed.event : null;
          diagnostic.sequence = typeof parsed.seq === 'number' ? parsed.seq : null;
        } catch {
          diagnostic.messageType = null;
        }
      }

      return diagnostic;
    },

    getUnconfirmedBootstrapMemberNames(run) {
      return run.expectedMembers.filter((expected) => {
        const status = run.memberSpawnStatuses.get(expected);
        return status?.bootstrapConfirmed !== true && status?.skippedForLaunch !== true;
      });
    },

    handleStdoutParserLine(run, trimmed) {
      if (!trimmed) {
        return;
      }

      try {
        const msg = JSON.parse(trimmed) as Record<string, unknown>;
        helper.handleParsedStdoutJsonMessage(run, msg);
      } catch {
        helper.handleAuthFailureInOutput(run, trimmed, 'stdout');
        if (ports.hasApiError(trimmed) && !ports.isAuthFailureWarning(trimmed, 'stdout')) {
          helper.emitApiErrorWarning(run, trimmed);
        }
      }
    },

    handleParsedStdoutJsonMessage(run, msg) {
      const msgType = msg.type;
      if (msgType === 'assistant' || msgType === 'result') {
        run.lastStdoutReceivedAt = ports.nowMs();
        if (run.stallWarningIndex != null) {
          const removedIndex = run.stallWarningIndex;
          run.provisioningOutputParts.splice(removedIndex, 1);
          ports.shiftProvisioningOutputIndexesAfterRemoval(run, removedIndex);
          run.stallWarningIndex = null;
          if (run.preStallMessage != null) {
            run.progress.message = run.preStallMessage;
            run.preStallMessage = null;
            delete run.progress.messageSeverity;
          }
        }
      }
      ports.handleStreamJsonMessage(run, msg);
    },

    attachStderrHandler(run) {
      const child = run.child;
      if (!child?.stderr) return;

      child.stderr.on('data', (chunk: Buffer) => {
        run.lastDataReceivedAt = ports.nowMs();
        const text = chunk.toString('utf8');
        ports.appendCliLogs(run, 'stderr', text);
        run.stderrBuffer += text;
        if (run.stderrBuffer.length > options.stderrRingLimit) {
          run.stderrBuffer = run.stderrBuffer.slice(
            run.stderrBuffer.length - options.stderrRingLimit
          );
        }

        helper.handleAuthFailureInOutput(run, text, 'stderr');
        if (ports.hasApiError(text) && !ports.isAuthFailureWarning(text, 'stderr')) {
          helper.emitApiErrorWarning(run, text);
        }

        const currentTs = ports.nowMs();
        if (currentTs - run.lastLogProgressAt >= options.logProgressThrottleMs) {
          run.lastLogProgressAt = currentTs;
          ports.emitLogsProgress(run);
        }
      });
    },
  };

  return helper;
}
