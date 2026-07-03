import { buildProgressLiveOutput, buildProgressTraceLine } from '../progressPayload';

import { buildProvisioningTraceDetail } from './TeamProvisioningDiagnosticsHelpers';

import type { TeamProvisioningProgress } from '@shared/types';

const PROVISIONING_TRACE_STORAGE_LIMIT = 500;
const RUNTIME_ADAPTER_RUN_STATE_TTL_MS = 15 * 60_000;
const RUNTIME_ADAPTER_RUN_STATE_SWEEP_INTERVAL_MS = 60_000;

export interface TeamProvisioningRuntimeAdapterProgressMaps {
  runtimeAdapterProgressByRunId: Map<string, TeamProvisioningProgress>;
  runtimeAdapterTraceLinesByRunId: Map<string, string[]>;
  runtimeAdapterTraceKeyByRunId: Map<string, string>;
}

export interface TeamProvisioningRuntimeAdapterProgressStateOptions {
  state: TeamProvisioningRuntimeAdapterProgressMaps;
  retainProvisioningProgress(runId: string, progress: TeamProvisioningProgress): void;
  isRuntimeAdapterRunStateReferenced?(runId: string): boolean;
  runStateTtlMs?: number;
  runStateSweepIntervalMs?: number;
}

export class TeamProvisioningRuntimeAdapterProgressState {
  private lastRuntimeAdapterRunStateSweepAt = 0;

  constructor(private readonly options: TeamProvisioningRuntimeAdapterProgressStateOptions) {}

  enrichRuntimeAdapterProgressTrace(progress: TeamProvisioningProgress): TeamProvisioningProgress {
    const detail = buildProvisioningTraceDetail(progress);
    const key = `${progress.state}\u0000${progress.message}\u0000${detail ?? ''}`;
    const lines = this.options.state.runtimeAdapterTraceLinesByRunId.get(progress.runId) ?? [];
    if (this.options.state.runtimeAdapterTraceKeyByRunId.get(progress.runId) !== key) {
      this.options.state.runtimeAdapterTraceKeyByRunId.set(progress.runId, key);
      lines.push(
        buildProgressTraceLine({
          timestamp: progress.updatedAt,
          state: progress.state,
          message: progress.message,
          detail,
        })
      );
      if (lines.length > PROVISIONING_TRACE_STORAGE_LIMIT) {
        lines.splice(0, lines.length - PROVISIONING_TRACE_STORAGE_LIMIT);
      }
      this.options.state.runtimeAdapterTraceLinesByRunId.set(progress.runId, lines);
    }
    return {
      ...progress,
      assistantOutput: buildProgressLiveOutput(lines, []) ?? progress.assistantOutput,
    };
  }

  setRuntimeAdapterProgress(
    progress: TeamProvisioningProgress,
    onProgress?: (progress: TeamProvisioningProgress) => void
  ): TeamProvisioningProgress {
    const nextProgress = this.enrichRuntimeAdapterProgressTrace(progress);
    this.options.state.runtimeAdapterProgressByRunId.set(nextProgress.runId, nextProgress);
    if (
      nextProgress.state === 'disconnected' ||
      nextProgress.state === 'failed' ||
      nextProgress.state === 'cancelled'
    ) {
      this.options.retainProvisioningProgress(nextProgress.runId, nextProgress);
    }
    this.sweepRuntimeAdapterRunState();
    onProgress?.(nextProgress);
    return nextProgress;
  }

  sweepRuntimeAdapterRunState(nowMs: number = Date.now()): void {
    const sweepIntervalMs =
      this.options.runStateSweepIntervalMs ?? RUNTIME_ADAPTER_RUN_STATE_SWEEP_INTERVAL_MS;
    if (nowMs - this.lastRuntimeAdapterRunStateSweepAt < sweepIntervalMs) {
      return;
    }
    this.lastRuntimeAdapterRunStateSweepAt = nowMs;

    const isReferenced = this.options.isRuntimeAdapterRunStateReferenced ?? (() => true);
    const ttlMs = this.options.runStateTtlMs ?? RUNTIME_ADAPTER_RUN_STATE_TTL_MS;
    for (const [runId, progress] of this.options.state.runtimeAdapterProgressByRunId) {
      if (isReferenced(runId)) {
        continue;
      }
      const updatedAtMs = Date.parse(progress.updatedAt);
      if (Number.isFinite(updatedAtMs) && nowMs - updatedAtMs < ttlMs) {
        continue;
      }
      this.options.retainProvisioningProgress(runId, progress);
      this.options.state.runtimeAdapterProgressByRunId.delete(runId);
      this.options.state.runtimeAdapterTraceLinesByRunId.delete(runId);
      this.options.state.runtimeAdapterTraceKeyByRunId.delete(runId);
    }

    for (const runId of [...this.options.state.runtimeAdapterTraceLinesByRunId.keys()]) {
      if (!this.options.state.runtimeAdapterProgressByRunId.has(runId) && !isReferenced(runId)) {
        this.options.state.runtimeAdapterTraceLinesByRunId.delete(runId);
        this.options.state.runtimeAdapterTraceKeyByRunId.delete(runId);
      }
    }
    for (const runId of [...this.options.state.runtimeAdapterTraceKeyByRunId.keys()]) {
      if (!this.options.state.runtimeAdapterProgressByRunId.has(runId) && !isReferenced(runId)) {
        this.options.state.runtimeAdapterTraceKeyByRunId.delete(runId);
      }
    }
  }
}

export const RUNTIME_ADAPTER_PROVISIONING_TRACE_STORAGE_LIMIT = PROVISIONING_TRACE_STORAGE_LIMIT;
export const RUNTIME_ADAPTER_RUN_STATE_DEFAULT_TTL_MS = RUNTIME_ADAPTER_RUN_STATE_TTL_MS;
export const RUNTIME_ADAPTER_RUN_STATE_DEFAULT_SWEEP_INTERVAL_MS =
  RUNTIME_ADAPTER_RUN_STATE_SWEEP_INTERVAL_MS;
