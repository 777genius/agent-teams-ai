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

import {
  choosePreferredLaunchSnapshot,
  readBootstrapLaunchSnapshot,
} from './TeamBootstrapStateReader';
import { getTeamFsWorkerClient } from './TeamFsWorkerClient';
import { normalizePersistedLaunchSnapshot } from './TeamLaunchStateEvaluator';
import { TeamMembersMetaStore } from './TeamMembersMetaStore';
import { TeamMetaStore } from './TeamMetaStore';

import type { TeamConfig, TeamMember, TeamSummary, TeamSummaryMember } from '@shared/types';

const logger = createLogger('Service:TeamConfigReader');

const TEAM_LIST_CONCURRENCY = process.platform === 'win32' ? 4 : 12;
const LARGE_CONFIG_BYTES = 512 * 1024;
const CONFIG_HEAD_BYTES = 64 * 1024;
const MAX_CONFIG_READ_BYTES = 10 * 1024 * 1024; // 10MB hard limit for full config reads
const PER_TEAM_READ_TIMEOUT_MS = 5_000;
const MAX_SESSION_HISTORY_IN_SUMMARY = 2000;
const MAX_PROJECT_PATH_HISTORY_IN_SUMMARY = 200;
const MAX_LAUNCH_STATE_BYTES = 32 * 1024;
const TEAM_LAUNCH_STATE_FILE = 'launch-state.json';

function normalizeProjectPathCandidate(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function resolveProjectPathFromConfig(
  config: Pick<TeamConfig, 'projectPath' | 'projectPathHistory' | 'members'>
): string | undefined {
  const direct = normalizeProjectPathCandidate(config.projectPath);
  if (direct) {
    return direct;
  }

  const leadMemberCwd = (config.members ?? []).find((member) => isLeadMember(member))?.cwd;
  const leadResolved = normalizeProjectPathCandidate(leadMemberCwd);
  if (leadResolved) {
    return leadResolved;
  }

  const distinctMemberCwds = Array.from(
    new Set(
      (config.members ?? [])
        .map((member) => normalizeProjectPathCandidate(member.cwd))
        .filter((cwd): cwd is string => Boolean(cwd))
    )
  );
  if (distinctMemberCwds.length === 1) {
    return distinctMemberCwds[0];
  }

  if (Array.isArray(config.projectPathHistory)) {
    for (let i = config.projectPathHistory.length - 1; i >= 0; i--) {
      const historyValue = normalizeProjectPathCandidate(config.projectPathHistory[i]);
      if (historyValue) {
        return historyValue;
      }
    }
  }

  return undefined;
}

interface LaunchStateSummary {
  partialLaunchFailure?: true;
  expectedMemberCount?: number;
  confirmedMemberCount?: number;
  missingMembers?: string[];
  teamLaunchState?: TeamSummary['teamLaunchState'];
  launchUpdatedAt?: string;
  confirmedCount?: number;
  pendingCount?: number;
  failedCount?: number;
  runtimeAlivePendingCount?: number;
}

async function readLaunchStateSummary(teamDir: string): Promise<LaunchStateSummary | null> {
  const bootstrapSnapshot = await readBootstrapLaunchSnapshot(path.basename(teamDir));
  const launchStatePath = path.join(teamDir, TEAM_LAUNCH_STATE_FILE);
  const launchSnapshot = await (async () => {
    try {
      const stat = await fs.promises.stat(launchStatePath);
      if (!stat.isFile() || stat.size > MAX_LAUNCH_STATE_BYTES) {
        return null;
      }

      const raw = await readFileUtf8WithTimeout(launchStatePath, PER_TEAM_READ_TIMEOUT_MS);
      return normalizePersistedLaunchSnapshot(path.basename(teamDir), JSON.parse(raw));
    } catch {
      return null;
    }
  })();

  const snapshot = choosePreferredLaunchSnapshot(bootstrapSnapshot, launchSnapshot);
  if (!snapshot) {
    return null;
  }

  try {
    const missingMembers = snapshot.expectedMembers.filter((name) => {
      const member = snapshot.members[name];
      return member?.launchState === 'failed_to_start';
    });
    return {
      ...(snapshot.teamLaunchState === 'partial_failure'
        ? { partialLaunchFailure: true as const }
        : {}),
      ...(snapshot.expectedMembers.length > 0
        ? { expectedMemberCount: snapshot.expectedMembers.length }
        : {}),
      ...(snapshot.summary.confirmedCount > 0
        ? { confirmedMemberCount: snapshot.summary.confirmedCount }
        : {}),
      ...(missingMembers.length > 0 ? { missingMembers } : {}),
      teamLaunchState: snapshot.teamLaunchState,
      launchUpdatedAt: snapshot.updatedAt,
      confirmedCount: snapshot.summary.confirmedCount,
      pendingCount: snapshot.summary.pendingCount,
      failedCount: snapshot.summary.failedCount,
      runtimeAlivePendingCount: snapshot.summary.runtimeAlivePendingCount,
    };
  } catch {
    return null;
  }
}

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
    const teamDir = path.join(teamsDir, teamName);

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
        // Fallback: check for draft team (team.meta.json without config.json)
        return this.readDraftTeamSummary(teamsDir, teamName);
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
        projectPath = resolveProjectPathFromConfig(config);
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
      const expectedTeammateNames = new Set<string>();
      const confirmedArtifactNames = new Set<string>();

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
          expectedTeammateNames.add(name);
          mergeMember(member);
        }
      } catch {
        // best-effort — don't fail listing if meta file is broken
      }

      // Merge config members AFTER meta so removedAt can suppress stale config entries.
      if (config && Array.isArray(config.members)) {
        for (const member of config.members) {
          if (member && typeof member.name === 'string') {
            const name = member.name.trim();
            if (name && name !== 'user' && !isLeadMember(member)) {
              confirmedArtifactNames.add(name);
            }
            mergeMember(member);
          }
        }
      }

      try {
        const inboxDir = path.join(teamDir, 'inboxes');
        const inboxEntries = await fs.promises.readdir(inboxDir, { withFileTypes: true });
        for (const entry of inboxEntries) {
          if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
          const inboxName = entry.name.slice(0, -'.json'.length).trim();
          if (!inboxName || inboxName === 'user' || isLeadMember({ name: inboxName })) continue;
          confirmedArtifactNames.add(inboxName);
        }
      } catch {
        // best-effort
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
      const launchStateSummary =
        (await readLaunchStateSummary(teamDir)) ??
        (() => {
          if (
            !leadSessionId ||
            expectedTeammateNames.size === 0 ||
            confirmedArtifactNames.size === 0
          ) {
            return null;
          }
          const missingMembers = Array.from(expectedTeammateNames).filter(
            (name) => !confirmedArtifactNames.has(name)
          );
          if (missingMembers.length === 0) {
            return null;
          }
          return {
            partialLaunchFailure: true as const,
            expectedMemberCount: expectedTeammateNames.size,
            confirmedMemberCount: confirmedArtifactNames.size,
            missingMembers,
          };
        })();
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
        ...(launchStateSummary ?? {}),
      };
      return summary;
    } catch {
      logger.debug(`Skipping team dir without valid config: ${teamName}`);
      return null;
    }
  }

  /**
   * Checks for a draft team (team.meta.json exists without config.json).
   * This happens when provisioning failed before CLI's TeamCreate could run.
   */
  private async readDraftTeamSummary(
    teamsDir: string,
    teamName: string
  ): Promise<TeamSummary | null> {
    const metaPath = path.join(teamsDir, teamName, 'team.meta.json');
    try {
      const metaStat = await fs.promises.stat(metaPath);
      if (!metaStat.isFile() || metaStat.size > 256 * 1024) {
        return null;
      }
      const metaRaw = await readFileUtf8WithTimeout(metaPath, PER_TEAM_READ_TIMEOUT_MS);
      const meta = JSON.parse(metaRaw) as Record<string, unknown>;
      if (meta?.version !== 1 || typeof meta?.cwd !== 'string') {
        return null;
      }

      const displayName =
        typeof meta.displayName === 'string' && meta.displayName.trim()
          ? meta.displayName.trim()
          : teamName;

      let memberCount = 0;
      try {
        const metaStore = new TeamMembersMetaStore();
        const members = await metaStore.getMembers(teamName);
        memberCount = members.length;
      } catch {
        // best-effort
      }

      return {
        teamName,
        displayName,
        description: typeof meta.description === 'string' ? meta.description : '',
        memberCount,
        taskCount: 0,
        lastActivity:
          typeof meta.createdAt === 'number' ? new Date(meta.createdAt).toISOString() : null,
        color: typeof meta.color === 'string' ? meta.color : undefined,
        projectPath: typeof meta.cwd === 'string' ? meta.cwd : undefined,
        pendingCreate: true,
      };
    } catch {
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
      const resolvedProjectPath = resolveProjectPathFromConfig(config);
      return resolvedProjectPath ? { ...config, projectPath: resolvedProjectPath } : config;
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
