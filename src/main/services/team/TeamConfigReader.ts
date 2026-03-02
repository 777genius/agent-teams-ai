import { getTeamsBasePath } from '@main/utils/pathDecoder';
import { createLogger } from '@shared/utils/logger';
import * as fs from 'fs';
import * as path from 'path';

import { TeamMembersMetaStore } from './TeamMembersMetaStore';

import type { TeamConfig, TeamMember, TeamSummary, TeamSummaryMember } from '@shared/types';

const logger = createLogger('Service:TeamConfigReader');

const TEAM_LIST_CONCURRENCY = process.platform === 'win32' ? 4 : 12;
const LARGE_CONFIG_BYTES = 512 * 1024;
const CONFIG_HEAD_BYTES = 64 * 1024;
const MAX_SESSION_HISTORY_IN_SUMMARY = 2000;
const MAX_PROJECT_PATH_HISTORY_IN_SUMMARY = 200;

async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let index = 0;
  const workerCount = Math.max(1, Math.min(limit, items.length));
  const workers = new Array(workerCount).fill(0).map(async () => {
    while (true) {
      const i = index++;
      if (i >= items.length) return;
      results[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return results;
}

async function readFileHead(filePath: string, maxBytes: number): Promise<string> {
  const handle = await fs.promises.open(filePath, 'r');
  try {
    const stat = await handle.stat();
    const bytesToRead = Math.max(0, Math.min(stat.size, maxBytes));
    if (bytesToRead === 0) return '';
    const buffer = Buffer.alloc(bytesToRead);
    await handle.read(buffer, 0, bytesToRead, 0);
    return buffer.toString('utf8');
  } finally {
    await handle.close();
  }
}

function extractQuotedString(head: string, key: string): string | null {
  const re = new RegExp(`"${key}"\\s*:\\s*("(?:\\\\.|[^"\\\\])*")`);
  const match = re.exec(head);
  if (!match?.[1]) return null;
  try {
    const value = JSON.parse(match[1]) as unknown;
    return typeof value === 'string' ? value : null;
  } catch {
    return null;
  }
}

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

    const teamDirs = entries.filter((e) => e.isDirectory());

    const perTeam: (TeamSummary | null)[] = await mapLimit(
      teamDirs,
      TEAM_LIST_CONCURRENCY,
      async (entry): Promise<TeamSummary | null> => {
        const teamName = entry.name;
        const configPath = path.join(teamsDir, teamName, 'config.json');

        try {
          let config: TeamConfig | null = null;
          let displayName: string | null = null;
          let description = '';
          let color: string | undefined;
          let projectPath: string | undefined;
          let leadSessionId: string | undefined;
          let deletedAt: string | undefined;
          let projectPathHistory: TeamConfig['projectPathHistory'] | undefined;
          let sessionHistory: TeamConfig['sessionHistory'] | undefined;

          let stat: fs.Stats | null = null;
          try {
            stat = await fs.promises.stat(configPath);
          } catch {
            stat = null;
          }

          if (stat && stat.isFile() && stat.size > LARGE_CONFIG_BYTES) {
            const head = await readFileHead(configPath, CONFIG_HEAD_BYTES);
            displayName = extractQuotedString(head, 'name');
            const desc = extractQuotedString(head, 'description');
            description = typeof desc === 'string' ? desc : '';
            const c = extractQuotedString(head, 'color');
            color = typeof c === 'string' && c.trim().length > 0 ? c : undefined;
            const pp = extractQuotedString(head, 'projectPath');
            projectPath = typeof pp === 'string' && pp.trim().length > 0 ? pp : undefined;
            const lead = extractQuotedString(head, 'leadSessionId');
            leadSessionId = typeof lead === 'string' && lead.trim().length > 0 ? lead : undefined;
            const del = extractQuotedString(head, 'deletedAt');
            deletedAt = typeof del === 'string' ? del : undefined;
          } else {
            const raw = await fs.promises.readFile(configPath, 'utf8');
            config = JSON.parse(raw) as TeamConfig;
            displayName = typeof config.name === 'string' ? config.name : null;
            description = typeof config.description === 'string' ? config.description : '';
            color =
              typeof config.color === 'string' && config.color.trim().length > 0
                ? config.color
                : undefined;
            projectPath =
              typeof config.projectPath === 'string' && config.projectPath.trim().length > 0
                ? config.projectPath
                : undefined;
            leadSessionId =
              typeof config.leadSessionId === 'string' && config.leadSessionId.trim().length > 0
                ? config.leadSessionId
                : undefined;
            projectPathHistory = Array.isArray(config.projectPathHistory)
              ? config.projectPathHistory.slice(-MAX_PROJECT_PATH_HISTORY_IN_SUMMARY)
              : undefined;
            sessionHistory = Array.isArray(config.sessionHistory)
              ? config.sessionHistory.slice(-MAX_SESSION_HISTORY_IN_SUMMARY)
              : undefined;
            deletedAt = typeof config.deletedAt === 'string' ? config.deletedAt : undefined;
          }

          if (typeof displayName !== 'string' || displayName.trim() === '') {
            logger.debug(`Skipping team dir with invalid config name: ${teamName}`);
            return null;
          }

          // Case-insensitive dedup: key is lowercase name, value keeps the original casing
          const memberMap = new Map<string, TeamSummaryMember>();

          const mergeMember = (m: TeamMember): void => {
            const name = m.name?.trim();
            if (!name) return;
            const key = name.toLowerCase();
            const existing = memberMap.get(key);
            memberMap.set(key, {
              name: existing?.name ?? name,
              role: m.role?.trim() || existing?.role,
              color: m.color?.trim() || existing?.color,
            });
          };

          if (config && Array.isArray(config.members)) {
            for (const member of config.members) {
              if (member && typeof member.name === 'string') {
                mergeMember(member);
              }
            }
          }

          // Also read members.meta.json — UI-created teams store members there,
          // and CLI-created teams may have additional members added via the UI.
          try {
            const metaMembers = await this.membersMetaStore.getMembers(teamName);
            for (const member of metaMembers) {
              if (!member.removedAt) {
                mergeMember(member);
              }
            }
          } catch {
            // best-effort — don't fail listing if meta file is broken
          }

          const members = Array.from(memberMap.values());
          const summary: TeamSummary = {
            teamName,
            displayName,
            description,
            memberCount: memberMap.size,
            taskCount: 0,
            lastActivity: null,
            ...(members.length > 0 ? { members } : {}),
            ...(color ? { color } : {}),
            ...(projectPath ? { projectPath } : {}),
            ...(leadSessionId ? { leadSessionId } : {}),
            ...(projectPathHistory ? { projectPathHistory } : {}),
            ...(sessionHistory ? { sessionHistory } : {}),
            ...(deletedAt ? { deletedAt } : {}),
          };
          return summary;
        } catch {
          logger.debug(`Skipping team dir without valid config: ${teamName}`);
          return null;
        }
      }
    );

    return perTeam.filter((t): t is TeamSummary => t !== null);
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
    updates: { name?: string; description?: string; color?: string; language?: string }
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
    if (updates.language !== undefined) {
      config.language = updates.language.trim() || undefined;
    }
    const configPath = path.join(getTeamsBasePath(), teamName, 'config.json');
    await fs.promises.writeFile(configPath, JSON.stringify(config, null, 2), 'utf8');
    return config;
  }
}
