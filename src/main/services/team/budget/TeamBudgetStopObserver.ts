import { evaluateTeamBudgetEnforcement } from '@features/token-usage/core/domain';
import { rawTeamName } from '@features/token-usage/contracts';

import type { TokenUsageBudgetStatusDto } from '@features/token-usage/contracts';

export interface TeamBudgetStopPorts {
  readCurrentStatus(): Promise<TokenUsageBudgetStatusDto>;
  aliveTeams(): string[];
  ownsTeam(teamName: string): Promise<boolean>;
  stopTeam(teamName: string): Promise<void>;
  isTeamAlive(teamName: string): Promise<boolean>;
  warn(message: string, error: unknown): void;
}

/**
 * Side-effect edge of budget projection. The status publisher must not await
 * this observer, because a fresh status read is serialized in the usage queue.
 * Retrying only on future real publications avoids a second watchdog.
 */
export class TeamBudgetStopObserver {
  private readonly inFlight = new Set<string>();

  constructor(private readonly ports: TeamBudgetStopPorts) {}

  observe(status: TokenUsageBudgetStatusDto): void {
    if (status.stale || status.degraded) return;
    const alive = new Set(this.ports.aliveTeams());
    for (const target of status.targets) {
      if (target.scope !== 'team' || target.onExceeded !== 'stop_team') continue;
      const teamName = rawTeamName(target.id);
      if (!teamName || !alive.has(teamName) || this.inFlight.has(teamName)) continue;
      if (evaluateTeamBudgetEnforcement(status, teamName).state !== 'exceeded') continue;
      this.inFlight.add(teamName);
      void Promise.resolve()
        .then(async () => {
          // Settings may have changed after the queued status event.
          const current = await this.ports.readCurrentStatus();
          const decision = evaluateTeamBudgetEnforcement(current, teamName);
          if (decision.action !== 'stop_team' || decision.state !== 'exceeded') return;
          if (!(await this.ports.ownsTeam(teamName))) return;
          if (!this.ports.aliveTeams().includes(teamName)) return;
          await this.ports.stopTeam(teamName);
          if (await this.ports.isTeamAlive(teamName)) {
            throw new Error('Stop returned without a confirmed stopped runtime');
          }
        })
        .catch((error: unknown) => this.ports.warn(`Budget stop failed for "${teamName}"`, error))
        .finally(() => this.inFlight.delete(teamName));
    }
  }
}
