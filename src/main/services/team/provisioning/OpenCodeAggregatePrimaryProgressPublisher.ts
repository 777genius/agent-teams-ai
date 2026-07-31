import { getErrorMessage } from '@shared/utils/errorHandling';

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
      message,
      updatedAt: nowIso(),
    });
    this.ports.invalidateRuntimeSnapshotCaches(run.teamName);
  }

  publishFailed(run: ProvisioningRun, message: string, error: unknown): void {
    const errorMessage = getErrorMessage(error);
    run.progress = this.publish(run, {
      ...run.progress,
      state: 'failed',
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
