import { encodePath, extractBaseDir, getProjectsBasePath } from '@main/utils/pathDecoder';
import { createLogger } from '@shared/utils/logger';
import { createReadStream, type Dirent } from 'fs';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as readline from 'readline';

import { TeamConfigReader } from './TeamConfigReader';

import type { TeamConfig } from '@shared/types';

const logger = createLogger('Service:TeamTranscriptProjectResolver');

const SESSION_DISCOVERY_CACHE_TTL = 30_000;
const TEAM_AFFINITY_SCAN_LINES = 40;
const ROOT_DISCOVERY_CONCURRENCY = 12;

function trimTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0) {
    const ch = value.charCodeAt(end - 1);
    if (ch === 47 || ch === 92) {
      end -= 1;
      continue;
    }
    break;
  }
  return end === value.length ? value : value.slice(0, end);
}

function isSessionDirectoryName(name: string): boolean {
  return name !== 'memory' && !name.startsWith('.');
}

function extractTextContent(entry: Record<string, unknown>): string | null {
  if (typeof entry.content === 'string') {
    return entry.content;
  }
  if (Array.isArray(entry.content)) {
    const textParts = (entry.content as Record<string, unknown>[])
      .filter((part) => part.type === 'text' && typeof part.text === 'string')
      .map((part) => part.text as string);
    if (textParts.length > 0) {
      return textParts.join(' ');
    }
  }
  if (entry.message && typeof entry.message === 'object') {
    return extractTextContent(entry.message as Record<string, unknown>);
  }
  return null;
}

function extractDirectTeamName(entry: Record<string, unknown>): string | null {
  if (typeof entry.teamName === 'string') {
    return entry.teamName.trim().toLowerCase();
  }

  const process = entry.process as Record<string, unknown> | undefined;
  const processTeam = process?.team as Record<string, unknown> | undefined;
  if (typeof processTeam?.teamName === 'string') {
    return processTeam.teamName.trim().toLowerCase();
  }

  return null;
}

function lineMentionsTeam(text: string, teamName: string): boolean {
  const normalizedText = text.trim().toLowerCase();
  const normalizedTeam = teamName.trim().toLowerCase();
  if (!normalizedText.includes(normalizedTeam)) {
    return false;
  }
  return (
    normalizedText.includes(`on team "${normalizedTeam}"`) ||
    normalizedText.includes(`on team '${normalizedTeam}'`) ||
    normalizedText.includes(`team "${normalizedTeam}"`) ||
    normalizedText.includes(`team '${normalizedTeam}'`) ||
    normalizedText.includes(`(${normalizedTeam})`)
  );
}

function collectKnownSessionIds(config: TeamConfig): string[] {
  const knownSessionIds = new Set<string>();
  const push = (value: unknown): void => {
    if (typeof value !== 'string') {
      return;
    }
    const trimmed = value.trim();
    if (trimmed.length > 0) {
      knownSessionIds.add(trimmed);
    }
  };

  push(config.leadSessionId);
  if (Array.isArray(config.sessionHistory)) {
    for (const sessionId of config.sessionHistory) {
      push(sessionId);
    }
  }

  return [...knownSessionIds];
}

export interface TeamTranscriptProjectContext {
  projectDir: string;
  projectId: string;
  config: TeamConfig;
  sessionIds: string[];
}

export class TeamTranscriptProjectResolver {
  private readonly contextCache = new Map<
    string,
    { value: TeamTranscriptProjectContext; expiresAt: number }
  >();

  constructor(private readonly configReader: TeamConfigReader = new TeamConfigReader()) {}

  async getContext(
    teamName: string,
    options?: { forceRefresh?: boolean }
  ): Promise<TeamTranscriptProjectContext | null> {
    if (options?.forceRefresh) {
      this.contextCache.delete(teamName);
    }

    const cached = this.contextCache.get(teamName);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.value;
    }

    const config = await this.configReader.getConfig(teamName);
    if (!config?.projectPath) {
      return null;
    }

    const { projectDir, projectId } = await this.resolveProjectDirectory(config);
    const sessionIds = await this.discoverSessionIds(teamName, projectDir, config);
    const value = { projectDir, projectId, config, sessionIds };
    this.contextCache.set(teamName, {
      value,
      expiresAt: Date.now() + SESSION_DISCOVERY_CACHE_TTL,
    });
    return value;
  }

  private async resolveProjectDirectory(
    config: TeamConfig
  ): Promise<{ projectDir: string; projectId: string }> {
    const normalizedProjectPath = trimTrailingSlashes(config.projectPath ?? '');
    let projectId = encodePath(normalizedProjectPath);
    let projectDir = path.join(getProjectsBasePath(), extractBaseDir(projectId));

    try {
      const stat = await fs.stat(projectDir);
      if (!stat.isDirectory()) {
        throw new Error('not a directory');
      }
      return { projectDir, projectId };
    } catch {
      const leadSessionId =
        typeof config.leadSessionId === 'string' && config.leadSessionId.trim().length > 0
          ? config.leadSessionId.trim()
          : null;
      if (!leadSessionId) {
        return { projectDir, projectId };
      }

      try {
        const projectEntries = await fs.readdir(getProjectsBasePath(), { withFileTypes: true });
        for (const entry of projectEntries) {
          if (!entry.isDirectory()) continue;
          const candidateDir = path.join(getProjectsBasePath(), entry.name);
          try {
            await fs.access(path.join(candidateDir, `${leadSessionId}.jsonl`));
            projectDir = candidateDir;
            projectId = entry.name;
            break;
          } catch {
            // not this project
          }
        }
      } catch {
        // best-effort fallback
      }
    }

    return { projectDir, projectId };
  }

  private async discoverSessionIds(
    teamName: string,
    projectDir: string,
    config: TeamConfig
  ): Promise<string[]> {
    const knownSessionIds = collectKnownSessionIds(config);
    const [teamRootSessionIds, sessionDirIds] = await Promise.all([
      this.listTeamRootSessionIds(projectDir, teamName),
      this.listSessionDirIds(projectDir),
    ]);

    return Array.from(new Set([...knownSessionIds, ...teamRootSessionIds, ...sessionDirIds])).sort(
      (left, right) => left.localeCompare(right)
    );
  }

  private async listSessionDirIds(projectDir: string): Promise<string[]> {
    try {
      const dirEntries = await fs.readdir(projectDir, { withFileTypes: true });
      return dirEntries
        .filter((entry) => entry.isDirectory() && isSessionDirectoryName(entry.name))
        .map((entry) => entry.name);
    } catch {
      logger.debug(`Cannot read transcript project dir: ${projectDir}`);
      return [];
    }
  }

  private async listTeamRootSessionIds(projectDir: string, teamName: string): Promise<string[]> {
    let dirEntries: Dirent[];
    try {
      dirEntries = await fs.readdir(projectDir, { withFileTypes: true });
    } catch {
      logger.debug(`Cannot read transcript project dir: ${projectDir}`);
      return [];
    }

    const rootJsonlEntries = dirEntries.filter(
      (entry) => entry.isFile() && entry.name.endsWith('.jsonl')
    );
    const discovered = new Set<string>();
    let nextIndex = 0;

    const worker = async (): Promise<void> => {
      while (nextIndex < rootJsonlEntries.length) {
        const index = nextIndex++;
        const entry = rootJsonlEntries[index];
        const filePath = path.join(projectDir, entry.name);
        if (!(await this.fileBelongsToTeam(filePath, teamName))) {
          continue;
        }
        discovered.add(entry.name.slice(0, -'.jsonl'.length));
      }
    };

    await Promise.all(
      Array.from({ length: Math.min(ROOT_DISCOVERY_CONCURRENCY, rootJsonlEntries.length) }, () =>
        worker()
      )
    );

    return [...discovered];
  }

  private async fileBelongsToTeam(filePath: string, teamName: string): Promise<boolean> {
    const stream = createReadStream(filePath, { encoding: 'utf8' });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    const normalizedTeam = teamName.trim().toLowerCase();

    try {
      let inspected = 0;
      for await (const line of rl) {
        const trimmed = line.trim();
        if (!trimmed) {
          continue;
        }

        inspected += 1;
        try {
          const entry = JSON.parse(trimmed) as Record<string, unknown>;
          const directTeamName = extractDirectTeamName(entry);
          if (directTeamName === normalizedTeam) {
            return true;
          }

          const textContent = extractTextContent(entry);
          if (textContent && lineMentionsTeam(textContent, normalizedTeam)) {
            return true;
          }
        } catch {
          // ignore malformed head lines
        }

        if (inspected >= TEAM_AFFINITY_SCAN_LINES) {
          break;
        }
      }
    } catch {
      return false;
    } finally {
      rl.close();
      stream.destroy();
    }

    return false;
  }
}
