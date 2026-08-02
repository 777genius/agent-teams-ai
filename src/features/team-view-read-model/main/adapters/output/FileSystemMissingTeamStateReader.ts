import type {
  MissingTeamState,
  MissingTeamStateReaderPort,
  MissingTeamStateSourcePort,
  TeamProvisioningRunReadPort,
} from '../../../core/application/ports/TeamViewReadModelPorts';

export class FileSystemMissingTeamStateReader implements MissingTeamStateReaderPort {
  constructor(
    private readonly provisioningRuns: TeamProvisioningRunReadPort,
    private readonly sources: MissingTeamStateSourcePort
  ) {}

  async classifyBeforeRead(teamName: string): Promise<MissingTeamState> {
    const configExists = await this.sources.configExists(teamName);
    if (configExists !== false) {
      return null;
    }
    return this.classifyAfterNotFound(teamName);
  }

  async classifyAfterNotFound(teamName: string): Promise<MissingTeamState> {
    if (this.provisioningRuns.hasProvisioningRun(teamName) === true) {
      return 'provisioning';
    }
    return (await this.sources.draftExists(teamName)) ? 'draft' : null;
  }
}
