import type { TeamProvisioningProgress, TeamProvisioningState } from '@shared/types';

export interface TeamProvisioningProcessCloseBarrierRun {
  teamName: string;
  progress: TeamProvisioningProgress;
  onProgress(progress: TeamProvisioningProgress): void;
}

export interface TeamProvisioningProcessCloseBarrierPorts<
  TRun extends TeamProvisioningProcessCloseBarrierRun,
> {
  handleProcessExit(run: TRun, code: number | null): Promise<void>;
  updateProgress(
    run: TRun,
    state: Exclude<TeamProvisioningState, 'idle'>,
    message: string,
    extras?: Pick<TeamProvisioningProgress, 'error' | 'cliLogsTail'>
  ): TeamProvisioningProgress;
  extractCliLogsFromRun(run: TRun): string | undefined;
  logger: { error?(message: string): void };
}

export interface TeamProvisioningRunFinalizationArbiter {
  run(finalizer: () => Promise<void>): Promise<void>;
  observe(finalizer: () => Promise<void>, onRejected: (error: unknown) => void): void;
}

const reportedBarrierRejections = new WeakSet<object>();

/**
 * Child timeout/error/close signals race in the same event-loop window. Give one signal ownership
 * of finalization and make the others await that exact attempt. A rejected attempt is evicted so a
 * retained owner or later signal can retry; a successful attempt remains idempotent.
 */
export function createTeamProvisioningRunFinalizationArbiter(): TeamProvisioningRunFinalizationArbiter {
  let completed = false;
  let inFlight: Promise<void> | null = null;

  const run = (finalizer: () => Promise<void>): Promise<void> => {
    if (completed) return Promise.resolve();
    if (inFlight) return inFlight;

    const attempt = Promise.resolve().then(finalizer);
    inFlight = attempt;
    void attempt.then(
      () => {
        completed = true;
        inFlight = null;
      },
      () => {
        if (inFlight === attempt) inFlight = null;
      }
    );
    return attempt;
  };

  return {
    run,
    observe(finalizer, onRejected) {
      void run(finalizer).catch((error: unknown) => {
        try {
          onRejected(error);
        } catch {
          // The finalization rejection remains observed when diagnostic routing is unavailable.
        }
      });
    },
  };
}

/** Retain the run when the complete process-exit barrier rejects. */
export async function awaitTeamProvisioningProcessCloseBarrier<
  TRun extends TeamProvisioningProcessCloseBarrierRun,
>(
  run: TRun,
  code: number | null,
  ports: TeamProvisioningProcessCloseBarrierPorts<TRun>
): Promise<boolean> {
  try {
    await ports.handleProcessExit(run, code);
    return true;
  } catch (error) {
    if (!reportedBarrierRejections.has(run)) {
      reportedBarrierRejections.add(run);
      const detail = error instanceof Error ? error.message : String(error);
      safeLogError(
        ports,
        `[${run.teamName}] Process-close failure barrier rejected; retaining run ownership: ${detail}`
      );
      try {
        const progress = ports.updateProgress(
          run,
          'failed',
          'Process closed before the failure barrier completed',
          {
            error:
              'The process exited, but its lifecycle failure barrier could not be confirmed. The run remains tracked so cleanup can be retried safely.',
            cliLogsTail: ports.extractCliLogsFromRun(run),
          }
        );
        run.onProgress(progress);
      } catch (reportingError) {
        safeLogError(
          ports,
          `[${run.teamName}] Failed to report process-close barrier rejection: ${
            reportingError instanceof Error ? reportingError.message : String(reportingError)
          }`
        );
      }
    }
    return false;
  }
}

function safeLogError<TRun extends TeamProvisioningProcessCloseBarrierRun>(
  ports: TeamProvisioningProcessCloseBarrierPorts<TRun>,
  message: string
): void {
  try {
    ports.logger.error?.(message);
  } catch {
    // The process-close promise is fully observed even when diagnostic reporting is unavailable.
  }
}
