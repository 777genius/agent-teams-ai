import { isTerminalProvisioningState } from '../../core/domain';
import {
  buildTeamCreateLaunchAnalyticsContext,
  buildTeamLaunchAnalyticsContext,
  getTeamCreateAnalyticsProviderIds,
  getTeamLaunchAnalyticsStep,
  getTeamLaunchAnalyticsTimestampMs,
  getTeamSnapshotAnalyticsProviderIds,
} from '../../core/domain/teamLaunchAnalyticsPolicy';

import type {
  TeamLaunchAnalyticsContext,
  TeamLaunchAnalyticsCoordinatorDependencies,
} from '../ports/TeamLaunchAnalyticsPorts';
import type { TeamProvisioningLaunchAnalyticsPort } from '../ports/TeamProvisioningLaunchPorts';
import type {
  TeamProvisioningProgressAnalyticsPort,
  TeamProvisioningRefreshFanoutNote,
} from '../ports/TeamProvisioningProgressPorts';
import type { TeamCreateRequest, TeamProvisioningProgress, TeamViewSnapshot } from '@shared/types';

interface TeamLaunchProgressAnalyticsDependencies {
  getTeamData(teamName: string): TeamViewSnapshot | null;
  noteRefreshFanout(note: TeamProvisioningRefreshFanoutNote): void;
}

export class TeamLaunchAnalyticsCoordinator {
  private readonly analyticsByRunId = new Map<string, TeamLaunchAnalyticsContext>();
  private readonly reportedEndRunIds = new Set<string>();
  private readonly reportedStepKeys = new Set<string>();
  private readonly stepStartedAtByKey = new Map<string, number>();
  private readonly nowMs: () => number;

  constructor(private readonly dependencies: TeamLaunchAnalyticsCoordinatorDependencies) {
    this.nowMs = dependencies.nowMs ?? (() => Date.now());
  }

  createLaunchPort(): TeamProvisioningLaunchAnalyticsPort<TeamLaunchAnalyticsContext> {
    return {
      createContext: buildTeamCreateLaunchAnalyticsContext,
      launchContext: buildTeamLaunchAnalyticsContext,
      recordCreateAccepted: (request, runId, context) =>
        this.recordCreateAccepted(request, runId, context),
      recordIpcFailure: (context, error) => this.recordIpcFailure(context, error),
      recordLaunchAccepted: (runId, context) => this.recordLaunchAccepted(runId, context),
    };
  }

  createProgressPort(
    dependencies: TeamLaunchProgressAnalyticsDependencies
  ): TeamProvisioningProgressAnalyticsPort {
    return {
      noteRefreshFanout: (note) => dependencies.noteRefreshFanout(note),
      recordStepTransition: (existingProgress, progress) =>
        this.recordStepTransition(
          existingProgress,
          progress,
          dependencies.getTeamData(progress.teamName)
        ),
      recordTerminalProgress: (progress) =>
        this.recordTerminalProgress(progress, dependencies.getTeamData(progress.teamName)),
    };
  }

  clearRun(runId: string): void {
    this.analyticsByRunId.delete(runId);
    this.clearStepTracking(runId);
    this.reportedEndRunIds.delete(runId);
  }

  reset(): void {
    this.reportedEndRunIds.clear();
    this.reportedStepKeys.clear();
    this.stepStartedAtByKey.clear();
    this.analyticsByRunId.clear();
  }

  recordStepTransition(
    existingProgress: TeamProvisioningProgress | undefined,
    progress: TeamProvisioningProgress,
    data: TeamViewSnapshot | null
  ): void {
    const step = getTeamLaunchAnalyticsStep(progress.state);
    const stepKey = `${progress.runId}:${step}`;
    const progressStartedAtMs =
      getTeamLaunchAnalyticsTimestampMs(progress.startedAt) ?? this.nowMs();
    if (!this.stepStartedAtByKey.has(stepKey) && !isTerminalProvisioningState(progress.state)) {
      this.stepStartedAtByKey.set(stepKey, progressStartedAtMs);
    }
    if (!existingProgress || existingProgress.state === progress.state) return;

    const previousStep = getTeamLaunchAnalyticsStep(existingProgress.state);
    if (previousStep === step && !isTerminalProvisioningState(progress.state)) return;

    const previousStepKey = `${progress.runId}:${previousStep}`;
    if (this.reportedStepKeys.has(previousStepKey)) return;

    const endedAtMs =
      getTeamLaunchAnalyticsTimestampMs(progress.updatedAt) ??
      getTeamLaunchAnalyticsTimestampMs(existingProgress.updatedAt) ??
      this.nowMs();
    const startedAtMs =
      this.stepStartedAtByKey.get(previousStepKey) ??
      getTeamLaunchAnalyticsTimestampMs(existingProgress.updatedAt) ??
      getTeamLaunchAnalyticsTimestampMs(existingProgress.startedAt) ??
      progressStartedAtMs;
    const analyticsContext = this.analyticsByRunId.get(progress.runId) ?? null;
    const providerIds = analyticsContext?.providerIds.length
      ? analyticsContext.providerIds
      : getTeamSnapshotAnalyticsProviderIds(data);
    const failedTransition =
      progress.state === 'failed' ||
      progress.state === 'cancelled' ||
      progress.state === 'disconnected';

    this.reportedStepKeys.add(previousStepKey);
    this.stepStartedAtByKey.delete(previousStepKey);
    this.dependencies.recorder.recordLaunchStepEnd({
      step: previousStep,
      success: !failedTransition,
      durationMs: Math.max(0, endedAtMs - startedAtMs),
      memberCount: analyticsContext?.memberCount ?? data?.members.length ?? null,
      providerIds,
      errorClass: failedTransition
        ? this.dependencies.metrics.classifyError(progress.error ?? progress.message)
        : 'none',
      partialFailure:
        progress.state === 'disconnected' ||
        progress.launchDiagnostics?.some((item) => item.severity === 'error') === true,
    });

    if (!isTerminalProvisioningState(progress.state)) {
      this.stepStartedAtByKey.set(stepKey, endedAtMs);
    }
  }

  recordTerminalProgress(progress: TeamProvisioningProgress, data: TeamViewSnapshot | null): void {
    if (this.reportedEndRunIds.has(progress.runId)) return;
    this.reportedEndRunIds.add(progress.runId);
    const analyticsContext = this.analyticsByRunId.get(progress.runId) ?? null;
    this.analyticsByRunId.delete(progress.runId);
    const success = progress.state === 'ready';
    const partialFailure =
      progress.state === 'disconnected' ||
      progress.launchDiagnostics?.some((item) => item.severity === 'error') === true;
    const fallbackProviderIds = getTeamSnapshotAnalyticsProviderIds(data);

    this.dependencies.recorder.recordLaunchEnd({
      success,
      durationMs: this.dependencies.metrics.elapsedMsBetweenIso(
        progress.startedAt,
        progress.updatedAt
      ),
      memberCount: analyticsContext?.memberCount ?? data?.members.length ?? null,
      providerIds: analyticsContext?.providerIds.length
        ? analyticsContext.providerIds
        : fallbackProviderIds,
      failureReasonClass: success
        ? 'none'
        : this.dependencies.metrics.classifyError(progress.error ?? progress.message),
      partialFailure,
    });
    this.clearStepStartedAt(progress.runId);
  }

  private recordCreateAccepted(
    request: TeamCreateRequest,
    runId: string,
    context: TeamLaunchAnalyticsContext
  ): void {
    this.analyticsByRunId.set(runId, context);
    const providerIds = getTeamCreateAnalyticsProviderIds(request);
    this.dependencies.recorder.recordCreate({
      source: 'dialog',
      memberCount: request.members.length,
      providerIds,
      multimodelEnabled: this.dependencies.metrics.hasMixedProviders(providerIds),
    });
  }

  private recordLaunchAccepted(runId: string, context: TeamLaunchAnalyticsContext): void {
    this.analyticsByRunId.set(runId, context);
  }

  private recordIpcFailure(context: TeamLaunchAnalyticsContext, error: unknown): void {
    this.dependencies.recorder.recordLaunchEnd({
      success: false,
      durationMs: this.dependencies.metrics.elapsedMsSince(context.startedAtMs),
      memberCount: context.memberCount,
      providerIds: context.providerIds,
      failureReasonClass: this.dependencies.metrics.classifyError(error),
      partialFailure: false,
    });
  }

  private clearStepTracking(runId: string): void {
    this.clearStepStartedAt(runId);
    for (const key of this.reportedStepKeys) {
      if (key.startsWith(`${runId}:`)) {
        this.reportedStepKeys.delete(key);
      }
    }
  }

  private clearStepStartedAt(runId: string): void {
    for (const key of this.stepStartedAtByKey.keys()) {
      if (key.startsWith(`${runId}:`)) {
        this.stepStartedAtByKey.delete(key);
      }
    }
  }
}
