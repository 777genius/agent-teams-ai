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

/**
 * EventEmitter cannot await an async close listener. Observe the complete process-exit barrier and
 * retain the run when it rejects: cleanup must not erase ownership while revocation is unconfirmed.
 */
export function observeTeamProvisioningProcessClose<
  TRun extends TeamProvisioningProcessCloseBarrierRun,
>(run: TRun, code: number | null, ports: TeamProvisioningProcessCloseBarrierPorts<TRun>): void {
  void Promise.resolve()
    .then(() => ports.handleProcessExit(run, code))
    .catch((error: unknown) => {
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
    });
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
