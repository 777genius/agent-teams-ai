import { isPathWithinRoot, validateFileName } from '@main/utils/pathValidation';
import { join } from 'path';

export class TeamRuntimeRecoveryStorePaths {
  constructor(private readonly teamsBasePath: string) {}

  getTeamDir(teamName: string): string {
    const normalized = teamName.trim();
    if (!validateFileName(normalized).valid) {
      throw new Error('Invalid team runtime recovery store path');
    }
    const teamDir = join(this.teamsBasePath, normalized);
    const recoveryDir = join(teamDir, '.team-runtime-recovery');
    if (!isPathWithinRoot(teamDir, this.teamsBasePath) || !isPathWithinRoot(recoveryDir, teamDir)) {
      throw new Error('Invalid team runtime recovery store path');
    }
    return recoveryDir;
  }

  getStatePath(teamName: string): string {
    return join(this.getTeamDir(teamName), 'state.json');
  }

  getTeamsBasePath(): string {
    return this.teamsBasePath;
  }
}
