import { createLogger } from '@shared/utils/logger';
import { getTaskDisplayId } from '@shared/utils/taskIdentity';

import {
  getTeamTaskStallActivationGraceMs,
  getTeamTaskStallScanIntervalMs,
  getTeamTaskStallStartupGraceMs,
  isOpenCodeTaskStallRemediationEnabled,
  isTeamTaskStallAlertsEnabled,
  isTeamTaskStallMonitorEnabled,
  isTeamTaskStallScannerEnabled,
} from './featureGates';

import type { ActiveTeamRegistry } from './ActiveTeamRegistry';
import type { TeamTaskStallJournal } from './TeamTaskStallJournal';
import type { TeamTaskStallNotifier } from './TeamTaskStallNotifier';
import type { TeamTaskStallPolicy } from './TeamTaskStallPolicy';
import type { TeamTaskStallSnapshotSource } from './TeamTaskStallSnapshotSource';
import type { TaskStallAlert, TaskStallEvaluation } from './TeamTaskStallTypes';
import type { TeamChangeEvent } from '@shared/types';

const logger = createLogger('Service:TeamTaskStallMonitor');

interface TeamObservationState {
  firstSeenAtMs: number;
  lastActivationAtMs: number;
}

interface TeamTaskStallMonitorOptions {
  scanTimeoutMs?: number;
}

interface TeamTaskStallScanRun {
  cancelled: boolean;
}

const DEFAULT_TEAM_TASK_STALL_SCAN_TIMEOUT_MS = 2 * 60_000;

function unrefBackgroundTimer(timer: ReturnType<typeof setTimeout>): void {
  const maybeTimer = timer as { unref?: () => void };
  maybeTimer.unref?.();
}

export class TeamTaskStallMonitor {
  private scanTimer: ReturnType<typeof setTimeout> | null = null;
  private nudgeTimer: ReturnType<typeof setTimeout> | null = null;
  private scanInFlight = false;
  private started = false;
  private readonly observationByTeam = new Map<string, TeamObservationState>();
  private readonly scanTimeoutMs: number;

  constructor(
    private readonly registry: ActiveTeamRegistry,
    private readonly snapshotSource: TeamTaskStallSnapshotSource,
    private readonly policy: TeamTaskStallPolicy,
    private readonly journal: TeamTaskStallJournal,
    private readonly notifier: TeamTaskStallNotifier,
    options: TeamTaskStallMonitorOptions = {}
  ) {
    this.scanTimeoutMs = Math.max(
      1,
      options.scanTimeoutMs ?? DEFAULT_TEAM_TASK_STALL_SCAN_TIMEOUT_MS
    );
  }

  start(): void {
    if (!isTeamTaskStallScannerEnabled()) {
      logger.debug('Task stall monitor disabled by feature gate');
      return;
    }
    if (this.started) {
      return;
    }
    this.started = true;
    this.registry.start();
    this.scheduleNextScan(2_000);
  }

  async stop(): Promise<void> {
    this.started = false;
    if (this.scanTimer) {
      clearTimeout(this.scanTimer);
      this.scanTimer = null;
    }
    if (this.nudgeTimer) {
      clearTimeout(this.nudgeTimer);
      this.nudgeTimer = null;
    }
    await this.registry.stop();
  }

  noteTeamChange(event: TeamChangeEvent): void {
    if (!isTeamTaskStallScannerEnabled()) {
      return;
    }
    this.registry.noteTeamChange(event);

    if (
      event.type === 'member-spawn' ||
      (event.type === 'lead-activity' && event.detail !== 'offline')
    ) {
      const now = Date.now();
      const existing = this.observationByTeam.get(event.teamName);
      this.observationByTeam.set(event.teamName, {
        firstSeenAtMs: existing?.firstSeenAtMs ?? now,
        lastActivationAtMs: now,
      });
      this.scheduleNudgedScan();
      return;
    }

    if (event.type === 'task-log-change' || event.type === 'log-source-change') {
      this.scheduleNudgedScan();
    }
  }

  private scheduleNextScan(delayMs: number): void {
    if (!this.started) {
      return;
    }
    if (this.scanTimer) {
      clearTimeout(this.scanTimer);
    }
    this.scanTimer = setTimeout(() => {
      this.scanTimer = null;
      void this.runScan();
    }, delayMs);
    unrefBackgroundTimer(this.scanTimer);
  }

  private scheduleNudgedScan(): void {
    if (!this.started || this.nudgeTimer) {
      return;
    }
    this.nudgeTimer = setTimeout(() => {
      this.nudgeTimer = null;
      void this.runScan();
    }, 5_000);
    unrefBackgroundTimer(this.nudgeTimer);
  }

  private async runScan(): Promise<void> {
    if (!this.started || this.scanInFlight) {
      return;
    }
    this.scanInFlight = true;
    const scanRun: TeamTaskStallScanRun = { cancelled: false };
    try {
      await this.runScanWithTimeout(scanRun);
    } catch (error) {
      logger.warn(`Task stall monitor scan failed: ${String(error)}`);
    } finally {
      scanRun.cancelled = true;
      this.scanInFlight = false;
      this.scheduleNextScan(getTeamTaskStallScanIntervalMs());
    }
  }

  private async runScanWithTimeout(scanRun: TeamTaskStallScanRun): Promise<void> {
    let timeout: ReturnType<typeof setTimeout> | null = null;
    try {
      await Promise.race([
        this.runScanBody(scanRun),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => {
            scanRun.cancelled = true;
            reject(new Error(`task stall monitor scan timed out after ${this.scanTimeoutMs}ms`));
          }, this.scanTimeoutMs);
          unrefBackgroundTimer(timeout);
        }),
      ]);
    } finally {
      if (timeout) {
        clearTimeout(timeout);
      }
    }
  }

  private shouldContinueScan(scanRun: TeamTaskStallScanRun): boolean {
    return this.started && !scanRun.cancelled;
  }

  private async runScanBody(scanRun: TeamTaskStallScanRun): Promise<void> {
    const activeTeams = await this.registry.listActiveTeams();
    if (!this.shouldContinueScan(scanRun)) {
      return;
    }
    const activeSet = new Set(activeTeams);
    for (const teamName of [...this.observationByTeam.keys()]) {
      if (!activeSet.has(teamName)) {
        this.observationByTeam.delete(teamName);
      }
    }

    const now = new Date();
    const eligibleTeamNames: string[] = [];
    for (const teamName of activeTeams) {
      const observation = this.getOrCreateObservation(teamName, now.getTime());
      const startupAgeMs = now.getTime() - observation.firstSeenAtMs;
      if (startupAgeMs < getTeamTaskStallStartupGraceMs()) {
        continue;
      }

      const activationAgeMs = now.getTime() - observation.lastActivationAtMs;
      if (activationAgeMs < getTeamTaskStallActivationGraceMs()) {
        continue;
      }

      eligibleTeamNames.push(teamName);
    }

    if (!this.shouldContinueScan(scanRun) || eligibleTeamNames.length === 0) {
      return;
    }

    const results = await Promise.allSettled(
      eligibleTeamNames.map((teamName) => this.scanTeam(teamName, now, scanRun))
    );
    for (const [index, result] of results.entries()) {
      if (result.status === 'rejected' && this.shouldContinueScan(scanRun)) {
        logger.warn(
          `Task stall monitor scan failed for ${eligibleTeamNames[index]}: ${String(result.reason)}`
        );
      }
    }
  }

  private getOrCreateObservation(teamName: string, nowMs: number): TeamObservationState {
    const existing = this.observationByTeam.get(teamName);
    if (existing) {
      return existing;
    }
    const created = {
      firstSeenAtMs: nowMs,
      lastActivationAtMs: nowMs,
    };
    this.observationByTeam.set(teamName, created);
    return created;
  }

  private async scanTeam(
    teamName: string,
    now: Date,
    scanRun: TeamTaskStallScanRun
  ): Promise<void> {
    const snapshot = await this.snapshotSource.getSnapshot(teamName);
    if (!this.shouldContinueScan(scanRun)) {
      return;
    }
    if (!snapshot) {
      return;
    }

    const evaluations: TaskStallEvaluation[] = [];
    for (const task of snapshot.inProgressTasks) {
      evaluations.push(this.policy.evaluateWork({ now, task, snapshot }));
    }
    for (const task of snapshot.reviewOpenTasks) {
      evaluations.push(this.policy.evaluateReview({ now, task, snapshot }));
    }

    const fullMonitorEnabled = isTeamTaskStallMonitorEnabled();
    const openCodeRemediationEnabled = isOpenCodeTaskStallRemediationEnabled();
    const openCodeOnlyMode = openCodeRemediationEnabled && !fullMonitorEnabled;
    const scopedTaskIds = openCodeOnlyMode ? this.getOpenCodeOwnedTaskIds(snapshot) : undefined;
    const journalEvaluations = openCodeOnlyMode
      ? evaluations.filter((evaluation) => this.isOpenCodeOwnerWorkEvaluation(snapshot, evaluation))
      : evaluations;
    const activeTaskIds = [
      ...new Set([...snapshot.inProgressTasks, ...snapshot.reviewOpenTasks].map((task) => task.id)),
    ];
    const readyEvaluations = await this.journal.reconcileScan({
      teamName,
      evaluations: journalEvaluations,
      activeTaskIds,
      ...(scopedTaskIds ? { scopeTaskIds: scopedTaskIds } : {}),
      now: now.toISOString(),
    });
    if (!this.shouldContinueScan(scanRun)) {
      return;
    }

    const alerts = readyEvaluations
      .map((evaluation) => this.buildAlert(snapshot, evaluation))
      .filter((alert): alert is TaskStallAlert => alert !== null);

    if (alerts.length === 0) {
      return;
    }

    const alertedEpochKeys = new Set<string>();
    if (openCodeRemediationEnabled) {
      const remediatedAlerts = await this.notifier.notifyOpenCodeOwners(teamName, alerts);
      if (!this.shouldContinueScan(scanRun)) {
        return;
      }
      for (const alert of remediatedAlerts) {
        alertedEpochKeys.add(alert.epochKey);
      }
    }

    const leadFallbackAlerts = alerts.filter((alert) => !alertedEpochKeys.has(alert.epochKey));
    if (leadFallbackAlerts.length > 0 && isTeamTaskStallAlertsEnabled()) {
      await this.notifier.notifyLead(teamName, leadFallbackAlerts);
      if (!this.shouldContinueScan(scanRun)) {
        return;
      }
      for (const alert of leadFallbackAlerts) {
        alertedEpochKeys.add(alert.epochKey);
      }
    }

    if (alertedEpochKeys.size === 0) {
      logger.debug(`Task stall monitor shadow-ready alerts for ${teamName}: ${alerts.length}`);
      return;
    }

    if (!this.shouldContinueScan(scanRun)) {
      return;
    }
    await Promise.all(
      alerts
        .filter((alert) => alertedEpochKeys.has(alert.epochKey))
        .map((alert) => this.journal.markAlerted(teamName, alert.epochKey, now.toISOString()))
    );
  }

  private buildAlert(
    snapshot: Awaited<ReturnType<TeamTaskStallSnapshotSource['getSnapshot']>>,
    evaluation: TaskStallEvaluation
  ): TaskStallAlert | null {
    if (
      !snapshot ||
      evaluation.status !== 'alert' ||
      !evaluation.taskId ||
      !evaluation.branch ||
      !evaluation.signal ||
      !evaluation.epochKey
    ) {
      return null;
    }

    const task = snapshot.allTasksById.get(evaluation.taskId);
    if (!task) {
      return null;
    }

    const displayId = getTaskDisplayId(task);
    const ownerProviderId = task.owner
      ? snapshot.providerByMemberName.get(task.owner.trim().toLowerCase())
      : undefined;
    return {
      teamName: snapshot.teamName,
      taskId: task.id,
      displayId,
      subject: task.subject,
      branch: evaluation.branch,
      signal: evaluation.signal,
      ...(evaluation.progressSignal ? { progressSignal: evaluation.progressSignal } : {}),
      reason: evaluation.reason,
      epochKey: evaluation.epochKey,
      ...(task.owner ? { owner: task.owner } : {}),
      ...(ownerProviderId ? { ownerProviderId } : {}),
      taskRef: {
        taskId: task.id,
        displayId,
        teamName: snapshot.teamName,
      },
    };
  }

  private isOpenCodeOwnerWorkEvaluation(
    snapshot: Awaited<ReturnType<TeamTaskStallSnapshotSource['getSnapshot']>>,
    evaluation: TaskStallEvaluation
  ): boolean {
    if (
      !snapshot ||
      evaluation.status !== 'alert' ||
      evaluation.branch !== 'work' ||
      !evaluation.taskId
    ) {
      return false;
    }

    const task = snapshot.allTasksById.get(evaluation.taskId);
    const ownerProviderId = task?.owner
      ? snapshot.providerByMemberName.get(task.owner.trim().toLowerCase())
      : undefined;
    return ownerProviderId === 'opencode';
  }

  private getOpenCodeOwnedTaskIds(
    snapshot: NonNullable<Awaited<ReturnType<TeamTaskStallSnapshotSource['getSnapshot']>>>
  ): string[] {
    return [...snapshot.allTasksById.values()]
      .filter((task) => {
        const ownerProviderId = task.owner
          ? snapshot.providerByMemberName.get(task.owner.trim().toLowerCase())
          : undefined;
        return ownerProviderId === 'opencode';
      })
      .map((task) => task.id);
  }
}
