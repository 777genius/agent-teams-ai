import { getErrorMessage } from '@shared/utils/errorHandling';

import { OpenCodeRetainedPrimaryRestartError } from './OpenCodeRetainedPrimaryRestartError';
import { nowIso } from './TeamProvisioningRunProgress';

import type { ProvisioningRun } from './TeamProvisioningRunModel';

export interface OpenCodeAggregatePrimaryProgressPublisherPorts {
  usesRetainedProgressState(): boolean;
  setRuntimeAdapterProgress(
    progress: ProvisioningRun['progress'],
    onProgress: ProvisioningRun['onProgress']
  ): ProvisioningRun['progress'];
  enrichRuntimeAdapterProgressTrace(
    progress: ProvisioningRun['progress']
  ): ProvisioningRun['progress'];
  rememberProgress(progress: ProvisioningRun['progress']): void;
  invalidateRuntimeSnapshotCaches(teamName: string): void;
}

export class OpenCodeAggregatePrimaryProgressPublisher {
  constructor(private readonly ports: OpenCodeAggregatePrimaryProgressPublisherPorts) {}

  publishPending(run: ProvisioningRun, message: string): void {
    run.progress = this.publish(run, {
      ...run.progress,
      state: 'disconnected',
      retainedSecondaryRuntime: undefined,
      message,
      updatedAt: nowIso(),
    });
    this.ports.invalidateRuntimeSnapshotCaches(run.teamName);
  }

  /**
   * Clears the pending banner an automatic re-bootstrap raised. Without it a
   * heal that succeeded leaves the team showing "disconnected" until the next
   * unrelated progress write, which reads as a failure the user never had.
   */
  publishReady(run: ProvisioningRun, message: string): void {
    run.progress = this.publish(run, {
      ...run.progress,
      state: 'ready',
      retainedSecondaryRuntime: undefined,
      message,
      messageSeverity: undefined,
      updatedAt: nowIso(),
      error: undefined,
    });
    this.ports.invalidateRuntimeSnapshotCaches(run.teamName);
  }

  publishRestoredPrimary(run: ProvisioningRun, error: unknown): void {
    run.progress = this.ports.setRuntimeAdapterProgress(
      {
        ...run.progress,
        state: 'ready',
        retainedSecondaryRuntime: undefined,
        message: 'OpenCode member restart failed; original primary lane was restored',
        messageSeverity: 'warning',
        updatedAt: nowIso(),
        error: undefined,
        cliLogsTail: getErrorMessage(error),
      },
      run.onProgress
    );
  }

  publishFailed(run: ProvisioningRun, message: string, error: unknown): void {
    const errorMessage = getErrorMessage(error);
    run.progress = this.publish(run, {
      ...run.progress,
      state: 'failed',
      retainedSecondaryRuntime:
        error instanceof OpenCodeRetainedPrimaryRestartError && error.outcome === 'failed_retained'
          ? true
          : undefined,
      message,
      messageSeverity: 'error',
      updatedAt: nowIso(),
      error: errorMessage,
      cliLogsTail: errorMessage,
    });
    this.ports.invalidateRuntimeSnapshotCaches(run.teamName);
  }

  private publish(
    run: ProvisioningRun,
    progress: ProvisioningRun['progress']
  ): ProvisioningRun['progress'] {
    if (this.ports.usesRetainedProgressState()) {
      return this.ports.setRuntimeAdapterProgress(progress, run.onProgress);
    }
    const nextProgress = this.ports.enrichRuntimeAdapterProgressTrace(progress);
    this.ports.rememberProgress(nextProgress);
    run.onProgress?.(nextProgress);
    return nextProgress;
  }
}
