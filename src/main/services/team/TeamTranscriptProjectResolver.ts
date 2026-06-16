import { atomicWriteAsync } from '@main/utils/atomicWrite';
import { extractCwd } from '@main/utils/jsonl';
import {
  encodePath,
  extractBaseDir,
  getProjectsBasePath,
  getTeamsBasePath,
} from '@main/utils/pathDecoder';
import { isLeadMember } from '@shared/utils/leadDetection';
import { createLogger } from '@shared/utils/logger';
import { createHash } from 'crypto';
import { type Dirent } from 'fs';
import * as fs from 'fs/promises';
import * as path from 'path';
import { StringDecoder } from 'string_decoder';

import { JsonTeamTranscriptAffinityIndexStore } from './cache/JsonTeamTranscriptAffinityIndexStore';
import { TeamConfigReader } from './TeamConfigReader';

import type {
  PersistedTeamTranscriptAffinityEntry,
  PersistedTeamTranscriptAffinityIndex,
  TeamTranscriptAffinityFileSignature,
  TeamTranscriptAffinityIndexStore,
  TeamTranscriptAffinityMatchSource,
} from './cache/teamTranscriptAffinityIndexTypes';
import type { TeamConfig } from '@shared/types';

const logger = createLogger('Service:TeamTranscriptProjectResolver');

const SESSION_DISCOVERY_CACHE_TTL = 30_000;
const TEAM_AFFINITY_SCAN_LINES = 40;
// Read size for the head-window affinity scan. Read in chunks (not the whole file)
// so a transcript whose head holds the team's first TEAM_AFFINITY_SCAN_LINES lines
// is decided after reading just those, not the entire (possibly huge) file.
const TEAM_AFFINITY_READ_CHUNK_BYTES = 64 * 1024;
const TEAM_AFFINITY_FILE_CACHE_MAX_ENTRIES = 4_096;
const TEAM_AFFINITY_HEAD_METADATA_CACHE_MAX_ENTRIES = 4_096;
const ROOT_DISCOVERY_CONCURRENCY = 12;
const FAST_CONTEXT_ROOT_DISCOVERY_MTIME_GRACE_MS = 24 * 60 * 60_000;

type ProjectEvidenceSource =
  | 'projectPath'
  | 'projectPathHistory'
  | 'leadCwd'
  | 'memberCwd'
  | 'projectsScan';

interface ProjectPathCandidate {
  projectPath: string;
  source: Exclude<ProjectEvidenceSource, 'projectsScan'>;
}

interface ProjectDirCandidate {
  projectPath: string;
  projectDir: string;
  projectId: string;
  source: ProjectEvidenceSource;
}

interface SessionProjectMatch extends ProjectDirCandidate {
  matchedSessionId: string;
}

interface TeamTranscriptProjectConfigReader {
  getConfig(teamName: string): Promise<TeamConfig | null>;
  getConfigSnapshot?: (teamName: string) => Promise<TeamConfig | null>;
}

interface TeamTranscriptProjectContextOptions {
  forceRefresh?: boolean;
  includeTeamSubagentSessionDiscovery?: boolean;
}

interface TeamTranscriptFileStat {
  mtimeMs: number;
  size: number;
  ctimeMs?: number;
  isFile: () => boolean;
}

type ScannedSessionProjectMatch = Omit<SessionProjectMatch, 'projectPath'> & {
  projectPath?: string;
};

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

function buildContextCacheKey(
  teamName: string,
  options?: TeamTranscriptProjectContextOptions
): string {
  const subagentMode = options?.includeTeamSubagentSessionDiscovery === false ? 'known' : 'full';
  return `${teamName}\0${subagentMode}`;
}

function parseTimestampMs(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function teamLifecycleMtimeCutoffMs(config: TeamConfig): number | null {
  const timestamps: number[] = [];
  const createdAt = parseTimestampMs((config as { createdAt?: unknown }).createdAt);
  if (createdAt !== null) {
    timestamps.push(createdAt);
  }

  for (const member of config.members ?? []) {
    const joinedAt = parseTimestampMs((member as { joinedAt?: unknown }).joinedAt);
    if (joinedAt !== null) {
      timestamps.push(joinedAt);
    }
  }

  if (timestamps.length === 0) {
    return null;
  }
  return Math.max(0, Math.min(...timestamps) - FAST_CONTEXT_ROOT_DISCOVERY_MTIME_GRACE_MS);
}

function normalizeProjectPathCandidate(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  return trimTrailingSlashes(trimmed);
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

function lineMentionsNormalizedTeam(normalizedText: string, normalizedTeam: string): boolean {
  if (!normalizedText.includes(normalizedTeam)) {
    return false;
  }
  return (
    normalizedText.includes(`team name: ${normalizedTeam}`) ||
    normalizedText.includes(`team name "${normalizedTeam}"`) ||
    normalizedText.includes(`team name '${normalizedTeam}'`) ||
    normalizedText.includes(`on team "${normalizedTeam}"`) ||
    normalizedText.includes(`on team '${normalizedTeam}'`) ||
    normalizedText.includes(`team "${normalizedTeam}"`) ||
    normalizedText.includes(`team '${normalizedTeam}'`) ||
    normalizedText.includes(`(${normalizedTeam})`)
  );
}

function collectNestedTeamNames(value: unknown, teamNames: Set<string>, depth: number = 0): void {
  if (!value || depth > 8 || typeof value !== 'object') {
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      collectNestedTeamNames(item, teamNames, depth + 1);
    }
    return;
  }

  const entry = value as Record<string, unknown>;
  if (typeof entry.teamName === 'string') {
    const normalizedTeamName = entry.teamName.trim().toLowerCase();
    if (normalizedTeamName) {
      teamNames.add(normalizedTeamName);
    }
  }

  for (const [key, nested] of Object.entries(entry)) {
    if (key === 'teamName') {
      continue;
    }
    collectNestedTeamNames(nested, teamNames, depth + 1);
  }
}

function parseTeamAffinityHeadLine(rawLine: string): TeamAffinityHeadLineMetadata {
  const empty: TeamAffinityHeadLineMetadata = {
    nestedTeamNames: new Set<string>(),
    normalizedTextContent: null,
  };

  try {
    const entry = JSON.parse(rawLine) as Record<string, unknown>;
    const nestedTeamNames = new Set<string>();
    collectNestedTeamNames(entry, nestedTeamNames);
    const textContent = extractTextContent(entry);
    return {
      nestedTeamNames,
      normalizedTextContent: textContent ? textContent.trim().toLowerCase() : null,
    };
  } catch {
    return empty;
  }
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
    for (let index = config.sessionHistory.length - 1; index >= 0; index -= 1) {
      const sessionId = config.sessionHistory[index];
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

export interface TeamTranscriptProjectLiveBaseContext {
  projectDir: string;
  projectId: string;
  config: TeamConfig;
}

interface TeamAffinityFileCacheEntry {
  mtimeMs: number;
  size: number;
  ctimeMs?: number;
  belongsToTeam: boolean;
  inspectedLineCount: number;
  headFingerprint: string;
  // True when the verdict was decided after inspecting a FULL head window
  // (>= TEAM_AFFINITY_SCAN_LINES non-empty lines). For append-only transcripts the
  // head is immutable, so a `false` verdict from a full window stays valid while the
  // file only grows — letting us cache negatives durably instead of re-streaming
  // every non-matching transcript on each bootstrap poll.
  headWindowFull: boolean;
}

interface TeamAffinityHeadLineMetadata {
  nestedTeamNames: Set<string>;
  normalizedTextContent: string | null;
}

interface TeamAffinityHeadMetadataCacheEntry {
  mtimeMs: number;
  size: number;
  ctimeMs?: number;
  inspectedLineCount: number;
  headFingerprint: string;
  lines: TeamAffinityHeadLineMetadata[];
}

interface TeamAffinityEvaluation {
  belongsToTeam: boolean;
  inspectedLineCount: number;
  matchSource: TeamTranscriptAffinityMatchSource;
}

interface TeamAffinityInspectionResult extends TeamAffinityEvaluation {
  headWindowFull: boolean;
  indexable: boolean;
}

export class TeamTranscriptProjectResolver {
  private readonly contextCache = new Map<
    string,
    { value: TeamTranscriptProjectContext; expiresAt: number }
  >();

  private readonly teamAffinityFileCache = new Map<string, TeamAffinityFileCacheEntry>();
  private readonly teamAffinityHeadMetadataCache = new Map<
    string,
    TeamAffinityHeadMetadataCacheEntry
  >();

  constructor(
    private readonly configReader: TeamTranscriptProjectConfigReader = new TeamConfigReader(),
    private readonly affinityIndexStore: TeamTranscriptAffinityIndexStore = new JsonTeamTranscriptAffinityIndexStore()
  ) {}

  private readConfigForObservation(teamName: string): Promise<TeamConfig | null> {
    return typeof this.configReader.getConfigSnapshot === 'function'
      ? this.configReader.getConfigSnapshot(teamName)
      : this.configReader.getConfig(teamName);
  }

  private deleteContextCacheForTeam(teamName: string): void {
    this.contextCache.delete(teamName);
    for (const key of this.contextCache.keys()) {
      if (key === teamName || key.startsWith(`${teamName}\0`)) {
        this.contextCache.delete(key);
      }
    }
  }

  async getLiveBaseContext(
    teamName: string,
    options?: { forceRefresh?: boolean; extraProjectPathCandidates?: readonly unknown[] }
  ): Promise<TeamTranscriptProjectLiveBaseContext | null> {
    if (options?.forceRefresh) {
      this.deleteContextCacheForTeam(teamName);
    }

    const config = await this.readConfigForObservation(teamName);
    if (!config) {
      return null;
    }

    const projectPathCandidates = this.collectLiveProjectPathCandidates(
      config,
      options?.extraProjectPathCandidates ?? []
    );
    const resolution = await this.resolveLiveProjectDirectoryFromCandidates(projectPathCandidates);
    if (!resolution) {
      return null;
    }

    const resolvedConfig =
      trimTrailingSlashes(config.projectPath ?? '') !==
      trimTrailingSlashes(resolution.effectiveProjectPath)
        ? { ...config, projectPath: resolution.effectiveProjectPath }
        : config;

    return {
      projectDir: resolution.projectDir,
      projectId: resolution.projectId,
      config: resolvedConfig,
    };
  }

  async getContext(
    teamName: string,
    options?: TeamTranscriptProjectContextOptions
  ): Promise<TeamTranscriptProjectContext | null> {
    const cacheKey = buildContextCacheKey(teamName, options);
    if (options?.forceRefresh) {
      this.deleteContextCacheForTeam(teamName);
    }

    const cached = this.contextCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.value;
    }

    const config = await this.readConfigForObservation(teamName);
    if (!config) {
      return null;
    }

    const resolution = await this.resolveProjectDirectory(teamName, config);
    if (!resolution) {
      return null;
    }

    const resolvedConfig =
      resolution.effectiveProjectPath &&
      trimTrailingSlashes(resolution.effectiveProjectPath) !==
        trimTrailingSlashes(config.projectPath ?? '')
        ? {
            ...config,
            projectPath: resolution.effectiveProjectPath,
            projectPathHistory: this.buildRepairedProjectPathHistory(
              config.projectPath,
              config.projectPathHistory,
              resolution.effectiveProjectPath
            ),
          }
        : config;
    const sessionIds = await this.discoverSessionIds(
      teamName,
      resolution.projectDir,
      resolution.projectId,
      resolvedConfig,
      options
    );
    const value = {
      projectDir: resolution.projectDir,
      projectId: resolution.projectId,
      config: resolvedConfig,
      sessionIds,
    };
    this.contextCache.set(cacheKey, {
      value,
      expiresAt: Date.now() + SESSION_DISCOVERY_CACHE_TTL,
    });
    return value;
  }

  private async resolveProjectDirectory(
    teamName: string,
    config: TeamConfig
  ): Promise<{ projectDir: string; projectId: string; effectiveProjectPath?: string } | null> {
    const sessionIds = collectKnownSessionIds(config);
    const pathCandidates = this.collectProjectPathCandidates(config);
    const currentCandidate = pathCandidates[0] ?? null;
    if (sessionIds.length === 0) {
      return this.buildFallbackResolution(teamName, pathCandidates);
    }

    const rankBySessionId = new Map(sessionIds.map((sessionId, index) => [sessionId, index]));
    const getMatchRank = (match: { matchedSessionId: string } | null): number =>
      match
        ? (rankBySessionId.get(match.matchedSessionId) ?? Number.POSITIVE_INFINITY)
        : Number.POSITIVE_INFINITY;

    const toResolution = (
      match: Pick<ProjectDirCandidate, 'projectDir' | 'projectId'> & { projectPath?: string }
    ): { projectDir: string; projectId: string; effectiveProjectPath?: string } => ({
      projectDir: match.projectDir,
      projectId: match.projectId,
      ...(match.projectPath ? { effectiveProjectPath: match.projectPath } : {}),
    });

    let currentMatch: SessionProjectMatch | null = null;
    if (currentCandidate) {
      const resolvedCurrentMatch = await this.findMatchInProjectPathCandidate(
        currentCandidate,
        sessionIds
      );
      if (resolvedCurrentMatch && getMatchRank(resolvedCurrentMatch) === 0) {
        return toResolution(resolvedCurrentMatch);
      }
      if (resolvedCurrentMatch) {
        currentMatch = resolvedCurrentMatch;
      }
    }

    const configuredMatches =
      pathCandidates.length > 1
        ? await this.findMatchesInProjectPathCandidates(pathCandidates.slice(1), sessionIds)
        : [];
    const scannedMatches = await this.findMatchesByScanningProjects(sessionIds);

    const candidateMatchesByProjectDir = new Map<
      string,
      SessionProjectMatch | ScannedSessionProjectMatch
    >();
    for (const match of configuredMatches) {
      if (match.projectDir === currentMatch?.projectDir) {
        continue;
      }
      candidateMatchesByProjectDir.set(match.projectDir, match);
    }
    for (const match of scannedMatches) {
      if (match.projectDir === currentMatch?.projectDir) {
        continue;
      }
      if (!candidateMatchesByProjectDir.has(match.projectDir)) {
        candidateMatchesByProjectDir.set(match.projectDir, match);
      }
    }

    const alternateMatches = [...candidateMatchesByProjectDir.values()];
    const bestAlternateRank = alternateMatches.reduce(
      (best, match) => Math.min(best, getMatchRank(match)),
      Number.POSITIVE_INFINITY
    );
    const currentRank = getMatchRank(currentMatch);

    if (currentMatch && currentRank <= bestAlternateRank) {
      return toResolution(currentMatch);
    }

    if (bestAlternateRank !== Number.POSITIVE_INFINITY) {
      const bestAlternates = alternateMatches.filter(
        (match) => getMatchRank(match) === bestAlternateRank
      );
      if (bestAlternates.length === 1) {
        const winner = bestAlternates[0];
        if (winner.projectPath) {
          await this.persistResolvedProjectPath(teamName, config, winner.projectPath);
        }
        return toResolution(winner);
      }
      logger.warn(
        `[${teamName}] Transcript project resolution ambiguous across exact-session candidates; keeping current path`
      );
      return currentMatch
        ? toResolution(currentMatch)
        : this.buildFallbackResolution(teamName, pathCandidates);
    }

    if (currentMatch) {
      return toResolution(currentMatch);
    }

    return this.buildFallbackResolution(teamName, pathCandidates);
  }

  private async buildFallbackResolution(
    teamName: string,
    candidates: readonly ProjectPathCandidate[]
  ): Promise<{ projectDir: string; projectId: string; effectiveProjectPath?: string } | null> {
    let firstResolution: {
      projectDir: string;
      projectId: string;
      effectiveProjectPath?: string;
    } | null = null;
    let firstExistingResolution: {
      projectDir: string;
      projectId: string;
      effectiveProjectPath?: string;
    } | null = null;

    for (const candidate of candidates) {
      for (const dirCandidate of this.buildProjectDirCandidates(candidate.projectPath)) {
        const resolution = {
          projectDir: dirCandidate.projectDir,
          projectId: dirCandidate.projectId,
          effectiveProjectPath: candidate.projectPath,
        };
        if (!firstResolution) {
          firstResolution = resolution;
        }
        if (!(await this.projectDirExists(dirCandidate.projectDir))) {
          continue;
        }
        if (!firstExistingResolution) {
          firstExistingResolution = resolution;
        }
        const teamRootSessionIds = await this.listTeamRootSessionIds(
          dirCandidate.projectDir,
          dirCandidate.projectId,
          teamName
        );
        if (teamRootSessionIds.length > 0) {
          return resolution;
        }
      }
    }

    return firstExistingResolution ?? firstResolution;
  }

  private collectProjectPathCandidates(config: TeamConfig): ProjectPathCandidate[] {
    const candidates: ProjectPathCandidate[] = [];
    const seen = new Set<string>();
    const push = (value: unknown, source: Exclude<ProjectEvidenceSource, 'projectsScan'>): void => {
      const normalized = normalizeProjectPathCandidate(value);
      if (!normalized || seen.has(normalized)) {
        return;
      }
      seen.add(normalized);
      candidates.push({ projectPath: normalized, source });
    };

    push(config.projectPath, 'projectPath');

    if (Array.isArray(config.projectPathHistory)) {
      for (let index = config.projectPathHistory.length - 1; index >= 0; index -= 1) {
        push(config.projectPathHistory[index], 'projectPathHistory');
      }
    }

    const leadCwd = (config.members ?? []).find((member) => isLeadMember(member))?.cwd;
    push(leadCwd, 'leadCwd');

    const distinctMemberCwds = Array.from(
      new Set(
        (config.members ?? [])
          .map((member) => normalizeProjectPathCandidate(member.cwd))
          .filter((cwd): cwd is string => Boolean(cwd))
      )
    );
    if (distinctMemberCwds.length === 1) {
      push(distinctMemberCwds[0], 'memberCwd');
    }

    return candidates;
  }

  private collectLiveProjectPathCandidates(
    config: TeamConfig,
    extraCandidates: readonly unknown[]
  ): string[] {
    const candidates: string[] = [];
    const seen = new Set<string>();
    const push = (value: unknown): void => {
      const normalized = normalizeProjectPathCandidate(value);
      if (!normalized || seen.has(normalized)) {
        return;
      }
      seen.add(normalized);
      candidates.push(normalized);
    };

    push(config.projectPath);

    const history = Array.isArray(config.projectPathHistory) ? config.projectPathHistory : [];
    for (let index = history.length - 1; index >= Math.max(0, history.length - 5); index -= 1) {
      push(history[index]);
    }

    push((config.members ?? []).find((member) => isLeadMember(member))?.cwd);

    const distinctMemberCwds = new Set(
      (config.members ?? [])
        .map((member) => normalizeProjectPathCandidate(member.cwd))
        .filter((cwd): cwd is string => Boolean(cwd))
    );
    if (distinctMemberCwds.size === 1) {
      push([...distinctMemberCwds][0]);
    }

    for (const candidate of extraCandidates.slice(0, 64)) {
      push(candidate);
    }

    return candidates;
  }

  private buildProjectDirCandidates(projectPath: string): ProjectDirCandidate[] {
    const normalizedProjectPath = trimTrailingSlashes(projectPath);
    const projectId = extractBaseDir(encodePath(normalizedProjectPath));
    const baseCandidates = [
      { projectDir: path.join(getProjectsBasePath(), projectId), projectId },
      ...(projectId.includes('_')
        ? [
            {
              projectDir: path.join(getProjectsBasePath(), projectId.replace(/_/g, '-')),
              projectId: projectId.replace(/_/g, '-'),
            },
          ]
        : []),
    ];

    const seen = new Set<string>();
    return baseCandidates
      .filter((candidate) => {
        if (seen.has(candidate.projectDir)) {
          return false;
        }
        seen.add(candidate.projectDir);
        return true;
      })
      .map((candidate) => ({
        projectPath: normalizedProjectPath,
        projectDir: candidate.projectDir,
        projectId: candidate.projectId,
        source: 'projectPath' as const,
      }));
  }

  private async resolveLiveProjectDirectoryFromCandidates(
    candidates: readonly string[]
  ): Promise<{ projectDir: string; projectId: string; effectiveProjectPath: string } | null> {
    let firstResolution: {
      projectDir: string;
      projectId: string;
      effectiveProjectPath: string;
    } | null = null;

    for (const projectPath of candidates) {
      for (const dirCandidate of this.buildProjectDirCandidates(projectPath)) {
        const resolution = {
          projectDir: dirCandidate.projectDir,
          projectId: dirCandidate.projectId,
          effectiveProjectPath: projectPath,
        };
        firstResolution ??= resolution;
        if (await this.projectDirExists(dirCandidate.projectDir)) {
          return resolution;
        }
      }
    }

    return null;
  }

  private async findMatchInProjectPathCandidate(
    candidate: ProjectPathCandidate,
    sessionIds: string[]
  ): Promise<SessionProjectMatch | null> {
    const rankBySessionId = new Map(sessionIds.map((sessionId, index) => [sessionId, index]));
    let bestMatch: SessionProjectMatch | null = null;

    for (const projectCandidate of this.buildProjectDirCandidates(candidate.projectPath)) {
      const matchedSessionId = await this.findMatchingSessionId(
        projectCandidate.projectDir,
        sessionIds
      );
      if (!matchedSessionId) {
        continue;
      }
      const match = {
        ...projectCandidate,
        source: candidate.source,
        matchedSessionId,
      };
      const matchRank = rankBySessionId.get(match.matchedSessionId) ?? Number.POSITIVE_INFINITY;
      const bestRank = bestMatch
        ? (rankBySessionId.get(bestMatch.matchedSessionId) ?? Number.POSITIVE_INFINITY)
        : Number.POSITIVE_INFINITY;
      if (!bestMatch || matchRank < bestRank) {
        bestMatch = match;
      }
      if (matchRank === 0) {
        break;
      }
    }
    return bestMatch;
  }

  private async findMatchesInProjectPathCandidates(
    candidates: ProjectPathCandidate[],
    sessionIds: string[]
  ): Promise<SessionProjectMatch[]> {
    const matches: SessionProjectMatch[] = [];
    const seenProjectDirs = new Set<string>();
    for (const candidate of candidates) {
      const match = await this.findMatchInProjectPathCandidate(candidate, sessionIds);
      if (!match || seenProjectDirs.has(match.projectDir)) {
        continue;
      }
      seenProjectDirs.add(match.projectDir);
      matches.push(match);
    }
    return matches;
  }

  private async findMatchingSessionId(
    projectDir: string,
    sessionIds: string[]
  ): Promise<string | null> {
    for (const sessionId of sessionIds) {
      try {
        const stat = await fs.stat(path.join(projectDir, `${sessionId}.jsonl`));
        if (stat.isFile()) {
          return sessionId;
        }
      } catch {
        // continue
      }
    }
    return null;
  }

  private async findMatchesByScanningProjects(
    sessionIds: string[]
  ): Promise<ScannedSessionProjectMatch[]> {
    let projectEntries: Dirent[];
    try {
      projectEntries = await fs.readdir(getProjectsBasePath(), { withFileTypes: true });
    } catch {
      return [];
    }

    const directories = projectEntries.filter((entry) => entry.isDirectory());
    const matches: ScannedSessionProjectMatch[] = [];
    let nextIndex = 0;

    const worker = async (): Promise<void> => {
      while (nextIndex < directories.length) {
        const index = nextIndex++;
        const entry = directories[index];
        const projectDir = path.join(getProjectsBasePath(), entry.name);
        const matchedSessionId = await this.findMatchingSessionId(projectDir, sessionIds);
        if (!matchedSessionId) {
          continue;
        }
        const jsonlPath = path.join(projectDir, `${matchedSessionId}.jsonl`);
        const cwd = await extractCwd(jsonlPath);
        matches.push({
          projectPath: cwd ?? undefined,
          projectDir,
          projectId: entry.name,
          source: 'projectsScan',
          matchedSessionId,
        });
      }
    };

    await Promise.all(
      Array.from({ length: Math.min(ROOT_DISCOVERY_CONCURRENCY, directories.length) }, () =>
        worker()
      )
    );

    const deduped = new Map<string, ScannedSessionProjectMatch>();
    for (const match of matches) {
      if (!deduped.has(match.projectDir)) {
        deduped.set(match.projectDir, match);
      }
    }
    return [...deduped.values()];
  }

  private async persistResolvedProjectPath(
    teamName: string,
    config: TeamConfig,
    nextProjectPath: string
  ): Promise<void> {
    const normalizedNextPath = normalizeProjectPathCandidate(nextProjectPath);
    if (!normalizedNextPath) {
      return;
    }

    const currentProjectPath = normalizeProjectPathCandidate(config.projectPath);
    if (currentProjectPath === normalizedNextPath) {
      return;
    }

    const configPath = path.join(getTeamsBasePath(), teamName, 'config.json');
    try {
      const raw = await fs.readFile(configPath, 'utf8');
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const rawProjectPath =
        normalizeProjectPathCandidate(parsed.projectPath) ?? currentProjectPath ?? null;

      parsed.projectPath = normalizedNextPath;

      parsed.projectPathHistory = this.buildRepairedProjectPathHistory(
        rawProjectPath,
        parsed.projectPathHistory,
        normalizedNextPath
      );
      await atomicWriteAsync(configPath, JSON.stringify(parsed, null, 2));
      TeamConfigReader.invalidateTeam(teamName);
      logger.info(
        `[${teamName}] Repaired transcript projectPath via exact session match: ${normalizedNextPath}`
      );
    } catch (error) {
      logger.warn(
        `[${teamName}] Failed to persist repaired transcript projectPath: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  private async discoverSessionIds(
    teamName: string,
    projectDir: string,
    projectId: string,
    config: TeamConfig,
    options?: TeamTranscriptProjectContextOptions
  ): Promise<string[]> {
    const knownSessionIds = collectKnownSessionIds(config);
    const includeTeamSubagentSessionDiscovery =
      options?.includeTeamSubagentSessionDiscovery !== false;
    const rootMtimeSinceMs = includeTeamSubagentSessionDiscovery
      ? null
      : teamLifecycleMtimeCutoffMs(config);
    const [teamRootSessionIds, teamSubagentSessionIds] = await Promise.all([
      this.listTeamRootSessionIds(projectDir, projectId, teamName, rootMtimeSinceMs),
      includeTeamSubagentSessionDiscovery
        ? this.listTeamSubagentSessionIds(projectDir, teamName)
        : Promise.resolve([]),
    ]);

    const orderedSessionIds: string[] = [];
    const seen = new Set<string>();
    const push = (sessionId: string): void => {
      if (seen.has(sessionId)) {
        return;
      }
      seen.add(sessionId);
      orderedSessionIds.push(sessionId);
    };

    for (const sessionId of knownSessionIds) {
      push(sessionId);
    }
    for (const sessionId of [...teamRootSessionIds, ...teamSubagentSessionIds].sort((left, right) =>
      left.localeCompare(right)
    )) {
      push(sessionId);
    }

    return orderedSessionIds;
  }

  private buildRepairedProjectPathHistory(
    currentProjectPath: unknown,
    rawProjectPathHistory: unknown,
    nextProjectPath: string
  ): string[] {
    const normalizedNextPath = normalizeProjectPathCandidate(nextProjectPath);
    const history: string[] = [];
    const seen = new Set<string>();
    const pushHistory = (value: unknown): void => {
      const normalized = normalizeProjectPathCandidate(value);
      if (!normalized || normalized === normalizedNextPath || seen.has(normalized)) {
        return;
      }
      seen.add(normalized);
      history.push(normalized);
    };

    if (Array.isArray(rawProjectPathHistory)) {
      for (const value of rawProjectPathHistory) {
        pushHistory(value);
      }
    }
    pushHistory(currentProjectPath);

    return history.slice(-500);
  }

  private async projectDirExists(projectDir: string): Promise<boolean> {
    try {
      const stat = await fs.stat(projectDir);
      return stat.isDirectory();
    } catch {
      return false;
    }
  }

  private async readProjectDirEntries(projectDir: string): Promise<Dirent[] | null> {
    try {
      return await fs.readdir(projectDir, { withFileTypes: true });
    } catch {
      logger.debug(`Cannot read transcript project dir: ${projectDir}`);
      return null;
    }
  }

  private async listTeamSubagentSessionIds(
    projectDir: string,
    teamName: string
  ): Promise<string[]> {
    const dirEntries = await this.readProjectDirEntries(projectDir);
    if (!dirEntries) {
      return [];
    }

    const sessionDirEntries = dirEntries.filter(
      (entry) => entry.isDirectory() && isSessionDirectoryName(entry.name)
    );
    const discovered = new Set<string>();
    let nextIndex = 0;

    const scanNextSessionDir = async (): Promise<void> => {
      while (nextIndex < sessionDirEntries.length) {
        const entry = sessionDirEntries[nextIndex++];
        const subagentsDir = path.join(projectDir, entry.name, 'subagents');
        let subagentEntries: Dirent[];
        try {
          subagentEntries = await fs.readdir(subagentsDir, { withFileTypes: true });
        } catch {
          continue;
        }

        for (const subagentEntry of subagentEntries) {
          if (!subagentEntry.isFile()) {
            continue;
          }
          if (!subagentEntry.name.endsWith('.jsonl')) {
            continue;
          }
          if (!subagentEntry.name.startsWith('agent-')) {
            continue;
          }
          if (subagentEntry.name.startsWith('agent-acompact')) {
            continue;
          }

          const filePath = path.join(subagentsDir, subagentEntry.name);
          if (await this.fileBelongsToTeam(filePath, teamName)) {
            discovered.add(entry.name);
            break;
          }
        }
      }
    };

    await Promise.all(
      Array.from({ length: Math.min(ROOT_DISCOVERY_CONCURRENCY, sessionDirEntries.length) }, () =>
        scanNextSessionDir()
      )
    );

    return [...discovered];
  }

  private async collectRootJsonlSessionIds(
    rootJsonlEntries: Dirent[],
    projectDir: string,
    projectId: string,
    teamName: string,
    mtimeSinceMs?: number | null
  ): Promise<string[]> {
    const discovered = new Set<string>();
    const rootFileNames = new Set(rootJsonlEntries.map((entry) => entry.name));
    const indexEnabled = this.isPersistentAffinityIndexEnabled();
    const affinityIndex = indexEnabled
      ? await this.loadTeamTranscriptAffinityIndex(teamName, projectId)
      : null;
    const shouldPruneAffinityIndex = Boolean(
      affinityIndex &&
      Object.keys(affinityIndex.entries).some((fileName) => !rootFileNames.has(fileName))
    );
    const pendingIndexEntries: PersistedTeamTranscriptAffinityEntry[] = [];
    let nextIndex = 0;

    const scanNextRootEntry = async (): Promise<void> => {
      while (nextIndex < rootJsonlEntries.length) {
        const entry = rootJsonlEntries[nextIndex++];
        const filePath = path.join(projectDir, entry.name);
        let fileStat: TeamTranscriptFileStat;
        try {
          fileStat = await fs.stat(filePath);
        } catch {
          continue;
        }
        if (!fileStat.isFile() || (mtimeSinceMs != null && fileStat.mtimeMs < mtimeSinceMs)) {
          continue;
        }

        const indexedBelongsToTeam = indexEnabled
          ? this.decideTeamAffinityFromIndex(affinityIndex?.entries[entry.name], fileStat)
          : null;
        if (indexedBelongsToTeam !== null) {
          if (indexedBelongsToTeam) {
            discovered.add(entry.name.slice(0, -'.jsonl'.length));
          }
          continue;
        }

        const inspection = await this.inspectFileTeamAffinity(filePath, teamName, fileStat);
        if (inspection.belongsToTeam) {
          discovered.add(entry.name.slice(0, -'.jsonl'.length));
        }
        if (inspection.indexable) {
          const indexEntry = this.buildTeamAffinityIndexEntry(entry.name, fileStat, inspection);
          if (indexEntry) {
            pendingIndexEntries.push(indexEntry);
          }
        }
      }
    };

    await Promise.all(
      Array.from({ length: Math.min(ROOT_DISCOVERY_CONCURRENCY, rootJsonlEntries.length) }, () =>
        scanNextRootEntry()
      )
    );

    if (indexEnabled && (pendingIndexEntries.length > 0 || shouldPruneAffinityIndex)) {
      await this.affinityIndexStore
        .upsertProjectEntries({
          teamName,
          projectId,
          projectDir,
          rootFileNames,
          entries: pendingIndexEntries,
        })
        .catch((error) => {
          logger.debug(`Failed to write transcript affinity index: ${String(error)}`);
        });
    }

    return [...discovered];
  }

  private async listTeamRootSessionIds(
    projectDir: string,
    projectId: string,
    teamName: string,
    mtimeSinceMs?: number | null
  ): Promise<string[]> {
    const dirEntries = await this.readProjectDirEntries(projectDir);
    if (!dirEntries) {
      return [];
    }

    const rootJsonlEntries = dirEntries.filter(
      (entry) => entry.isFile() && entry.name.endsWith('.jsonl')
    );
    return this.collectRootJsonlSessionIds(
      rootJsonlEntries,
      projectDir,
      projectId,
      teamName,
      mtimeSinceMs
    );
  }

  private async fileBelongsToTeam(
    filePath: string,
    teamName: string,
    precomputedStat?: TeamTranscriptFileStat
  ): Promise<boolean> {
    return (await this.inspectFileTeamAffinity(filePath, teamName, precomputedStat)).belongsToTeam;
  }

  private async inspectFileTeamAffinity(
    filePath: string,
    teamName: string,
    precomputedStat?: TeamTranscriptFileStat
  ): Promise<TeamAffinityInspectionResult> {
    const emptyResult: TeamAffinityInspectionResult = {
      belongsToTeam: false,
      inspectedLineCount: 0,
      matchSource: 'none',
      headWindowFull: false,
      indexable: false,
    };
    const normalizedTeam = teamName.trim().toLowerCase();
    if (!normalizedTeam) {
      return emptyResult;
    }

    // Reuse the caller's stat when it already statted this exact file (the mtime-window
    // filter in collectRootJsonlSessionIds does). On the live resolution path this drops
    // a second fs.stat of the same file per entry, every poll — and using a single stat
    // snapshot is also more consistent than two reads that could straddle a write.
    let fileStat: TeamTranscriptFileStat;
    if (precomputedStat) {
      fileStat = precomputedStat;
    } else {
      try {
        fileStat = await fs.stat(filePath);
      } catch {
        return emptyResult;
      }
    }

    if (!fileStat.isFile()) {
      return emptyResult;
    }

    const cacheKey = this.buildTeamAffinityFileCacheKey(filePath, normalizedTeam);
    const cached = this.teamAffinityFileCache.get(cacheKey);
    if (cached) {
      if (this.teamTranscriptFileSignaturesMatch(cached, fileStat)) {
        return {
          belongsToTeam: cached.belongsToTeam,
          inspectedLineCount: 0,
          matchSource: 'none',
          headWindowFull: cached.headWindowFull,
          indexable: false,
        };
      }
      // A positive affinity is decided by early "head" lines that persist as an
      // append-only transcript grows, so a `true` result stays valid while the file
      // only grows (size >= cached). This avoids re-streaming the team's own
      // continuously-growing transcripts on every bootstrap poll. A `false` result
      // is still re-checked on any change, since a short file may later grow head
      // lines that mention the team; a shrink (rewrite/truncate) also forces a re-scan.
      if (
        cached.belongsToTeam &&
        fileStat.size >= cached.size &&
        (await this.isCachedTeamAffinityHeadCurrent(filePath, cached))
      ) {
        return {
          belongsToTeam: true,
          inspectedLineCount: 0,
          matchSource: 'none',
          headWindowFull: cached.headWindowFull,
          indexable: false,
        };
      }
      // A `false` decided from a FULL head window is durable while the file only
      // grows: the first TEAM_AFFINITY_SCAN_LINES lines of an append-only transcript
      // are immutable, so growth cannot introduce a team mention inside the inspected
      // window. A shrink/rewrite makes size < cached.size and falls through to a
      // re-scan below, identically to the positive path. This is the main launch win:
      // non-matching transcripts in the project dir are no longer re-streamed +
      // re-parsed on every bootstrap poll.
      if (
        !cached.belongsToTeam &&
        cached.headWindowFull &&
        fileStat.size >= cached.size &&
        (await this.isCachedTeamAffinityHeadCurrent(filePath, cached))
      ) {
        return {
          belongsToTeam: false,
          inspectedLineCount: 0,
          matchSource: 'none',
          headWindowFull: true,
          indexable: false,
        };
      }
    }

    const headMetadata = await this.getTeamAffinityHeadMetadata(filePath, fileStat);
    if (!headMetadata) {
      return emptyResult;
    }
    const evaluation = this.evaluateTeamAffinityHeadMetadata(headMetadata, normalizedTeam);
    const headWindowFull = evaluation.inspectedLineCount >= TEAM_AFFINITY_SCAN_LINES;

    this.setTeamAffinityFileCacheEntry(cacheKey, {
      mtimeMs: fileStat.mtimeMs,
      size: fileStat.size,
      ...(fileStat.ctimeMs != null && Number.isFinite(fileStat.ctimeMs)
        ? { ctimeMs: fileStat.ctimeMs }
        : {}),
      belongsToTeam: evaluation.belongsToTeam,
      inspectedLineCount: headMetadata.inspectedLineCount,
      headFingerprint: headMetadata.headFingerprint,
      headWindowFull,
    });
    return {
      ...evaluation,
      headWindowFull,
      indexable: true,
    };
  }

  private evaluateTeamAffinityHeadMetadata(
    metadata: TeamAffinityHeadMetadataCacheEntry,
    normalizedTeam: string
  ): TeamAffinityEvaluation {
    let inspectedLineCount = 0;
    for (const line of metadata.lines) {
      inspectedLineCount += 1;
      if (line.nestedTeamNames.has(normalizedTeam)) {
        return { belongsToTeam: true, inspectedLineCount, matchSource: 'nested_team_name' };
      }
      if (
        line.normalizedTextContent &&
        lineMentionsNormalizedTeam(line.normalizedTextContent, normalizedTeam)
      ) {
        return { belongsToTeam: true, inspectedLineCount, matchSource: 'text_team_mention' };
      }
    }
    return {
      belongsToTeam: false,
      inspectedLineCount: metadata.inspectedLineCount,
      matchSource: 'none',
    };
  }

  private isPersistentAffinityIndexEnabled(): boolean {
    return process.env.CLAUDE_TEAM_TRANSCRIPT_AFFINITY_INDEX !== '0';
  }

  private async loadTeamTranscriptAffinityIndex(
    teamName: string,
    projectId: string
  ): Promise<PersistedTeamTranscriptAffinityIndex | null> {
    try {
      return await this.affinityIndexStore.loadProject(teamName, projectId);
    } catch (error) {
      logger.debug(`Failed to load transcript affinity index: ${String(error)}`);
      return null;
    }
  }

  private decideTeamAffinityFromIndex(
    entry: PersistedTeamTranscriptAffinityEntry | undefined,
    fileStat: TeamTranscriptFileStat
  ): boolean | null {
    if (!entry) {
      return null;
    }
    if (!this.teamTranscriptFileSignaturesMatch(entry.signature, fileStat)) {
      return null;
    }
    return entry.verdict === 'belongs';
  }

  private teamTranscriptFileSignaturesMatch(
    cached: { size: number; mtimeMs: number; ctimeMs?: number },
    fileStat: { size: number; mtimeMs: number; ctimeMs?: number }
  ): boolean {
    if (cached.size !== fileStat.size || cached.mtimeMs !== fileStat.mtimeMs) {
      return false;
    }
    const cachedCtimeMs =
      cached.ctimeMs != null && Number.isFinite(cached.ctimeMs) ? cached.ctimeMs : null;
    const currentCtimeMs =
      fileStat.ctimeMs != null && Number.isFinite(fileStat.ctimeMs) ? fileStat.ctimeMs : null;
    if (cachedCtimeMs !== null || currentCtimeMs !== null) {
      return cachedCtimeMs !== null && currentCtimeMs !== null && cachedCtimeMs === currentCtimeMs;
    }
    return true;
  }

  private buildTeamAffinityIndexEntry(
    fileName: string,
    fileStat: TeamTranscriptFileStat,
    inspection: TeamAffinityInspectionResult
  ): PersistedTeamTranscriptAffinityEntry | null {
    if (
      fileName.length <= '.jsonl'.length ||
      !fileName.endsWith('.jsonl') ||
      fileName.includes('/') ||
      fileName.includes('\\')
    ) {
      return null;
    }

    const sessionId = fileName.slice(0, -'.jsonl'.length);
    const signature: TeamTranscriptAffinityFileSignature = {
      size: fileStat.size,
      mtimeMs: fileStat.mtimeMs,
      ...(fileStat.ctimeMs != null && Number.isFinite(fileStat.ctimeMs)
        ? { ctimeMs: fileStat.ctimeMs }
        : {}),
    };

    return {
      fileName,
      sessionId,
      signature,
      verdict: inspection.belongsToTeam ? 'belongs' : 'does_not_belong',
      headWindowFull: inspection.headWindowFull,
      inspectedLineCount: inspection.inspectedLineCount,
      matchSource: inspection.matchSource,
      writtenAt: new Date().toISOString(),
    };
  }

  private async isCachedTeamAffinityHeadCurrent(
    filePath: string,
    cached: TeamAffinityFileCacheEntry
  ): Promise<boolean> {
    if (cached.inspectedLineCount <= 0) {
      return false;
    }

    const fingerprint = createHash('sha256');
    let inspectedLineCount = 0;
    const inspectHeadLine = (rawLine: string): boolean => {
      const trimmed = rawLine.trim();
      if (!trimmed) {
        return false;
      }
      inspectedLineCount += 1;
      fingerprint.update(trimmed);
      fingerprint.update('\n');
      return inspectedLineCount >= cached.inspectedLineCount;
    };

    let handle: fs.FileHandle | null = null;
    try {
      handle = await fs.open(filePath, 'r');
      const decoder = new StringDecoder('utf8');
      const chunk = Buffer.allocUnsafe(TEAM_AFFINITY_READ_CHUNK_BYTES);
      let pending = '';
      let position = 0;
      let stop = false;
      while (!stop) {
        const { bytesRead } = await handle.read(chunk, 0, chunk.length, position);
        if (bytesRead <= 0) {
          pending += decoder.end();
          if (pending.length > 0) {
            inspectHeadLine(pending);
          }
          break;
        }
        position += bytesRead;
        pending += decoder.write(chunk.subarray(0, bytesRead));
        let newlineIndex = pending.indexOf('\n');
        while (newlineIndex !== -1) {
          const line = pending.slice(0, newlineIndex);
          pending = pending.slice(newlineIndex + 1);
          if (inspectHeadLine(line)) {
            stop = true;
            break;
          }
          newlineIndex = pending.indexOf('\n');
        }
      }
    } catch {
      return false;
    } finally {
      await handle?.close().catch(() => undefined);
    }

    return (
      inspectedLineCount === cached.inspectedLineCount &&
      fingerprint.digest('hex') === cached.headFingerprint
    );
  }

  private async getTeamAffinityHeadMetadata(
    filePath: string,
    fileStat: { mtimeMs: number; size: number; ctimeMs?: number }
  ): Promise<TeamAffinityHeadMetadataCacheEntry | null> {
    const cached = this.teamAffinityHeadMetadataCache.get(filePath);
    if (cached && this.teamTranscriptFileSignaturesMatch(cached, fileStat)) {
      return cached;
    }
    if (cached) {
      this.teamAffinityHeadMetadataCache.delete(filePath);
    }

    const lines: TeamAffinityHeadLineMetadata[] = [];
    const fingerprint = createHash('sha256');
    let inspectedLineCount = 0;
    const inspectHeadLine = (rawLine: string): boolean => {
      const trimmed = rawLine.trim();
      if (!trimmed) {
        return false;
      }
      inspectedLineCount += 1;
      fingerprint.update(trimmed);
      fingerprint.update('\n');
      lines.push(parseTeamAffinityHeadLine(trimmed));
      return inspectedLineCount >= TEAM_AFFINITY_SCAN_LINES;
    };

    let handle: fs.FileHandle | null = null;
    try {
      handle = await fs.open(filePath, 'r');
      const decoder = new StringDecoder('utf8');
      const chunk = Buffer.allocUnsafe(TEAM_AFFINITY_READ_CHUNK_BYTES);
      let pending = '';
      let position = 0;
      let stop = false;
      while (!stop) {
        const { bytesRead } = await handle.read(chunk, 0, chunk.length, position);
        if (bytesRead <= 0) {
          // EOF: flush the decoder and honor a final line with no trailing newline.
          pending += decoder.end();
          if (pending.length > 0) {
            inspectHeadLine(pending);
          }
          break;
        }
        position += bytesRead;
        pending += decoder.write(chunk.subarray(0, bytesRead));
        let newlineIndex = pending.indexOf('\n');
        while (newlineIndex !== -1) {
          const line = pending.slice(0, newlineIndex);
          pending = pending.slice(newlineIndex + 1);
          if (inspectHeadLine(line)) {
            stop = true;
            break;
          }
          newlineIndex = pending.indexOf('\n');
        }
      }
    } catch {
      return null;
    } finally {
      await handle?.close().catch(() => undefined);
    }

    const entry = {
      mtimeMs: fileStat.mtimeMs,
      size: fileStat.size,
      ...(fileStat.ctimeMs != null && Number.isFinite(fileStat.ctimeMs)
        ? { ctimeMs: fileStat.ctimeMs }
        : {}),
      inspectedLineCount,
      headFingerprint: fingerprint.digest('hex'),
      lines,
    };
    this.setTeamAffinityHeadMetadataCacheEntry(filePath, entry);
    return entry;
  }

  private buildTeamAffinityFileCacheKey(filePath: string, normalizedTeam: string): string {
    return `${normalizedTeam}\0${filePath}`;
  }

  private setTeamAffinityFileCacheEntry(cacheKey: string, entry: TeamAffinityFileCacheEntry): void {
    if (
      !this.teamAffinityFileCache.has(cacheKey) &&
      this.teamAffinityFileCache.size >= TEAM_AFFINITY_FILE_CACHE_MAX_ENTRIES
    ) {
      const oldestKey = this.teamAffinityFileCache.keys().next().value;
      if (oldestKey) {
        this.teamAffinityFileCache.delete(oldestKey);
      }
    }
    this.teamAffinityFileCache.set(cacheKey, entry);
  }

  private setTeamAffinityHeadMetadataCacheEntry(
    filePath: string,
    entry: TeamAffinityHeadMetadataCacheEntry
  ): void {
    if (
      !this.teamAffinityHeadMetadataCache.has(filePath) &&
      this.teamAffinityHeadMetadataCache.size >= TEAM_AFFINITY_HEAD_METADATA_CACHE_MAX_ENTRIES
    ) {
      const oldestKey = this.teamAffinityHeadMetadataCache.keys().next().value;
      if (oldestKey) {
        this.teamAffinityHeadMetadataCache.delete(oldestKey);
      }
    }
    this.teamAffinityHeadMetadataCache.set(filePath, entry);
  }
}
