import type { TeamRuntimeStatusPort } from '../ports/TeamMessageDeliveryPorts';

export class GetTeamProcessAliveUseCase {
  constructor(private readonly runtime: TeamRuntimeStatusPort) {}

  execute(teamName: string): boolean {
    return this.runtime.isTeamAlive(teamName);
  }
}
