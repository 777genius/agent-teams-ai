import { createLogger } from '@shared/utils/logger';

import type { TeamLogSourceTracker } from '../TeamLogSourceTracker';
import type { TeamChangeEvent } from '@shared/types';

const logger = createLogger('Service:ActiveTeamRegistry');

interface TeamAliveProcessesReader {
  listAliveProcessTeams(): Promise<string[]>;
}

interface TeamLogSourceTrackingHandle {
  enableTracking(
    teamName: string,
    consumer: 'stall_monitor'
  ): Promise<{ projectFingerprint: string | null; logSourceGeneration: string | null }>;
  disableTracking(
    teamName: string,
    consumer: 'stall_monitor'
  ): Promise<{ projectFingerprint: string | null; logSourceGeneration: string | null }>;
}

function unrefBackgroundTimer(timer: ReturnType<typeof setInterval>): void {
  const maybeTimer = timer as { unref?: () => void };
  maybeTimer.unref?.();
}

export class ActiveTeamRegistry {
  private readonly activeTeams = new Set<string>();
  private readonly activationInFlight = new Set<string>();
  private activationGeneration = 0;
  private reconcileTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly teamDataService: TeamAliveProcessesReader,
    private readonly teamLogSourceTracker: Pick<
      TeamLogSourceTracker,
      'enableTracking' | 'disableTracking'
    > &
      TeamLogSourceTrackingHandle,
    private readonly reconcileIntervalMs: number = 5 * 60_000
  ) {}

  noteTeamChange(event: TeamChangeEvent): void {
    if (
      event.type === 'member-spawn' ||
      (event.type === 'lead-activity' && event.detail !== 'offline')
    ) {
      if (!this.activeTeams.has(event.teamName)) {
        void this.activateTeam(event.teamName);
      }
      return;
    }

    if (event.type === 'task-log-change' || event.type === 'log-source-change') {
      if (!this.activeTeams.has(event.teamName)) {
        return;
      }
    }
  }

  async listActiveTeams(): Promise<string[]> {
    return [...this.activeTeams].sort((left, right) => left.localeCompare(right));
  }

  start(): void {
    if (this.reconcileTimer) {
      return;
    }
    void this.reconcile();
    this.reconcileTimer = setInterval(() => {
      void this.reconcile();
    }, this.reconcileIntervalMs);
    unrefBackgroundTimer(this.reconcileTimer);
  }

  async stop(): Promise<void> {
    this.activationGeneration += 1;
    if (this.reconcileTimer) {
      clearInterval(this.reconcileTimer);
      this.reconcileTimer = null;
    }

    const teamNames = [...this.activeTeams];
    this.activeTeams.clear();
    await Promise.all(
      teamNames.map((teamName) =>
        this.teamLogSourceTracker.disableTracking(teamName, 'stall_monitor')
      )
    );
  }

  async reconcile(): Promise<void> {
    const reconcileGeneration = this.activationGeneration;
    const aliveTeams = await this.teamDataService.listAliveProcessTeams();
    const aliveSet = new Set(aliveTeams);

    for (const teamName of aliveTeams) {
      if (this.activeTeams.has(teamName)) {
        continue;
      }
      await this.activateTeam(teamName, reconcileGeneration);
    }

    for (const teamName of [...this.activeTeams]) {
      if (aliveSet.has(teamName)) {
        continue;
      }
      this.activeTeams.delete(teamName);
      await this.teamLogSourceTracker.disableTracking(teamName, 'stall_monitor');
    }
  }

  private async activateTeam(
    teamName: string,
    expectedGeneration = this.activationGeneration
  ): Promise<void> {
    if (expectedGeneration !== this.activationGeneration) {
      return;
    }
    if (this.activeTeams.has(teamName) || this.activationInFlight.has(teamName)) {
      return;
    }

    this.activationInFlight.add(teamName);
    const activationGeneration = this.activationGeneration;
    try {
      await this.teamLogSourceTracker.enableTracking(teamName, 'stall_monitor');
      if (activationGeneration !== this.activationGeneration) {
        await this.disableStaleActivation(teamName);
        return;
      }
      this.activeTeams.add(teamName);
    } catch (error) {
      logger.warn(`Failed to enable stall-monitor tracking for ${teamName}: ${String(error)}`);
    } finally {
      this.activationInFlight.delete(teamName);
    }
  }

  private async disableStaleActivation(teamName: string): Promise<void> {
    try {
      await this.teamLogSourceTracker.disableTracking(teamName, 'stall_monitor');
    } catch (error) {
      logger.warn(
        `Failed to disable stale stall-monitor tracking for ${teamName}: ${String(error)}`
      );
    }
  }
}
