import type { TeamProvisioningProgress } from '@shared/types';

export const RETAINED_PROVISIONING_PROGRESS_TTL_MS = 5 * 60_000;

export interface RetainedProvisioningProgressRunLike {
  progress: TeamProvisioningProgress;
}

export interface TeamProvisioningRetainedProgressStateOptions {
  runtimeAdapterProgressByRunId: Map<string, TeamProvisioningProgress>;
  runtimeAdapterTraceLinesByRunId: Map<string, string[]>;
  runtimeAdapterTraceKeyByRunId: Map<string, string>;
  ttlMs?: number;
  setTimeout?: (handler: () => void, timeoutMs: number) => ReturnType<typeof setTimeout>;
  clearTimeout?: (timer: ReturnType<typeof setTimeout>) => void;
}

export class TeamProvisioningRetainedProgressState {
  private readonly retainedProvisioningProgressByRunId = new Map<string, TeamProvisioningProgress>();
  private readonly retainedProvisioningProgressTimersByRunId = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();

  constructor(private readonly options: TeamProvisioningRetainedProgressStateOptions) {}

  getProvisioningStatus(
    runId: string,
    runs: ReadonlyMap<string, RetainedProvisioningProgressRunLike>
  ): TeamProvisioningProgress {
    const run = runs.get(runId);
    if (run) {
      return run.progress;
    }
    const runtimeProgress = this.options.runtimeAdapterProgressByRunId.get(runId);
    if (runtimeProgress) {
      return runtimeProgress;
    }
    const retainedProgress = this.retainedProvisioningProgressByRunId.get(runId);
    if (retainedProgress) {
      return retainedProgress;
    }
    throw new Error('Unknown runId');
  }

  getRetainedProvisioningProgressMap(): Map<string, TeamProvisioningProgress> {
    return this.retainedProvisioningProgressByRunId;
  }

  retainProvisioningProgress(runId: string, progress: TeamProvisioningProgress): void {
    const previousTimer = this.retainedProvisioningProgressTimersByRunId.get(runId);
    if (previousTimer) {
      (this.options.clearTimeout ?? clearTimeout)(previousTimer);
    }

    this.retainedProvisioningProgressByRunId.set(runId, {
      ...progress,
      warnings: progress.warnings ? [...progress.warnings] : undefined,
      launchDiagnostics: progress.launchDiagnostics ? [...progress.launchDiagnostics] : undefined,
    });

    const timer = (this.options.setTimeout ?? setTimeout)(() => {
      this.retainedProvisioningProgressByRunId.delete(runId);
      this.retainedProvisioningProgressTimersByRunId.delete(runId);
      // Adapter-run live progress and trace history share the retention
      // window (native run ids are simply absent from these maps). Only a
      // still-terminal entry may be dropped - a relaunch may have reused the
      // run id for a live run in the meantime.
      const liveProgress = this.options.runtimeAdapterProgressByRunId.get(runId);
      if (liveProgress && isTerminalFailureProvisioningState(liveProgress.state)) {
        this.options.runtimeAdapterProgressByRunId.delete(runId);
        this.options.runtimeAdapterTraceLinesByRunId.delete(runId);
        this.options.runtimeAdapterTraceKeyByRunId.delete(runId);
      }
    }, this.options.ttlMs ?? RETAINED_PROVISIONING_PROGRESS_TTL_MS);
    timer.unref?.();
    this.retainedProvisioningProgressTimersByRunId.set(runId, timer);
  }
}

/**
 * Heuristic: does this raw CLI stdout chunk look like a Claude stream-json
 * fragment (an object/array carrying one of the stream-json shape keys)?
 */
export function looksLikeClaudeStdoutJsonFragment(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
    return false;
  }
  return (
    /"type"\s*:/.test(trimmed) ||
    /"message"\s*:/.test(trimmed) ||
    /"content"\s*:/.test(trimmed) ||
    /"subtype"\s*:/.test(trimmed) ||
    /"session_id"\s*:/.test(trimmed)
  );
}

export function isTerminalFailureProvisioningState(
  state: TeamProvisioningProgress['state']
): boolean {
  return state === 'failed' || state === 'cancelled' || state === 'disconnected';
}

/**
 * Guards against progress regressions that would move a run backwards out of a
 * settled state: a `ready` run may only stay ready or disconnect, and a
 * terminal-failure run may not flip to a different state.
 */
export function shouldIgnoreProvisioningProgressRegression(
  currentState: TeamProvisioningProgress['state'],
  nextState: TeamProvisioningProgress['state']
): boolean {
  if (currentState === 'ready') {
    return nextState !== 'ready' && nextState !== 'disconnected';
  }
  if (isTerminalFailureProvisioningState(currentState)) {
    return nextState !== currentState;
  }
  return false;
}
