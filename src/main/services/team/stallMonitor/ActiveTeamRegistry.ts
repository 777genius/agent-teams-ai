import type { TeamLogSourceTracker } from '../TeamLogSourceTracker';
import type { TeamChangeEvent } from '@shared/types';

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

export class ActiveTeamRegistry {
  private readonly activeTeams = new Set<string>();
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
        this.activeTeams.add(event.teamName);
        void this.teamLogSourceTracker.enableTracking(event.teamName, 'stall_monitor');
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
  }

  async stop(): Promise<void> {
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
    const aliveTeams = await this.teamDataService.listAliveProcessTeams();
    const aliveSet = new Set(aliveTeams);

    for (const teamName of aliveTeams) {
      if (this.activeTeams.has(teamName)) {
        continue;
      }
      this.activeTeams.add(teamName);
      await this.teamLogSourceTracker.enableTracking(teamName, 'stall_monitor');
    }

    for (const teamName of [...this.activeTeams]) {
      if (aliveSet.has(teamName)) {
        continue;
      }
      this.activeTeams.delete(teamName);
      await this.teamLogSourceTracker.disableTracking(teamName, 'stall_monitor');
    }
  }
}
