import { TeamMetaStore } from '@main/services/team/TeamMetaStore';
import { getTeamsBasePath } from '@main/utils/pathDecoder';
import * as fs from 'fs';
import * as path from 'path';

import type {
  TeamLaunchMetadata,
  TeamProvisioningWorkspacePort,
} from '../../core/application/ports/TeamProvisioningPorts';

export class MainTeamProvisioningWorkspace implements TeamProvisioningWorkspacePort {
  constructor(private readonly metadata = new TeamMetaStore()) {}

  async ensureDirectory(directoryPath: string): Promise<boolean> {
    try {
      await fs.promises.mkdir(directoryPath, { recursive: true });
      return true;
    } catch {
      return false;
    }
  }

  async getDirectoryStatus(
    directoryPath: string
  ): Promise<'directory' | 'not-directory' | 'missing'> {
    try {
      const stat = await fs.promises.stat(directoryPath);
      return stat.isDirectory() ? 'directory' : 'not-directory';
    } catch {
      return 'missing';
    }
  }

  isAbsolute(candidatePath: string): boolean {
    return path.isAbsolute(candidatePath);
  }

  async hasTeamConfig(teamName: string): Promise<boolean> {
    try {
      await fs.promises.access(
        path.join(getTeamsBasePath(), teamName, 'config.json'),
        fs.constants.F_OK
      );
      return true;
    } catch {
      return false;
    }
  }

  getMetadata(teamName: string): Promise<TeamLaunchMetadata | null> {
    return this.metadata.getMeta(teamName);
  }
}
