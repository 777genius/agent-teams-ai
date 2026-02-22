import { getTeamsBasePath } from '@main/utils/pathDecoder';
import { createLogger } from '@shared/utils/logger';
import * as fs from 'fs';
import * as path from 'path';

import { TeamMembersMetaStore } from './TeamMembersMetaStore';

import type { TeamConfig, TeamMember, TeamSummary, TeamSummaryMember } from '@shared/types';

const logger = createLogger('Service:TeamConfigReader');

export class TeamConfigReader {
  constructor(
    private readonly membersMetaStore: TeamMembersMetaStore = new TeamMembersMetaStore()
  ) {}

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

        const memberMap = new Map<string, TeamSummaryMember>();

        const addMember = (m: TeamMember): void => {
          const name = m.name?.trim();
          if (!name) return;
          const existing = memberMap.get(name);
          memberMap.set(name, {
            name,
            role: m.role?.trim() || existing?.role,
            color: m.color?.trim() || existing?.color,
          });
        };

        if (Array.isArray(config.members)) {
          for (const member of config.members) {
            if (member && typeof member.name === 'string') {
              addMember(member);
            }
          }
        }

        try {
          const metaMembers = await this.membersMetaStore.getMembers(entry.name);
          for (const member of metaMembers) {
            addMember(member);
          }
        } catch {
          logger.debug(`Failed to read members.meta.json for team: ${entry.name}`);
        }

        const inboxDir = path.join(teamsDir, entry.name, 'inboxes');
        try {
          const inboxEntries = await fs.promises.readdir(inboxDir);
          for (const inbox of inboxEntries) {
            if (!inbox.endsWith('.json') || inbox.startsWith('.')) {
              continue;
            }
            const inboxName = inbox.slice(0, -'.json'.length).trim();
            if (inboxName.length > 0 && !memberMap.has(inboxName)) {
              memberMap.set(inboxName, { name: inboxName });
            }
          }
        } catch {
          // Inbox folder may not exist yet.
        }

        const memberCount = memberMap.size;
        const members = Array.from(memberMap.values());
        summaries.push({
          teamName: entry.name,
          displayName: config.name,
          description: typeof config.description === 'string' ? config.description : '',
          color:
            typeof config.color === 'string' && config.color.trim().length > 0
              ? config.color
              : undefined,
          memberCount,
          members: members.length > 0 ? members : undefined,
          taskCount: 0,
          lastActivity: null,
          projectPath:
            typeof config.projectPath === 'string' && config.projectPath.trim().length > 0
              ? config.projectPath
              : undefined,
          leadSessionId:
            typeof config.leadSessionId === 'string' && config.leadSessionId.trim().length > 0
              ? config.leadSessionId
              : undefined,
          projectPathHistory: Array.isArray(config.projectPathHistory)
            ? config.projectPathHistory
            : undefined,
          sessionHistory: Array.isArray(config.sessionHistory) ? config.sessionHistory : undefined,
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

  async updateConfig(
    teamName: string,
    updates: { name?: string; description?: string; color?: string }
  ): Promise<TeamConfig | null> {
    const config = await this.getConfig(teamName);
    if (!config) {
      return null;
    }
    if (updates.name !== undefined && updates.name.trim() !== '') {
      config.name = updates.name.trim();
    }
    if (updates.description !== undefined) {
      config.description = updates.description.trim() || undefined;
    }
    if (updates.color !== undefined) {
      config.color = updates.color.trim() || undefined;
    }
    const configPath = path.join(getTeamsBasePath(), teamName, 'config.json');
    await fs.promises.writeFile(configPath, JSON.stringify(config, null, 2), 'utf8');
    return config;
  }
}
