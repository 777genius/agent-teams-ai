import { killProcessTree, killProcessTreeAndWait } from '@main/utils/childProcess';
import { wrapAgentBlock } from '@shared/constants/agentBlocks';

import { boundLaunchDiagnostics, buildProgressLogsTail } from '../progressPayload';

import { buildProvisioningTraceDetail } from './TeamProvisioningDiagnosticsHelpers';
import { buildLaunchDiagnosticsFromRun } from './TeamProvisioningLaunchDiagnostics';
import { extractLogsTail } from './TeamProvisioningLogSlice';
import {
  appendProvisioningTrace,
  buildProvisioningLiveOutput,
} from './TeamProvisioningProgressBuffers';
import { shouldIgnoreProvisioningProgressRegression } from './TeamProvisioningProgressState';

import type { ProvisioningRun } from './TeamProvisioningRunModel';
import type { TeamProvisioningProgress, TeamProvisioningState } from '@shared/types';
import type { ChildProcess } from 'child_process';

const TEAM_PROCESS_EXIT_CONFIRM_TIMEOUT_MS = 5_000;

/**
 * Kill a team CLI process using SIGKILL (uncatchable).
 *
 * Newer Claude CLI versions (>=2.1.x) handle SIGTERM gracefully and run cleanup
 * that deletes team files (config.json, inboxes/, tasks/). SIGKILL prevents this.
 *
 * ALWAYS use this instead of killProcessTree() for team processes.
 * stdin.end() is also forbidden - EOF triggers the same cleanup.
 */
export function killTeamProcess(child: ChildProcess | null | undefined): void {
  if (!child?.pid || child.exitCode != null || child.signalCode != null) {
    return;
  }
  killProcessTree(child, 'SIGKILL');
}

/** Kill the owned team process tree and confirm it is gone before resource release. */
export async function killTeamProcessAndWait(
  child: ChildProcess | null | undefined
): Promise<void> {
  if (!child?.pid) {
    return;
  }

  const rootAlreadyExited = child.exitCode != null || child.signalCode != null;

  // Windows taskkill accepts only a PID. Once Node has observed this exact
  // ChildProcess exit, that PID can already belong to another process and is
  // no longer safe to use as tree ownership. Unix cleanup can still use the
  // birth/process-group identity captured for spawnCli children to terminate
  // surviving descendants without signalling a reused root PID.
  if (rootAlreadyExited) {
    if (process.platform !== 'win32') {
      await killProcessTreeAndWait(child, 'SIGKILL');
    }
    return;
  }

  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  let settled = false;
  let resolveExit!: () => void;
  let rejectExit!: (error: Error) => void;
  const exitConfirmed = new Promise<void>((resolve, reject) => {
    resolveExit = resolve;
    rejectExit = reject;
  });
  const removeListeners = (): void => {
    child.off('close', confirmExit);
    child.off('exit', confirmExit);
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
      timeoutHandle = null;
    }
  };
  const confirmExit = (): void => {
    if (settled) {
      return;
    }
    settled = true;
    removeListeners();
    resolveExit();
  };
  const cancelExitWait = (): void => {
    if (settled) {
      return;
    }
    settled = true;
    removeListeners();
  };

  child.once('close', confirmExit);
  child.once('exit', confirmExit);
  // The process can exit after the initial guard while listeners are being
  // installed. Recheck before delegating to PID-based tree termination so a
  // retained/reused pid is never signalled after this ChildProcess has exited.
  if (child.exitCode != null || child.signalCode != null) {
    confirmExit();
    if (process.platform === 'win32') {
      return;
    }
  } else {
    timeoutHandle = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      removeListeners();
      rejectExit(new Error(`Team process ${child.pid} did not stop after SIGKILL`));
    }, TEAM_PROCESS_EXIT_CONFIRM_TIMEOUT_MS);
  }

  try {
    await Promise.all([killProcessTreeAndWait(child, 'SIGKILL'), exitConfirmed]);
  } catch (error) {
    cancelExitWait();
    throw error;
  }
}

export function nowIso(): string {
  return new Date().toISOString();
}

/** @deprecated Use wrapAgentBlock from @shared/constants/agentBlocks instead. */
export const wrapInAgentBlock = wrapAgentBlock;

export function updateProgress(
  run: ProvisioningRun,
  state: Exclude<TeamProvisioningState, 'idle'>,
  message: string,
  extras?: Pick<
    TeamProvisioningProgress,
    | 'pid'
    | 'error'
    | 'warnings'
    | 'cliLogsTail'
    | 'configReady'
    | 'messageSeverity'
    | 'launchDiagnostics'
  >
): TeamProvisioningProgress {
  if (shouldIgnoreProvisioningProgressRegression(run.progress.state, state)) {
    return run.progress;
  }

  // Cap assistant output on every progress tick. `updateProgress` is invoked
  // from ~20 event-driven sites (auth retries, stall warnings, spawn events),
  // and an unbounded `provisioningOutputParts.join` was part of the same OOM
  // class that `emitLogsProgress` already guards against.
  appendProvisioningTrace(run, state, message, buildProvisioningTraceDetail(extras));
  const assistantOutput = buildProvisioningLiveOutput(run) ?? run.progress.assistantOutput;
  run.progress = {
    ...run.progress,
    state,
    message,
    updatedAt: nowIso(),
    pid: extras?.pid ?? run.progress.pid,
    error: extras?.error,
    warnings: extras?.warnings,
    cliLogsTail: extras?.cliLogsTail ?? run.progress.cliLogsTail,
    assistantOutput,
    configReady: extras?.configReady ?? run.progress.configReady,
    messageSeverity: extras?.messageSeverity,
    launchDiagnostics: boundLaunchDiagnostics(
      extras?.launchDiagnostics ??
        buildLaunchDiagnosticsFromRun(run) ??
        run.progress.launchDiagnostics
    ),
  };
  return run.progress;
}

/**
 * Emit a throttled progress update for the renderer. Payloads are capped to a
 * tail window so that the hot emission path (called every LOG_PROGRESS_THROTTLE_MS
 * under streaming output) cannot accumulate into multi-megabyte IPC messages
 * that would OOM the renderer's Zustand state. The retained in-process
 * diagnostics are separately byte-bounded on append.
 */
export function emitLogsProgress(run: ProvisioningRun): void {
  // Prefer the line-buffered history (already chronological with [stdout]/[stderr]
  // markers) and fall back to the legacy ring-buffer tail only when no lines
  // have been captured yet (early in provisioning).
  const logsTail =
    buildProgressLogsTail(run.claudeLogLines) ??
    extractLogsTail(run.stdoutBuffer, run.stderrBuffer);
  const assistantOutput = buildProvisioningLiveOutput(run);
  const assistantOutputChanged =
    assistantOutput !== undefined && assistantOutput !== run.progress.assistantOutput;

  if (!logsTail && !assistantOutputChanged) {
    return;
  }
  run.progress = {
    ...run.progress,
    updatedAt: nowIso(),
    ...(logsTail !== undefined && { cliLogsTail: logsTail }),
    ...(assistantOutputChanged && { assistantOutput }),
  };
  run.onProgress(run.progress);
}
