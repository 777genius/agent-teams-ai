import * as fs from 'fs';
import * as path from 'path';

import type {
  TeamDraftRepositoryPort,
  TeamDraftState,
} from '../../core/application/ports/TeamDraftRepositoryPort';

export interface FileSystemTeamDraftRepositoryDeps {
  getTeamsBasePath: () => string;
  permanentlyDeleteTeam: (teamName: string) => Promise<void>;
}

export class FileSystemTeamDraftRepository implements TeamDraftRepositoryPort {
  constructor(private readonly deps: FileSystemTeamDraftRepositoryDeps) {}

  async getDraftState(teamName: string): Promise<TeamDraftState> {
    const configPath = this.getTeamPath(teamName, 'config.json');
    try {
      await fs.promises.access(configPath, fs.constants.F_OK);
      return 'materialized';
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return 'draft';
      }
      throw error;
    }
  }

  async permanentlyDeleteTeam(teamName: string): Promise<void> {
    this.getTeamPath(teamName);
    await this.deps.permanentlyDeleteTeam(teamName);
  }

  private getTeamPath(teamName: string, ...segments: string[]): string {
    const basePath = path.resolve(this.deps.getTeamsBasePath());
    const teamRootPath = path.resolve(basePath, teamName);
    const teamRootRelative = path.relative(basePath, teamRootPath);
    if (
      teamRootRelative === '' ||
      teamRootRelative.startsWith('..') ||
      path.isAbsolute(teamRootRelative)
    ) {
      throw new Error('Unsafe team draft path');
    }

    const teamPath = path.resolve(teamRootPath, ...segments);
    const relative = path.relative(basePath, teamPath);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error('Unsafe team draft path');
    }

    return teamPath;
  }
}
