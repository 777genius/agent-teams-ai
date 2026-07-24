import { getTeamsBasePath } from '@main/utils/pathDecoder';
import * as fs from 'fs';
import * as path from 'path';

import type { DraftTeamConfigGuardPort } from '../../core/application/ports/TeamConfigurationPorts';

export class FileSystemDraftTeamConfigGuard implements DraftTeamConfigGuardPort {
  constructor(private readonly getTeamsRoot: () => string = getTeamsBasePath) {}

  async assertDraftCanBeDeleted(teamName: string): Promise<void> {
    const configPath = path.join(this.getTeamsRoot(), teamName, 'config.json');
    try {
      await fs.promises.access(configPath, fs.constants.F_OK);
      throw new Error('Cannot delete draft: team has config.json (use deleteTeam instead)');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
}
