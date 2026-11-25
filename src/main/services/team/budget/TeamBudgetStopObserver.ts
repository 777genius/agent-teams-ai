import { rawTeamName } from '@features/token-usage/contracts';
import { evaluateTeamBudgetEnforcement } from '@features/token-usage/core/domain';

import type { TokenUsageBudgetStatusDto } from '@features/token-usage/contracts';

export interface TeamBudgetStopPorts {
  readCurrentStatus(): Promise<TokenUsageBudgetStatusDto>;
  aliveTeams(): string[];
  resolveRuntimeNames?(logicalTeamName: string): Promise<readonly string[]>;
  ownsTeam(teamName: string): Promise<boolean>;
  stopTeam(teamName: string): Promise<void>;
  isTeamAlive(teamName: string): boolean | Promise<boolean>;
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
    for (const target of status.targets) {
      if (target.scope !== 'team' || target.onExceeded !== 'stop_team') continue;
      const teamName = rawTeamName(target.id);
      if (!teamName || this.inFlight.has(teamName)) continue;
      if (evaluateTeamBudgetEnforcement(status, teamName).state !== 'exceeded') continue;
      this.inFlight.add(teamName);
      void Promise.resolve()
        .then(async () => {
          // Settings may have changed after the queued status event.
          const current = await this.ports.readCurrentStatus();
          const decision = evaluateTeamBudgetEnforcement(current, teamName);
          if (decision.action !== 'stop_team' || decision.state !== 'exceeded') return;
          let nativeNames: readonly string[] = [teamName];
          try {
            nativeNames = await this.ports.resolveRuntimeNames?.(teamName) ?? nativeNames;
          } catch (error) {
            // A damaged project index must not hide an independently owned
            // native team. Never guess any project alias from that index.
            this.ports.warn(`Budget stop could not enumerate project copies of "${teamName}"`, error);
          }
          for (const name of new Set([teamName, ...nativeNames])) {
            // A slow stop can overlap a user raising the limit or disabling
            // enforcement. Recheck before stopping each remaining runtime.
            const latest = evaluateTeamBudgetEnforcement(
              await this.ports.readCurrentStatus(), teamName
            );
            if (latest.action !== 'stop_team' || latest.state !== 'exceeded') break;
            try {
              if (!this.ports.aliveTeams().includes(name)) continue;
              if (!(await this.ports.ownsTeam(name))) {
                throw new Error('Cannot prove runtime ownership for budget stop');
              }
              await this.ports.stopTeam(name);
              if (await this.ports.isTeamAlive(name)) {
                throw new Error('Stop returned without a confirmed stopped runtime');
              }
            } catch (error) {
              // One broken project runtime must not prevent stopping its siblings.
              this.ports.warn(`Budget stop failed for "${teamName}" runtime "${name}"`, error);
            }
          }
        })
        .catch((error: unknown) => this.ports.warn(`Budget stop failed for "${teamName}"`, error))
        .finally(() => this.inFlight.delete(teamName));
    }
  }
}
