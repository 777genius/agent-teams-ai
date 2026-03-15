import { FileReadTimeoutError, readFileUtf8WithTimeout } from '@main/utils/fsRead';
import { getTeamsBasePath } from '@main/utils/pathDecoder';
import { isLeadMember } from '@shared/utils/leadDetection';
import { createLogger } from '@shared/utils/logger';
import {
  createCliAutoSuffixNameGuard,
  createCliProvisionerNameGuard,
} from '@shared/utils/teamMemberName';
import * as fs from 'fs';
import * as path from 'path';

import { getTeamFsWorkerClient } from './TeamFsWorkerClient';
import { TeamMembersMetaStore } from './TeamMembersMetaStore';

import type { TeamConfig, TeamMember, TeamSummary, TeamSummaryMember } from '@shared/types';

const logger = createLogger('Service:TeamConfigReader');

const TEAM_LIST_CONCURRENCY = process.platform === 'win32' ? 4 : 12;
const LARGE_CONFIG_BYTES = 512 * 1024;
const CONFIG_HEAD_BYTES = 64 * 1024;
const MAX_CONFIG_READ_BYTES = 10 * 1024 * 1024; // 10MB hard limit for full config reads
const PER_TEAM_READ_TIMEOUT_MS = 5_000;
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

function withReadTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error('Team config read timeout')), ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

export class TeamConfigReader {
  constructor(
    private readonly membersMetaStore: TeamMembersMetaStore = new TeamMembersMetaStore()
  ) {}

  async listTeams(): Promise<TeamSummary[]> {
    const worker = getTeamFsWorkerClient();
    if (worker.isAvailable()) {
      const startedAt = Date.now();
      try {
        const { teams, diag } = await worker.listTeams({
          largeConfigBytes: LARGE_CONFIG_BYTES,
          configHeadBytes: CONFIG_HEAD_BYTES,
          maxConfigBytes: MAX_CONFIG_READ_BYTES,
          maxMembersMetaBytes: 256 * 1024,
          maxSessionHistoryInSummary: MAX_SESSION_HISTORY_IN_SUMMARY,
          maxProjectPathHistoryInSummary: MAX_PROJECT_PATH_HISTORY_IN_SUMMARY,
          concurrency: TEAM_LIST_CONCURRENCY,
          maxConfigReadMs: PER_TEAM_READ_TIMEOUT_MS,
        });
        const ms = Date.now() - startedAt;
        const skipReasons =
          diag && typeof diag === 'object' ? (diag as Record<string, unknown>).skipReasons : null;
        if (skipReasons && typeof skipReasons === 'object') {
          const bad =
            Number((skipReasons as Record<string, unknown>).config_parse_failed ?? 0) +
            Number((skipReasons as Record<string, unknown>).config_read_timeout ?? 0);
          if (bad > 0) {
            logger.warn(`[listTeams] worker skipped broken team configs count=${bad}`);
          }
        }
        if (ms >= 1500) {
          logger.warn(`[listTeams] worker slow ms=${ms} diag=${JSON.stringify(diag)}`);
        }
        return teams;
      } catch (error) {
        logger.warn(
          `[listTeams] worker failed: ${error instanceof Error ? error.message : String(error)}`
        );
        // Fall through to in-process implementation.
      }
    }

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

        try {
          return await withReadTimeout(
            this.readTeamSummary(teamsDir, teamName),
            PER_TEAM_READ_TIMEOUT_MS
          );
        } catch (err) {
          const reason = err instanceof Error ? err.message : 'unknown';
          logger.warn(`Skipping team dir (${reason}): ${teamName}`);
          return null;
        }
      }
    );

    return perTeam.filter((t): t is TeamSummary => t !== null);
  }

  private async readTeamSummary(teamsDir: string, teamName: string): Promise<TeamSummary | null> {
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

      // Skip non-regular files (pipes, sockets, etc.) — readFile could hang on them
      if (!stat?.isFile()) {
        logger.debug(`Skipping team dir with missing/non-file config: ${teamName}`);
        return null;
      }

      // Safety: refuse to touch extremely large configs. Even "head" parsing can be misleading,
      // and full reads/parses can stall the main process.
      if (stat.size > MAX_CONFIG_READ_BYTES) {
        logger.warn(
          `Skipping team dir with oversized config.json (${stat.size} bytes): ${teamName}`
        );
        return null;
      }

      if (stat.size > LARGE_CONFIG_BYTES) {
        // Defensive: avoid any reads from very large configs during listing.
        // If the team is real, it can still be opened later via getConfig().
        displayName = teamName;
      } else {
        const raw = await readFileUtf8WithTimeout(configPath, PER_TEAM_READ_TIMEOUT_MS);
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
      const removedKeys = new Set<string>();

      const mergeMember = (m: TeamMember): void => {
        const name = m.name?.trim();
        if (!name) return;
        // Summary/memberCount should represent teammates (exclude the lead process).
        if (name === 'user' || isLeadMember(m)) return;
        const key = name.toLowerCase();
        // If meta marks this name removed, do not surface it in summaries
        if (removedKeys.has(key)) return;
        const existing = memberMap.get(key);
        memberMap.set(key, {
          name: existing?.name ?? name,
          role: m.role?.trim() || existing?.role,
          color: m.color?.trim() || existing?.color,
        });
      };

      // Also read members.meta.json — UI-created teams store members there,
      // and CLI-created teams may have additional members added via the UI.
      try {
        const metaMembers = await this.membersMetaStore.getMembers(teamName);
        for (const member of metaMembers) {
          const name = member.name?.trim();
          if (!name) continue;
          // Summary/memberCount should represent teammates (exclude the lead process).
          if (name === 'user' || isLeadMember(member)) continue;
          const key = name.toLowerCase();
          if (member.removedAt) {
            removedKeys.add(key);
            continue;
          }
          mergeMember(member);
        }
      } catch {
        // best-effort — don't fail listing if meta file is broken
      }

      // Merge config members AFTER meta so removedAt can suppress stale config entries.
      if (config && Array.isArray(config.members)) {
        for (const member of config.members) {
          if (member && typeof member.name === 'string') {
            mergeMember(member);
          }
        }
      }

      // Defense: drop CLI auto-suffixed duplicates (alice-2) when base name exists.
      const allNames = Array.from(memberMap.values()).map((m) => m.name);
      const keepName = createCliAutoSuffixNameGuard(allNames);
      // Defense: drop CLI provisioner artifacts (alice-provisioner) when base name exists.
      const keepProvisioner = createCliProvisionerNameGuard(allNames);
      for (const [key, member] of Array.from(memberMap.entries())) {
        if (!keepName(member.name) || !keepProvisioner(member.name)) {
          memberMap.delete(key);
        }
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

  async getConfig(teamName: string): Promise<TeamConfig | null> {
    const configPath = path.join(getTeamsBasePath(), teamName, 'config.json');
    try {
      const stat = await fs.promises.stat(configPath);
      // Safety: refuse special files and huge/binary configs
      if (!stat.isFile()) {
        return null;
      }
      if (stat.size > MAX_CONFIG_READ_BYTES) {
        logger.warn(
          `Refusing to load oversized config.json (${stat.size} bytes) for team: ${teamName}`
        );
        return null;
      }

      const raw = await readFileUtf8WithTimeout(configPath, PER_TEAM_READ_TIMEOUT_MS);
      const config = JSON.parse(raw) as TeamConfig;
      if (typeof config.name !== 'string' || config.name.trim() === '') {
        return null;
      }
      return config;
    } catch (error) {
      if (error instanceof FileReadTimeoutError) {
        logger.warn(`[getConfig] ${error.message}`);
        return null;
      }
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
