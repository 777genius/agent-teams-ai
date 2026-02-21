import { getTeamsBasePath } from '@main/utils/pathDecoder';
import { createLogger } from '@shared/utils/logger';
import * as fs from 'fs';
import * as path from 'path';

import type { TeamConfig, TeamSummary } from '@shared/types';

const logger = createLogger('Service:TeamConfigReader');

export class TeamConfigReader {
  async listTeams(): Promise<TeamSummary[]> {
    const teamsDir = getTeamsBasePath();

    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(teamsDir, { withFileTypes: true });
    } catch {
      return [];
    }

    const summaries: TeamSummary[] = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }

      const configPath = path.join(teamsDir, entry.name, 'config.json');
      try {
        const raw = await fs.promises.readFile(configPath, 'utf8');
        const config = JSON.parse(raw) as TeamConfig;
        if (typeof config.name !== 'string' || config.name.trim() === '') {
          logger.debug(`Skipping team dir with invalid config name: ${entry.name}`);
          continue;
        }

        const memberCount = Array.isArray(config.members) ? config.members.length : 0;
        summaries.push({
          teamName: entry.name,
          displayName: config.name,
          description: typeof config.description === 'string' ? config.description : '',
          memberCount,
          taskCount: 0,
          lastActivity: null,
        });
      } catch {
        logger.debug(`Skipping team dir without valid config: ${entry.name}`);
      }
    }

    return summaries;
  }

  async getConfig(teamName: string): Promise<TeamConfig | null> {
    const configPath = path.join(getTeamsBasePath(), teamName, 'config.json');
    try {
      const raw = await fs.promises.readFile(configPath, 'utf8');
      const config = JSON.parse(raw) as TeamConfig;
      if (typeof config.name !== 'string' || config.name.trim() === '') {
        return null;
      }
      return config;
    } catch {
      return null;
    }
  }
}
