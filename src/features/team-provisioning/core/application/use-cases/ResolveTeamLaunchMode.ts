import type { TeamLaunchMode } from '../models/TeamProvisioningModels';
import type { TeamProvisioningWorkspacePort } from '../ports/TeamProvisioningPorts';

export class ResolveTeamLaunchMode {
  constructor(private readonly workspace: TeamProvisioningWorkspacePort) {}

  async execute(teamName: string): Promise<TeamLaunchMode> {
    if (await this.workspace.hasTeamConfig(teamName)) {
      return 'existing';
    }
    return (await this.workspace.getMetadata(teamName)) === null ? 'existing' : 'draft';
  }
}
