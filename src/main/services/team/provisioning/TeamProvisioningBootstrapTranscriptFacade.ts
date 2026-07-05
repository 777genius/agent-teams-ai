import { TeamMemberLogsFinder } from '../TeamMemberLogsFinder';
import { TeamTranscriptProjectResolver } from '../TeamTranscriptProjectResolver';

import {
  type BootstrapTranscriptOutcome,
  type ParsedBootstrapTranscriptTailCacheEntry,
} from './TeamProvisioningBootstrapTranscript';
import {
  createTeamProvisioningBootstrapTranscriptOutcomePorts,
  type TeamProvisioningBootstrapTranscriptOutcomePortDependencies,
  type TeamProvisioningBootstrapTranscriptOutcomePorts,
} from './TeamProvisioningBootstrapTranscriptOutcomePortsFactory';
import { type RetainedClaudeLogsSnapshot } from './TeamProvisioningRetainedLogs';
import { TeamProvisioningTranscriptClaudeLogsCache } from './TeamProvisioningTranscriptClaudeLogs';

import type { TeamConfigReader } from '../TeamConfigReader';
import type { TeamInboxReader } from '../TeamInboxReader';
import type { TeamMembersMetaStore } from '../TeamMembersMetaStore';
import type { TeamConfig } from '@shared/types';

export interface TeamProvisioningBootstrapTranscriptClaudeLogsPort {
  get(teamName: string): Promise<RetainedClaudeLogsSnapshot | null>;
  invalidate(teamName: string): void;
}

export interface TeamProvisioningBootstrapTranscriptMemberLogsPort {
  findMemberLogs: TeamProvisioningBootstrapTranscriptOutcomePortDependencies['findMemberLogs'];
}

export interface TeamProvisioningBootstrapTranscriptFacadeDeps {
  nowIso(): string;
  isLookupCacheEnabled(teamName: string): boolean;
  configReader?: TeamConfigReader;
  inboxReader?: TeamInboxReader;
  membersMetaStore?: TeamMembersMetaStore;
  readConfigSnapshot(teamName: string): Promise<TeamConfig | null>;
  readMetaMembers?: TeamProvisioningBootstrapTranscriptOutcomePortDependencies['readMetaMembers'];
  memberLogsFinder?: TeamProvisioningBootstrapTranscriptMemberLogsPort;
  transcriptProjectResolver?: Pick<TeamTranscriptProjectResolver, 'getContext'>;
  persistedTranscriptClaudeLogs?: TeamProvisioningBootstrapTranscriptClaudeLogsPort;
  createBootstrapTranscriptOutcomePorts?: (
    dependencies: TeamProvisioningBootstrapTranscriptOutcomePortDependencies
  ) => TeamProvisioningBootstrapTranscriptOutcomePorts;
}

function requireBootstrapTranscriptFacadeDependency<T>(
  dependency: T | null | undefined,
  name: string
): NonNullable<T> {
  if (dependency === null || dependency === undefined) {
    throw new Error(`TeamProvisioningBootstrapTranscriptFacade requires ${name}`);
  }
  return dependency;
}

export class TeamProvisioningBootstrapTranscriptFacade {
  private memberLogsFinder: TeamProvisioningBootstrapTranscriptMemberLogsPort;
  private readonly transcriptProjectResolver: Pick<
    TeamTranscriptProjectResolver,
    'getContext'
  > | null;
  private readonly persistedTranscriptClaudeLogs: TeamProvisioningBootstrapTranscriptClaudeLogsPort;
  private readonly bootstrapTranscriptOutcomePorts: TeamProvisioningBootstrapTranscriptOutcomePorts;

  constructor(deps: TeamProvisioningBootstrapTranscriptFacadeDeps) {
    this.memberLogsFinder =
      deps.memberLogsFinder ??
      new TeamMemberLogsFinder(
        requireBootstrapTranscriptFacadeDependency(deps.configReader, 'configReader'),
        requireBootstrapTranscriptFacadeDependency(deps.inboxReader, 'inboxReader'),
        requireBootstrapTranscriptFacadeDependency(deps.membersMetaStore, 'membersMetaStore')
      );
    this.transcriptProjectResolver =
      deps.transcriptProjectResolver ??
      (deps.persistedTranscriptClaudeLogs
        ? null
        : new TeamTranscriptProjectResolver({
            getConfig: (teamName) =>
              requireBootstrapTranscriptFacadeDependency(
                deps.configReader,
                'configReader'
              ).getConfigSnapshot(teamName),
          }));
    this.persistedTranscriptClaudeLogs =
      deps.persistedTranscriptClaudeLogs ??
      new TeamProvisioningTranscriptClaudeLogsCache({
        getContext: (teamName) =>
          requireBootstrapTranscriptFacadeDependency(
            this.transcriptProjectResolver,
            'transcriptProjectResolver'
          ).getContext(teamName),
      });

    const readMetaMembers =
      deps.readMetaMembers ??
      ((teamName: string) =>
        requireBootstrapTranscriptFacadeDependency(
          deps.membersMetaStore,
          'membersMetaStore'
        ).getMembers(teamName));
    const createBootstrapTranscriptOutcomePorts =
      deps.createBootstrapTranscriptOutcomePorts ??
      createTeamProvisioningBootstrapTranscriptOutcomePorts;

    this.bootstrapTranscriptOutcomePorts = createBootstrapTranscriptOutcomePorts({
      nowIso: deps.nowIso,
      isLookupCacheEnabled: deps.isLookupCacheEnabled,
      findMemberLogs: (teamName, memberName, sinceMs) =>
        this.memberLogsFinder.findMemberLogs(teamName, memberName, sinceMs),
      readConfigSnapshot: deps.readConfigSnapshot,
      readMetaMembers,
    });
  }

  get parsedBootstrapTranscriptTailCache(): Map<string, ParsedBootstrapTranscriptTailCacheEntry> {
    return this.bootstrapTranscriptOutcomePorts.parsedBootstrapTranscriptTailCache;
  }

  getPersistedTranscriptClaudeLogs(teamName: string): Promise<RetainedClaudeLogsSnapshot | null> {
    return this.persistedTranscriptClaudeLogs.get(teamName);
  }

  invalidatePersistedTranscriptClaudeLogs(teamName: string): void {
    this.persistedTranscriptClaudeLogs.invalidate(teamName);
  }

  findBootstrapTranscriptFailureReason(
    teamName: string,
    memberName: string,
    sinceMs: number | null
  ): Promise<string | null> {
    return this.bootstrapTranscriptOutcomePorts.findBootstrapTranscriptFailureReason(
      teamName,
      memberName,
      sinceMs
    );
  }

  findBootstrapTranscriptOutcome(
    teamName: string,
    memberName: string,
    sinceMs: number | null
  ): Promise<BootstrapTranscriptOutcome | null> {
    return this.bootstrapTranscriptOutcomePorts.findBootstrapTranscriptOutcome(
      teamName,
      memberName,
      sinceMs
    );
  }

  readRecentBootstrapTranscriptOutcome(
    filePath: string,
    sinceMs: number | null,
    memberName: string,
    teamName: string,
    options: {
      allowAnonymousFailure?: boolean;
      contextMemberNames?: readonly string[];
    } = {}
  ): Promise<BootstrapTranscriptOutcome | null> {
    return this.bootstrapTranscriptOutcomePorts.readRecentBootstrapTranscriptOutcome(
      filePath,
      sinceMs,
      memberName,
      teamName,
      options
    );
  }

  readBootstrapTranscriptOutcomesInProjectRoot(
    teamName: string,
    memberName: string,
    sinceMs: number | null
  ): Promise<BootstrapTranscriptOutcome[]> {
    return this.bootstrapTranscriptOutcomePorts.readBootstrapTranscriptOutcomesInProjectRoot(
      teamName,
      memberName,
      sinceMs
    );
  }
}
