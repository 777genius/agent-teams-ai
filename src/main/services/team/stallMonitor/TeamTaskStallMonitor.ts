import { createLogger } from '@shared/utils/logger';
import { getTaskDisplayId } from '@shared/utils/taskIdentity';

import { ActiveTeamRegistry } from './ActiveTeamRegistry';
import {
  getTeamTaskStallActivationGraceMs,
  getTeamTaskStallScanIntervalMs,
  getTeamTaskStallStartupGraceMs,
  isTeamTaskStallAlertsEnabled,
  isTeamTaskStallMonitorEnabled,
} from './featureGates';

import type { TeamTaskStallSnapshotSource } from './TeamTaskStallSnapshotSource';
import type { TeamTaskStallPolicy } from './TeamTaskStallPolicy';
import type { TeamTaskStallJournal } from './TeamTaskStallJournal';
import type { TeamTaskStallNotifier } from './TeamTaskStallNotifier';
import type { TaskStallAlert, TaskStallEvaluation } from './TeamTaskStallTypes';
import type { TeamChangeEvent } from '@shared/types';

const logger = createLogger('Service:TeamTaskStallMonitor');

interface TeamObservationState {
  firstSeenAtMs: number;
  lastActivationAtMs: number;
}

export class TeamTaskStallMonitor {
  private scanTimer: ReturnType<typeof setTimeout> | null = null;
  private nudgeTimer: ReturnType<typeof setTimeout> | null = null;
  private scanInFlight = false;
  private started = false;
  private readonly observationByTeam = new Map<string, TeamObservationState>();

  constructor(
    private readonly registry: ActiveTeamRegistry,
    private readonly snapshotSource: TeamTaskStallSnapshotSource,
    private readonly policy: TeamTaskStallPolicy,
    private readonly journal: TeamTaskStallJournal,
    private readonly notifier: TeamTaskStallNotifier
  ) {}

  start(): void {
    if (!isTeamTaskStallMonitorEnabled()) {
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
    this.registry.noteTeamChange(event);
    if (!isTeamTaskStallMonitorEnabled()) {
      return;
    }

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
  }

  private scheduleNudgedScan(): void {
    if (!this.started || this.nudgeTimer) {
      return;
    }
    this.nudgeTimer = setTimeout(() => {
      this.nudgeTimer = null;
      void this.runScan();
    }, 5_000);
  }

  private async runScan(): Promise<void> {
    if (!this.started || this.scanInFlight) {
      return;
    }
    this.scanInFlight = true;
    try {
      const activeTeams = await this.registry.listActiveTeams();
      const activeSet = new Set(activeTeams);
      for (const teamName of [...this.observationByTeam.keys()]) {
        if (!activeSet.has(teamName)) {
          this.observationByTeam.delete(teamName);
        }
      }

      const now = new Date();
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

        await this.scanTeam(teamName, now);
      }
    } catch (error) {
      logger.warn(`Task stall monitor scan failed: ${String(error)}`);
    } finally {
      this.scanInFlight = false;
      this.scheduleNextScan(getTeamTaskStallScanIntervalMs());
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

  private async scanTeam(teamName: string, now: Date): Promise<void> {
    const snapshot = await this.snapshotSource.getSnapshot(teamName);
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

    const activeTaskIds = [
      ...new Set([...snapshot.inProgressTasks, ...snapshot.reviewOpenTasks].map((task) => task.id)),
    ];
    const readyEvaluations = await this.journal.reconcileScan({
      teamName,
      evaluations,
      activeTaskIds,
      now: now.toISOString(),
    });

    const alerts = readyEvaluations
      .map((evaluation) => this.buildAlert(snapshot, evaluation))
      .filter((alert): alert is TaskStallAlert => alert !== null);

    if (alerts.length === 0) {
      return;
    }

    if (!isTeamTaskStallAlertsEnabled()) {
      logger.debug(`Task stall monitor shadow-ready alerts for ${teamName}: ${alerts.length}`);
      return;
    }

    await this.notifier.notifyLead(teamName, alerts);
    await Promise.all(
      alerts.map((alert) => this.journal.markAlerted(teamName, alert.epochKey, now.toISOString()))
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
    return {
      teamName: snapshot.teamName,
      taskId: task.id,
      displayId,
      subject: task.subject,
      branch: evaluation.branch,
      signal: evaluation.signal,
      reason: evaluation.reason,
      epochKey: evaluation.epochKey,
      taskRef: {
        taskId: task.id,
        displayId,
        teamName: snapshot.teamName,
      },
    };
  }
}
