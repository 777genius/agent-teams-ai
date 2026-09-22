import {
  BOOTSTRAP_FAILURE_TAIL_BYTES,
  BOOTSTRAP_TRANSCRIPT_MTIME_SLACK_MS,
  BOOTSTRAP_TRANSCRIPT_OUTCOME_CACHE_MAX_ENTRIES,
  type BootstrapTranscriptOutcome,
  type BootstrapTranscriptOutcomeCacheEntry,
  type BootstrapTranscriptOutcomeLookupCacheEntry,
  findBootstrapTranscriptOutcome,
  getParsedBootstrapTranscriptTail,
  type ParsedBootstrapTranscriptTailCacheEntry,
  type ParsedBootstrapTranscriptTailLine,
  PERSISTED_BOOTSTRAP_TRANSCRIPT_OUTCOME_LOOKUP_CACHE_TTL_MS,
  readBootstrapTranscriptOutcomesInProjectRoot,
  readRecentBootstrapTranscriptOutcome,
} from './TeamProvisioningBootstrapTranscript';

import type { TeamConfig } from '@shared/types';

export interface TeamProvisioningBootstrapTranscriptOutcomePortDependencies {
  nowIso(): string;
  isLookupCacheEnabled(teamName: string): boolean;
  findMemberLogs(
    teamName: string,
    memberName: string,
    sinceMs: number | null
  ): Promise<readonly { filePath?: string | null }[]>;
  readConfigSnapshot(teamName: string): Promise<TeamConfig | null>;
  readMetaMembers(teamName: string): Promise<readonly { name?: unknown; cwd?: unknown }[]>;
  readRecentBootstrapTranscriptOutcome?: TeamProvisioningBootstrapTranscriptOutcomePorts['readRecentBootstrapTranscriptOutcome'];
  readBootstrapTranscriptOutcomesInProjectRoot?: TeamProvisioningBootstrapTranscriptOutcomePorts['readBootstrapTranscriptOutcomesInProjectRoot'];
}

export interface TeamProvisioningBootstrapTranscriptOutcomePorts {
  readonly parsedBootstrapTranscriptTailCache: Map<string, ParsedBootstrapTranscriptTailCacheEntry>;
  findBootstrapTranscriptFailureReason(
    teamName: string,
    memberName: string,
    sinceMs: number | null
  ): Promise<string | null>;
  findBootstrapTranscriptOutcome(
    teamName: string,
    memberName: string,
    sinceMs: number | null
  ): Promise<BootstrapTranscriptOutcome | null>;
  readRecentBootstrapTranscriptOutcome(
    filePath: string,
    sinceMs: number | null,
    memberName: string,
    teamName: string,
    options?: {
      allowAnonymousFailure?: boolean;
      contextMemberNames?: readonly string[];
    }
  ): Promise<BootstrapTranscriptOutcome | null>;
  getParsedBootstrapTranscriptTail(
    filePath: string,
    stat: { mtimeMs: number; size: number }
  ): Promise<ParsedBootstrapTranscriptTailLine[]>;
  readBootstrapTranscriptOutcomesInProjectRoot(
    teamName: string,
    memberName: string,
    sinceMs: number | null
  ): Promise<BootstrapTranscriptOutcome[]>;
}

export function createTeamProvisioningBootstrapTranscriptOutcomePorts(
  dependencies: TeamProvisioningBootstrapTranscriptOutcomePortDependencies
): TeamProvisioningBootstrapTranscriptOutcomePorts {
  const bootstrapTranscriptOutcomeCache = new Map<string, BootstrapTranscriptOutcomeCacheEntry>();
  const parsedBootstrapTranscriptTailCache = new Map<
    string,
    ParsedBootstrapTranscriptTailCacheEntry
  >();
  const bootstrapTranscriptOutcomeLookupCache = new Map<
    string,
    BootstrapTranscriptOutcomeLookupCacheEntry
  >();

  const ports: TeamProvisioningBootstrapTranscriptOutcomePorts = {
    parsedBootstrapTranscriptTailCache,

    async findBootstrapTranscriptFailureReason(teamName, memberName, sinceMs) {
      const outcome = await ports.findBootstrapTranscriptOutcome(teamName, memberName, sinceMs);
      return outcome?.kind === 'failure' ? outcome.reason : null;
    },

    findBootstrapTranscriptOutcome(teamName, memberName, sinceMs) {
      return findBootstrapTranscriptOutcome({
        teamName,
        memberName,
        sinceMs,
        lookupCache: bootstrapTranscriptOutcomeLookupCache,
        lookupCacheEnabled: dependencies.isLookupCacheEnabled(teamName),
        findMemberLogs: dependencies.findMemberLogs,
        readRecentBootstrapTranscriptOutcome:
          dependencies.readRecentBootstrapTranscriptOutcome ??
          ports.readRecentBootstrapTranscriptOutcome,
        readBootstrapTranscriptOutcomesInProjectRoot:
          dependencies.readBootstrapTranscriptOutcomesInProjectRoot ??
          ports.readBootstrapTranscriptOutcomesInProjectRoot,
        maxCacheEntries: BOOTSTRAP_TRANSCRIPT_OUTCOME_CACHE_MAX_ENTRIES,
        lookupCacheTtlMs: PERSISTED_BOOTSTRAP_TRANSCRIPT_OUTCOME_LOOKUP_CACHE_TTL_MS,
      });
    },

    readRecentBootstrapTranscriptOutcome(filePath, sinceMs, memberName, teamName, options = {}) {
      return readRecentBootstrapTranscriptOutcome({
        filePath,
        sinceMs,
        memberName,
        teamName,
        options,
        outcomeCache: bootstrapTranscriptOutcomeCache,
        getParsedBootstrapTranscriptTail: ports.getParsedBootstrapTranscriptTail,
        nowIso: dependencies.nowIso,
        maxCacheEntries: BOOTSTRAP_TRANSCRIPT_OUTCOME_CACHE_MAX_ENTRIES,
      });
    },

    getParsedBootstrapTranscriptTail(filePath, stat) {
      return getParsedBootstrapTranscriptTail({
        filePath,
        stat,
        cache: parsedBootstrapTranscriptTailCache,
        tailBytes: BOOTSTRAP_FAILURE_TAIL_BYTES,
        maxCacheEntries: BOOTSTRAP_TRANSCRIPT_OUTCOME_CACHE_MAX_ENTRIES,
      });
    },

    readBootstrapTranscriptOutcomesInProjectRoot(teamName, memberName, sinceMs) {
      return readBootstrapTranscriptOutcomesInProjectRoot({
        teamName,
        memberName,
        sinceMs,
        readConfigSnapshot: dependencies.readConfigSnapshot,
        readMetaMembers: dependencies.readMetaMembers,
        readRecentBootstrapTranscriptOutcome:
          dependencies.readRecentBootstrapTranscriptOutcome ??
          ports.readRecentBootstrapTranscriptOutcome,
        mtimeSlackMs: BOOTSTRAP_TRANSCRIPT_MTIME_SLACK_MS,
      });
    },
  };

  return ports;
}
